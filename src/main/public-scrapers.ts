// V2 — Public trafik kamerası scraper'ları (İBB / KGM / belediye).
// Sayfa HTML'inden .m3u8 ve koordinat çekilir. Koordinat yoksa şehir adı
// üzerinden Photon ile geocode edilir. Erişilemeyen kaynak sessizce boş döner.

import { RegisteredCamera, hashId } from './registry';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getText(url: string, timeoutMs = 15000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractM3u8(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/https?:(?:\\\/|\/){2}[^"'\\\s]+\.m3u8[^"'\\\s]*/gi)) {
    urls.add(m[0].replace(/\\\//g, '/'));
  }
  return [...urls];
}

function extractCoords(html: string): { lat: number; lon: number } | null {
  const lat = /"lat"\s*:\s*"?(-?\d{1,2}\.\d+)/i.exec(html)?.[1];
  const lon = /"(?:lng|lon|longitude)"\s*:\s*"?(-?\d{1,3}\.\d+)/i.exec(html)?.[1];
  if (lat && lon) return { lat: Number(lat), lon: Number(lon) };
  return null;
}

async function geocodeName(name: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(name)}&limit=1&lang=tr`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    clearTimeout(timer);
    const d = (await res.json()) as { features?: Array<{ geometry?: { coordinates?: number[] } }> };
    const c = d?.features?.[0]?.geometry?.coordinates;
    if (Array.isArray(c) && c.length >= 2 && c[0] && c[1]) return { lat: c[1], lon: c[0] };
  } catch {
    /* ignore */
  }
  return null;
}

function toCam(name: string, url: string, lat = 0, lon = 0): RegisteredCamera {
  return {
    id: hashId(url),
    name,
    il: '',
    ilce: '',
    lat,
    lon,
    protocol: 'hls',
    url,
    status: 'online',
    source: 'import',
    lastSeen: Date.now(),
    latencyMs: null,
    verified: true,
  };
}

export async function ibbTraffic(): Promise<RegisteredCamera[]> {
  const out: RegisteredCamera[] = [];
  const sources = ['https://trafik.ibb.gov.tr/', 'https://trafik.ibb.gov.tr/cctv'];
  for (const src of sources) {
    try {
      const html = await getText(src);
      const geo = extractCoords(html) || (await geocodeName('İstanbul'));
      const cams = extractM3u8(html);
      for (const url of cams) out.push(toCam('IBB Trafik', url, geo?.lat ?? 0, geo?.lon ?? 0));
    } catch {
      /* ignore — geo/token engelli olabilir */
    }
  }
  return out;
}

export async function kgmCameras(): Promise<RegisteredCamera[]> {
  const out: RegisteredCamera[] = [];
  const sources = ['https://www.kgm.gov.tr/Sayfalar/KGM/SiteTr/Trafik/CanliYayin.aspx'];
  for (const src of sources) {
    try {
      const html = await getText(src);
      const geo = extractCoords(html) || (await geocodeName('Ankara'));
      const cams = extractM3u8(html);
      for (const url of cams) out.push(toCam('KGM', url, geo?.lat ?? 0, geo?.lon ?? 0));
    } catch {
      /* ignore */
    }
  }
  return out;
}

