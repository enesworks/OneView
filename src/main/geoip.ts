// V2 — IP geolocation. Node http/https modülü (Electron'da kanıtlı), 4 sağlayıcı,
// cache + rate-limit (1.5sn < ip-api 45/dk).

import * as http from 'http';
import * as https from 'https';

export interface GeoIp {
  country: string;
  il: string;
  ilce: string;
  lat: number;
  lon: number;
}

function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      { timeout: timeoutMs, headers: { 'User-Agent': 'OneView/2.0', Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > 1_000_000) res.destroy();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function viaIpApi(ip: string): Promise<GeoIp | null> {
  const d = (await getJson(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon`)) as {
    status?: string;
    country?: string;
    regionName?: string;
    city?: string;
    lat?: number;
    lon?: number;
  } | null;
  if (d && d.status === 'success' && typeof d.lat === 'number' && typeof d.lon === 'number') {
    return { country: d.country || '', il: d.regionName || '', ilce: d.city || '', lat: d.lat, lon: d.lon };
  }
  return null;
}

async function viaIpapiCo(ip: string): Promise<GeoIp | null> {
  const d = (await getJson(`https://ipapi.co/${ip}/json/`)) as {
    latitude?: number;
    longitude?: number;
    city?: string;
    region?: string;
    country_name?: string;
  } | null;
  if (d && typeof d.latitude === 'number' && typeof d.longitude === 'number') {
    return {
      country: d.country_name || '',
      il: d.region || '',
      ilce: d.city || '',
      lat: d.latitude,
      lon: d.longitude,
    };
  }
  return null;
}

async function viaIpinfo(ip: string): Promise<GeoIp | null> {
  const d = (await getJson(`https://ipinfo.io/${ip}/json`)) as {
    loc?: string;
    city?: string;
    region?: string;
    country?: string;
  } | null;
  if (d && d.loc) {
    const [lat, lon] = d.loc.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { country: d.country || '', il: d.region || '', ilce: d.city || '', lat, lon };
    }
  }
  return null;
}

async function viaFreegeoip(ip: string): Promise<GeoIp | null> {
  const d = (await getJson(`https://freegeoip.app/json/${ip}`)) as {
    latitude?: number;
    longitude?: number;
    city?: string;
    region_name?: string;
    country_name?: string;
  } | null;
  if (d && typeof d.latitude === 'number' && typeof d.longitude === 'number') {
    return {
      country: d.country_name || '',
      il: d.region_name || '',
      ilce: d.city || '',
      lat: d.latitude,
      lon: d.longitude,
    };
  }
  return null;
}

function isPrivate(ip: string): boolean {
  return (
    !ip ||
    ip === '0.0.0.0' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.')
  );
}

export class GeoLocator {
  private cache = new Map<string, GeoIp>();
  private lastReq = 0;
  private minIntervalMs = 1500;

  async resolve(ip: string): Promise<GeoIp | null> {
    if (isPrivate(ip)) return null;
    const cached = this.cache.get(ip);
    if (cached) return cached;

    const wait = this.lastReq + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastReq = Date.now();

    const result =
      (await viaIpApi(ip)) || (await viaIpapiCo(ip)) || (await viaIpinfo(ip)) || (await viaFreegeoip(ip));
    if (result) this.cache.set(ip, result);
    return result;
  }
}

