// V2 — Vendor'a özel auth.
// Hikvision: ISAPI digest (SHA-256/MD5) + basic fallback.
// Dahua: RPC2_Login JSON (global.login) + CGI basic fallback.
// Kanal sayısı: ISAPI Video inputs / Dahua magicBox.

import * as http from 'http';
import * as https from 'https';
import { parseWwwAuthenticate, digestAuth, basicAuth } from './auth';

interface Resp {
  status: number;
  body: string;
  wwwAuth: string | undefined;
}

function httpReq(opts: {
  method: string;
  secure: boolean;
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<Resp> {
  return new Promise((resolve) => {
    const lib = opts.secure ? https : http;
    const req = (lib as typeof http).request(
      {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        timeout: opts.timeoutMs ?? 4000,
        headers: opts.headers || {},
        rejectUnauthorized: false,
      } as http.RequestOptions,
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > 500_000) res.destroy();
        });
        res.on('close', () =>
          resolve({ status: res.statusCode || 0, body, wwwAuth: res.headers['www-authenticate'] as string | undefined }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', wwwAuth: undefined });
    });
    req.on('error', () => resolve({ status: 0, body: '', wwwAuth: undefined }));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export interface HikAuth {
  ok: boolean;
  scheme: string;
  authHeader: string | null;
}

export async function hikvisionAuth(host: string, port: number, user: string, pass: string, timeoutMs = 4000): Promise<HikAuth> {
  const secure = port === 443;
  const p = port || (secure ? 443 : 80);
  const path = '/ISAPI/System/deviceInfo';

  const first = await httpReq({ method: 'GET', secure, host, port: p, path, timeoutMs });
  if (first.status === 200) return { ok: true, scheme: 'open', authHeader: null };

  if (first.status === 401 && first.wwwAuth) {
    const parsed = parseWwwAuthenticate(first.wwwAuth);
    if (parsed.scheme === 'digest' && parsed.challenge) {
      const header = digestAuth(user, pass, 'GET', path, parsed.challenge);
      const r = await httpReq({ method: 'GET', secure, host, port: p, path, headers: { Authorization: header }, timeoutMs });
      if (r.status === 200) return { ok: true, scheme: 'digest', authHeader: header };
    }
    if (parsed.scheme === 'basic') {
      const header = basicAuth(user, pass);
      const r = await httpReq({ method: 'GET', secure, host, port: p, path, headers: { Authorization: header }, timeoutMs });
      if (r.status === 200) return { ok: true, scheme: 'basic', authHeader: header };
    }
  }
  return { ok: false, scheme: 'none', authHeader: null };
}

export async function hikvisionLogin(host: string, port: number, user: string, pass: string): Promise<HikAuth> {
  const a = await hikvisionAuth(host, port, user, pass);
  if (a.ok) return a;
  const secure = port === 443;
  const p = port || 80;
  const header = basicAuth(user, pass);
  const r = await httpReq({ method: 'GET', secure, host, port: p, path: '/', headers: { Authorization: header } });
  if (r.status === 200) return { ok: true, scheme: 'basic', authHeader: header };
  return a;
}

export async function dahuaLogin(host: string, port: number, user: string, pass: string, timeoutMs = 4000): Promise<HikAuth> {
  const secure = port === 443;
  const p = port || 80;
  const body = JSON.stringify({
    method: 'global.login',
    params: { userName: user, password: pass, clientType: 'Web3.0', loginType: 'Direct' },
    id: 1,
    session: 0,
  });
  const r = await httpReq({
    method: 'POST',
    secure,
    host,
    port: p,
    path: '/RPC2_Login',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs,
  });
  if (r.status === 200 && r.body.includes('"result":true')) return { ok: true, scheme: 'rpc2', authHeader: null };

  const header = basicAuth(user, pass);
  const cgi = await httpReq({
    method: 'GET',
    secure,
    host,
    port: p,
    path: '/cgi-bin/magicBox.cgi?action=getSystemInfo',
    headers: { Authorization: header },
    timeoutMs,
  });
  if (cgi.status === 200) return { ok: true, scheme: 'cgi', authHeader: header };
  return { ok: false, scheme: 'none', authHeader: null };
}

export async function hikvisionChannelCount(host: string, port: number, user: string, pass: string): Promise<number> {
  const auth = await hikvisionAuth(host, port, user, pass);
  if (!auth.ok) return 0;
  const secure = port === 443;
  const p = port || (secure ? 443 : 80);
  const headers: Record<string, string> = auth.authHeader ? { Authorization: auth.authHeader } : {};
  const res = await httpReq({ method: 'GET', secure, host, port: p, path: '/ISAPI/System/Video/inputs/channels', headers });
  const n = res.body.match(/<VideoInputChannel/g);
  return n ? n.length : 0;
}

export async function dahuaChannelCount(host: string, port: number, user: string, pass: string): Promise<number> {
  const secure = port === 443;
  const p = port || 80;
  const header = basicAuth(user, pass);
  const res = await httpReq({
    method: 'GET',
    secure,
    host,
    port: p,
    path: '/cgi-bin/magicBox.cgi?action=getSystemInfo',
    headers: { Authorization: header },
  });
  const m = /channelNumber\s*=\s*(\d+)/i.exec(res.body);
  if (m) return Number(m[1]);
  const res2 = await httpReq({
    method: 'GET',
    secure,
    host,
    port: p,
    path: '/cgi-bin/devVideoInput.cgi?action=getCollect',
    headers: { Authorization: header },
  });
  const m2 = res2.body.match(/"channel"/g);
  return m2 ? m2.length : 0;
}
