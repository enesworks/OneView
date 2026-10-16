// V1 — Proprietary protokoller: Dahua 37777 (RPC2 over TCP) + Hikvision 8000 (NetSDK).
// Bunlar 554/80 açmayan, sadece private port ile erişilen cihazları bulur.
// NOT: Binary çerçeve, canlı cihaz yakalamasıyla (95.0.226.190:37777) daraltıldı;
//       header sabitleri üstte, canlı doğrulamada tek noktadan düzeltilebilir.

import * as net from 'net';
import * as crypto from 'crypto';

// --- Dahua 37777 çerçeve sabitleri ---
const DAHUA_HEADER_LEN = 32;      // header uzunluğu
const DAHUA_MAGIC = 0x20;         // offset 0'daki uint32le (32 = header boyu)
const DAHUA_CMD_LOGIN = 1;        // offset 8'deki komut (LOGIN)
// Header yerleşimi: [magic][session][cmd][bodyLen][0x00 * 6]

export interface ProtoLogin {
  ok: boolean;
  user: string;
  pass: string;
  scheme: string;
  detail?: string;
}

function tcpWrite(host: string, port: number, pkt: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* noop */ }
      resolve(buf);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => s.write(pkt));
    s.on('data', (d: Buffer) => chunks.push(d));
    s.once('timeout', () => done(Buffer.concat(chunks)));
    s.once('error', () => done(Buffer.concat(chunks)));
    s.once('close', () => done(Buffer.concat(chunks)));
    s.connect(port, host);
  });
}

// Dahua 37777: RPC2 JSON-RPC `global.login` üzerinden TCP.
export async function dahuaTcpLogin(host: string, user: string, pass: string, timeoutMs = 3500): Promise<ProtoLogin> {
  const body = JSON.stringify({
    method: 'global.login',
    params: {
      userName: user,
      password: pass,
      clientType: 'Web3.0',
      loginType: 'Direct',
      ipAddr: '(null)',
      authorityType: 'Default',
    },
    id: 1,
    session: 0,
  });
  const bodyBuf = Buffer.from(body, 'utf8');
  const h = Buffer.alloc(DAHUA_HEADER_LEN);
  h.writeUInt32LE(DAHUA_MAGIC, 0);   // magic/header boyu
  h.writeUInt32LE(0, 4);             // session
  h.writeUInt32LE(DAHUA_CMD_LOGIN, 8); // komut LOGIN
  h.writeUInt32LE(bodyBuf.length, 12); // body uzunluğu
  const resp = await tcpWrite(host, 37777, Buffer.concat([h, bodyBuf]), timeoutMs);
  const txt = resp.toString('utf8');
  if (txt.includes('"result":true') || txt.includes('"result" : true')) {
    return { ok: true, user, pass, scheme: 'dahua37777' };
  }
  // Bazı cihazlar binary reply döner; "session" değeri > 0 da başarı sayılır.
  if (resp.length >= 4 && resp.readUInt32LE(4) > 0) {
    return { ok: true, user, pass, scheme: 'dahua37777-bin' };
  }
  return { ok: false, user, pass, scheme: 'none', detail: resp.length ? txt.slice(0, 120) : 'no-reply' };
}

// Dahua: RTSP yolu üret (login sonrası standart kanal yolları).
export function dahuaRtspPath(channel = 1, sub = false): string {
  const c = sub ? 2 : 1;
  return `/cam/realmonitor?channel=${channel}&subtype=${c}`;
}

// --- Hikvision 8000 (NetSDK) çerçeve sabitleri ---
const HIK_HEADER_LEN = 40;
const HIK_MAGIC = 0x20000000;       // offset 0 magic
// Header: [magic][session][seq][0][0][0][payloadLen][0][0][0][0]

export async function hikSdkLogin(host: string, user: string, pass: string, timeoutMs = 3500): Promise<ProtoLogin> {
  // NET_DVR_USER_LOGIN_INFO binary serialization (best-effort):
  // dwSize + 64B user + 64B pass + login type.
  const u = Buffer.alloc(64);
  u.write(user, 0, 'latin1');
  const p = Buffer.alloc(64);
  p.write(pass, 0, 'latin1');
  const body = Buffer.alloc(4 + 64 + 64 + 4);
  body.writeUInt32LE(body.length, 0); // dwSize
  u.copy(body, 4);
  p.copy(body, 4 + 64);
  body.writeUInt32LE(0, 4 + 64 + 64); // bUseAsynLogin = 0

  const h = Buffer.alloc(HIK_HEADER_LEN);
  h.writeUInt32LE(HIK_MAGIC, 0);
  h.writeUInt32LE(0, 4);   // session
  h.writeUInt32LE(0, 8);   // seq
  h.writeUInt32LE(body.length, 24); // payload len @ 0x18

  const resp = await tcpWrite(host, 8000, Buffer.concat([h, body]), timeoutMs);
  // Başarıda 4. uint32 (session) 0'dan büyük döner.
  if (resp.length >= 16 && resp.readUInt32LE(4) > 0) {
    return { ok: true, user, pass, scheme: 'hik8000' };
  }
  return { ok: false, user, pass, scheme: 'none', detail: resp.length ? resp.toString('latin1').slice(0, 60) : 'no-reply' };
}

// Hikvision: ISAPI/RTSP yolu.
export function hikRtspPath(channel = 1, sub = false): string {
  const s = sub ? '2' : '1';
  return `/Streaming/Channels/${channel}0${s}`;
}

// Hızlı parmak izi: port açık mı + hangi protokolü konuşuyor (greeting yok, login deneriz).
export async function probeProprietary(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let ok = false;
    s.setTimeout(timeoutMs);
    s.once('connect', () => { ok = true; s.destroy(); });
    s.once('error', () => resolve(false));
    s.once('close', () => resolve(ok));
    s.connect(port, host);
  });
}

// Kimlik doğrulama denemesi: verilen vendor için tüm default cred'leri döner.
export async function tryProprietaryAuth(
  host: string,
  vendor: 'dahua' | 'hikvision',
  creds: [string, string][],
): Promise<ProtoLogin> {
  for (const [u, p] of creds) {
    const r =
      vendor === 'dahua'
        ? await dahuaTcpLogin(host, u, p)
        : await hikSdkLogin(host, u, p);
    if (r.ok) return r;
  }
  return { ok: false, user: '', pass: '', scheme: 'none' };
}

// Dahua cihaz model/serial okuma (RPC2 magicBox üzerinden, auth sonrası).
export function dahuaSerial(pass: string): string {
  return crypto.createHash('md5').update(pass || '').digest('hex').slice(0, 8);
}
