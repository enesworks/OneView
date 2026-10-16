// V1 — Cloud ingress: Ezviz (Hikvision cloud) + Tuya IoT.
// NAT arkasındaki (internete kapalı) kameralar cloud'a OUTBOUND bağlanır;
// bu modül cloud platformuna girip cihaz listesi + stream alır.
// Ezviz: featureCode/appId kodda gömülü (pyEzviz'den çıkarıldı) → sadece
//        hesap/şifre config'de yeter, otomatik giriş + cihaz listesi + RTSP.
// Tuya: clientId/secret config'den okunur (Tuya IoT developer hesabı).

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { app } from 'electron';
import { CameraRegistry, RegisteredCamera, hashId } from './registry';

interface CloudCfg {
  ezvizAccount: string;
  ezvizPassword: string;
  ezvizCreds: string[];      // "email:password" listesi (credential stuffing)
  ezvizCredsFile: string;    // "email:password" satırları içeren dosya yolu
  tuyaClientId: string;
  tuyaClientSecret: string;
  tuyaAccount: string;
  tuyaPassword: string;
}

export function loadCloudConfig(): CloudCfg {
  const empty: CloudCfg = {
    ezvizAccount: '', ezvizPassword: '', ezvizCreds: [], ezvizCredsFile: '',
    tuyaClientId: '', tuyaClientSecret: '', tuyaAccount: '', tuyaPassword: '',
  };
  const env = {
    ezvizAccount: process.env.ONEVIEW_EZVIZ_ACCOUNT || '',
    ezvizPassword: process.env.ONEVIEW_EZVIZ_PASSWORD || '',
    ezvizCreds: process.env.ONEVIEW_EZVIZ_CREDS ? process.env.ONEVIEW_EZVIZ_CREDS.split(',') : [],
    ezvizCredsFile: process.env.ONEVIEW_EZVIZ_CREDS_FILE || '',
    tuyaClientId: process.env.ONEVIEW_TUYA_CLIENTID || '',
    tuyaClientSecret: process.env.ONEVIEW_TUYA_SECRET || '',
    tuyaAccount: process.env.ONEVIEW_TUYA_ACCOUNT || '',
    tuyaPassword: process.env.ONEVIEW_TUYA_PASSWORD || '',
  };
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return { ...empty, ...cfg, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
    }
  } catch {
    /* ignore */
  }
  return { ...empty, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
}

// Hesap listesini topla: tek hesap + config listesi + dosya satırları.
export function loadEzvizCreds(cfg: CloudCfg): [string, string][] {
  const out: [string, string][] = [];
  const push = (line: string) => {
    const s = line.trim();
    if (!s) return;
    const i = s.indexOf(':');
    if (i <= 0) return;
    const a = s.slice(0, i).trim();
    const p = s.slice(i + 1).trim();
    if (a && p) out.push([a, p]);
  };
  if (cfg.ezvizAccount && cfg.ezvizPassword) out.push([cfg.ezvizAccount, cfg.ezvizPassword]);
  for (const c of cfg.ezvizCreds || []) push(c);
  if (cfg.ezvizCredsFile) {
    try {
      const abs = path.isAbsolute(cfg.ezvizCredsFile)
        ? cfg.ezvizCredsFile
        : path.join(app.getPath('userData'), cfg.ezvizCredsFile);
      if (fs.existsSync(abs)) {
        for (const line of fs.readFileSync(abs, 'utf-8').split(/\r?\n/)) push(line);
      }
    } catch { /* ignore */ }
  }
  return out;
}

function httpsJson(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (data !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const req = (lib as typeof http).request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        rejectUnauthorized: false,
        timeout: opts.timeoutMs ?? 8000,
      } as http.RequestOptions,
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; if (b.length > 1_000_000) res.destroy(); });
        res.on('close', () => resolve({ status: res.statusCode || 0, body: b }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// --- Tuya IoT (açık platform) ---
async function tuyaToken(clientId: string, secret: string): Promise<{ token: string; uid: string } | null> {
  if (!clientId || !secret) return null;
  const ts = String(Date.now());
  const sign = crypto.createHmac('sha256', secret).update(clientId + ts).digest('hex').toUpperCase();
  const url = `https://openapi.tuyaus.com/v1.0/token?grant_type=1&client_id=${encodeURIComponent(clientId)}&timestamp=${ts}&sign=${sign}`;
  const r = await httpsJson(url);
  try {
    const j = JSON.parse(r.body);
    if (j?.result?.access_token) return { token: j.result.access_token, uid: j.result.uid || '' };
  } catch { /* noop */ }
  return null;
}

interface TuyaDev {
  id: string;
  name: string;
  online: boolean;
  ip?: string;
  model?: string;
}

async function tuyaDevices(clientId: string, secret: string): Promise<TuyaDev[]> {
  const t = await tuyaToken(clientId, secret);
  if (!t) return [];
  const r = await httpsJson(`https://openapi.tuyaus.com/v1.0/users/${t.uid}/devices?page_size=100`, {
    headers: { access_token: t.token, client_id: clientId, t: String(Date.now()) },
  });
  try {
    const j = JSON.parse(r.body);
    const list: TuyaDev[] = (j?.result?.list || []).map((d: Record<string, unknown>) => ({
      id: String(d.id || ''),
      name: String(d.name || ''),
      online: Boolean(d.online),
      ip: typeof d.ip === 'string' ? d.ip : undefined,
      model: typeof d.model === 'string' ? d.model : undefined,
    }));
    return list;
  } catch { /* noop */ }
  return [];
}

// --- Ezviz (Hikvision cloud) ---
// Gerçek API (pyEzviz'den çıkarıldı): apiieu.ezvizlife.com (EU).
// Login HMAC/secret gerektirmez; featureCode + MD5(password) + appId yeter.
const EZVIZ_FEATURE_CODE = '1fc28fa018178a1cd1c091b13b2f9f02';
const EZVIZ_APP_ID = 'ys7';
const EZVIZ_BASE = 'https://apiieu.ezvizlife.com';

function ezvizHeaders(sessionId = ''): Record<string, string> {
  return {
    featureCode: EZVIZ_FEATURE_CODE,
    clientType: '3',
    osVersion: '',
    clientVersion: '',
    customno: '1000001',
    clientNo: 'web_site',
    appId: EZVIZ_APP_ID,
    language: 'en_GB',
    sessionId,
    'User-Agent': 'okhttp/3.12.1',
  };
}

async function ezvizLogin(account: string, password: string): Promise<string | null> {
  if (!account || !password) return null;
  const body = new URLSearchParams({
    account,
    password: crypto.createHash('md5').update(password, 'utf8').digest('hex'),
    featureCode: EZVIZ_FEATURE_CODE,
    msgType: '0',
    bizType: '',
    cuName: 'SGFzc2lv',
  }).toString();
  const r = await httpsJson(`${EZVIZ_BASE}/v3/users/login/v5`, {
    method: 'POST',
    headers: { ...ezvizHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  try {
    const j = JSON.parse(r.body);
    const sid = j?.loginSession?.sessionId || j?.meta?.sessionId || '';
    if (sid) return String(sid);
  } catch { /* noop */ }
  return null;
}

interface EzvizDev {
  serial: string;
  name: string;
  status: number;
  model?: string;
  rtsp?: string;
}

async function ezvizDevices(account: string, password: string): Promise<EzvizDev[]> {
  const sessionId = await ezvizLogin(account, password);
  if (!sessionId) return [];
  const body = new URLSearchParams({ pageStart: '0', pageSize: '100' }).toString();
  const r = await httpsJson(`${EZVIZ_BASE}/v3/userdevices/v1/resources/pagelist`, {
    method: 'POST',
    headers: { ...ezvizHeaders(sessionId), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  try {
    const j = JSON.parse(r.body);
    const list: EzvizDev[] = (j?.deviceInfos || j?.list || []).map((d: Record<string, unknown>) => ({
      serial: String(d.deviceSerial || d.serial || ''),
      name: String(d.deviceName || d.name || ''),
      status: Number(d.status ?? 0),
      model: typeof d.model === 'string' ? d.model : undefined,
    }));
    return list;
  } catch { /* noop */ }
  return [];
}

// Cihazın canlı RTSP adresini al (NAT arkası için P2P; LAN'dakiler için RTSP döner).
async function ezvizRtsp(account: string, password: string, serial: string): Promise<string> {
  const sessionId = await ezvizLogin(account, password);
  if (!sessionId) return '';
  const body = new URLSearchParams({ type: '1', channelNo: '1' }).toString();
  const r = await httpsJson(`${EZVIZ_BASE}/v3/devices/${encodeURIComponent(serial)}/address`, {
    method: 'POST',
    headers: { ...ezvizHeaders(sessionId), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  try {
    const j = JSON.parse(r.body);
    return String(j?.data?.url || j?.rtsp || j?.address || '');
  } catch { /* noop */ }
  return '';
}

// Cloud taraması: cihazları registry'ye cloud kaynaklı olarak ekler.
// NAT arkası cihazların IP'si yok → serial/id üzerinden "cloud" olarak işaretlenir.
export async function runCloudScan(registry: CameraRegistry): Promise<number> {
  const cfg = loadCloudConfig();
  let added = 0;

  const tdevs = await tuyaDevices(cfg.tuyaClientId, cfg.tuyaClientSecret);
  for (const d of tdevs) {
    const id = hashId(`tuya:${d.id}`);
    if (registry.get(id)) continue;
    const cam: RegisteredCamera = {
      id,
      name: d.name || `Tuya ${d.id.slice(0, 8)}`,
      il: 'cloud',
      ilce: 'tuya',
      lat: 0,
      lon: 0,
      protocol: 'cloud',
      url: `tuya://${d.id}`,
      status: d.online ? 'online' : 'unknown',
      source: 'cloud',
      lastSeen: Date.now(),
      latencyMs: null,
    };
    registry.add(cam);
    added++;
  }

  // Ezviz: tek hesap YOK → credential stuffing. Sızdırılmış/sağlanan hesap
  // listesini sırayla dene; tutan her hesabın kameralarını çek.
  const creds = loadEzvizCreds(cfg);
  const seenSerial = new Set<string>();
  for (const [account, password] of creds) {
    const sessionId = await ezvizLogin(account, password);
    if (!sessionId) continue;
    const devs = await ezvizDevices(account, password);
    for (const d of devs) {
      if (!d.serial || seenSerial.has(d.serial)) continue;
      seenSerial.add(d.serial);
      const id = hashId(`ezviz:${d.serial}`);
      if (registry.get(id)) continue;
      const rtsp = await ezvizRtsp(account, password, d.serial);
      const cam: RegisteredCamera = {
        id,
        name: d.name || `Ezviz ${d.serial.slice(0, 8)}`,
        il: 'cloud',
        ilce: 'ezviz',
        lat: 0,
        lon: 0,
        protocol: rtsp ? 'rtsp' : 'cloud',
        url: rtsp || `ezviz://${d.serial}`,
        status: d.status === 1 ? 'online' : 'unknown',
        source: 'cloud',
        lastSeen: Date.now(),
        latencyMs: null,
      };
      registry.add(cam);
      added++;
    }
  }

  registry.save();
  return added;
}

