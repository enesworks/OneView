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

// JSON gövdesindeki kamera nesnelerini (url + lat/lon + name) çıkar.
function extractCamObjects(body: string): Array<{ name: string; url: string; lat: number; lon: number }> {
  const out: Array<{ name: string; url: string; lat: number; lon: number }> = [];
  const re = /\{[^{}]*"(?:url|stream|streamUrl|stream_url|link|yayin|yayin_url)"\s*:\s*"(?:https?|rtsp):[^{}]*\}/gi;
  for (const m of body.matchAll(re)) {
    const chunk = m[0];
    const url = /"(?:url|stream|streamUrl|stream_url|link|yayin|yayin_url)"\s*:\s*"([^"]+)"/i.exec(chunk)?.[1];
    if (!url) continue;
    const lat = Number(/"(?:lat|latitude|enlem)"\s*:\s*"?(-?\d{1,2}\.\d+)/i.exec(chunk)?.[1] || 0);
    const lon = Number(/"(?:lon|lng|longitude|boylam)"\s*:\s*"?(-?\d{1,3}\.\d+)/i.exec(chunk)?.[1] || 0);
    const name = /"(?:name|adi|ad|title|baslik|kamera|camera)"\s*:\s*"([^"]{2,60})"/i.exec(chunk)?.[1] || '';
    out.push({
      name,
      url: url.replace(/\\\//g, '/'),
      lat: Number.isFinite(lat) ? lat : 0,
      lon: Number.isFinite(lon) ? lon : 0,
    });
  }
  return out;
}

// Aday kamu kaynakları — İBB/KGM/belediye trafik yayınları + açık JSON uçları.
const PUBLIC_SOURCES: Array<{ label: string; url: string; il: string }> = [
  { label: 'İBB Trafik', url: 'https://api.ibb.gov.tr/trafik/v1/camera', il: 'İstanbul' },
  { label: 'İBB Trafik', url: 'https://api.ibb.gov.tr/trafik/v1/cameras', il: 'İstanbul' },
  { label: 'İBB Trafik', url: 'https://api.ibb.gov.tr/trafik/camera', il: 'İstanbul' },
  { label: 'İBB Trafik', url: 'https://trafik.ibb.gov.tr/', il: 'İstanbul' },
  { label: 'KGM', url: 'https://www.kgm.gov.tr/', il: 'Ankara' },
  { label: 'KGM', url: 'https://www.kgm.gov.tr/api/cameras', il: 'Ankara' },
  { label: 'Ankara BB', url: 'https://www.ankara.bel.tr/trafik-kameralari', il: 'Ankara' },
  { label: 'İzmir BB', url: 'https://www.izmir.bel.tr/tr/CanliYayinlar', il: 'İzmir' },
  { label: 'Bursa BB', url: 'https://www.bursa.bel.tr/canli-trafik-kamerasi', il: 'Bursa' },
  { label: 'Antalya BB', url: 'https://www.antalya.bel.tr/trafik-kameralari', il: 'Antalya' },
  { label: 'Kocaeli BB', url: 'https://www.kocaeli.bel.tr/trafik-kameralari', il: 'Kocaeli' },
  { label: 'Gaziantep BB', url: 'https://www.gaziantep.bel.tr/trafik-kameralari', il: 'Gaziantep' },
  { label: 'Konya BB', url: 'https://www.konya.bel.tr/trafik-kameralari', il: 'Konya' },
  { label: 'Adana BB', url: 'https://www.adana.bel.tr/trafik-kameralari', il: 'Adana' },
];

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

// Tüm kamu kaynaklarını tara — bağımsız, biri düşse diğerleri çalışır.
export async function scrapePublic(): Promise<RegisteredCamera[]> {
  const out: RegisteredCamera[] = [];
  const seen = new Set<string>();
  for (const src of PUBLIC_SOURCES) {
    try {
      const body = await getText(src.url);
      if (!body || body.length < 40) continue;
      const geo = extractCoords(body) || (await geocodeName(src.il));
      for (const o of extractCamObjects(body)) {
        if (!o.url || seen.has(o.url)) continue;
        seen.add(o.url);
        out.push(toCam(o.name || src.label, o.url, o.lat || geo?.lat || 0, o.lon || geo?.lon || 0));
      }
      for (const url of extractM3u8(body)) {
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(toCam(src.label, url, geo?.lat ?? 0, geo?.lon ?? 0));
      }
    } catch {
      /* kaynak düştü → sonraki */
    }
  }
  return out;
}

export async function ibbTraffic(): Promise<RegisteredCamera[]> {
  return scrapePublic();
}

export async function kgmCameras(): Promise<RegisteredCamera[]> {
  return [];
}

