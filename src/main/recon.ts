// V2 — Aktif tarayıcı + banner grabber + fingerprinter.

import * as net from 'net';
import * as http from 'http';
import * as https from 'https';

export const SCAN_PORTS = [554, 8554, 10554, 1554, 80, 8080, 81, 8081, 8000, 8001, 37777, 34567, 3702];

export interface OpenHost {
  ip: string;
  port: number;
}

function tcpOpen(ip: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, ip);
  });
}

export async function activeScan(
  ips: string[],
  ports: number[],
  concurrency = 500,
  timeoutMs = 3000,
): Promise<OpenHost[]> {
  const targets: Array<[string, number]> = [];
  for (const ip of ips) for (const p of ports) targets.push([ip, p]);

  const found: OpenHost[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, async () => {
    while (idx < targets.length) {
      const [ip, p] = targets[idx++];
      if (await tcpOpen(ip, p, timeoutMs)) found.push({ ip, port: p });
    }
  });
  await Promise.all(workers);
  return found;
}

export interface Banner {
  server: string;
  title: string;
  ok: boolean;
}

export function grabBanner(ip: string, port: number, timeoutMs = 4000): Promise<Banner> {
  return new Promise((resolve) => {
    const secure = port === 443;
    const lib = secure ? https : http;
    const req = (lib as typeof http).request(
      {
        host: ip,
        port,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'OneView/2.0', Accept: 'text/html' },
        rejectUnauthorized: false,
      } as http.RequestOptions,
      (res) => {
        const server = String(res.headers['server'] || '');
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > 64_000) res.destroy();
        });
        res.on('close', () => {
          const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() || '';
          resolve({ server, title, ok: (res.statusCode || 0) < 500 });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ server: '', title: '', ok: false });
    });
    req.on('error', () => resolve({ server: '', title: '', ok: false }));
    req.end();
  });
}

export function fingerprint(server: string, title: string): string {
  const s = server.toLowerCase();
  const t = title.toLowerCase();
  if (s.includes('boa') || s.includes('hikvision')) return 'hikvision';
  if (s.includes('dnvrs-webs') || s.includes('dahua')) return 'dahua';
  if (s.includes('netsurveillance')) return 'generic';
  if (s.includes('app-webs') || s.includes('foscam')) return 'foscam';
  if (s.includes('axis')) return 'axis';
  if (t.includes('hikvision')) return 'hikvision';
  if (t.includes('dahua')) return 'dahua';
  if (t.includes('axis')) return 'axis';
  if (t.includes('foscam')) return 'foscam';
  return 'generic';
}

function httpGet(ip: string, port: number, path: string, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: ip, port, path, method: 'GET', timeout: timeoutMs, headers: { 'User-Agent': 'OneView/2.0' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

export async function confirmVendor(ip: string, port: number, guess: string): Promise<string> {
  if (guess === 'hikvision' && (await httpGet(ip, port, '/ISAPI/System/deviceInfo')) === 200) return 'hikvision';
  if (guess === 'dahua' && (await httpGet(ip, port, '/cgi-bin/magicbox.cgi')) === 200) return 'dahua';
  if (guess === 'axis' && (await httpGet(ip, port, '/axis-cgi/com/')) === 200) return 'axis';
  return guess;
}
