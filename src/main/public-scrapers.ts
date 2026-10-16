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

// SADECE yayın adresi gibi görünen URL'ler kabul edilir. (Geniş hali JS bundle
// içindeki github/örnek linklerini "kamera" sanıyordu → 7 çöp kayıt.)
function isStreamUrl(u: string): boolean {
  const s = u.toLowerCase();
  if (s.startsWith('rtsp://')) return true;
  if (!/^https?:\/\//.test(s)) return false;
  if (/\.(?:m3u8|flv|mjpg|mjpeg|ts)(?:[?#]|$)/.test(s)) return true;
  if (/\/(?:live|hls|canli|yayin|stream)(?:\/|\.|$)/.test(s)) return true;
  return false;
}

function protoOf(u: string): 'rtsp' | 'hls' | 'mjpeg' | 'http' {
  const s = u.toLowerCase();
  if (s.startsWith('rtsp://')) return 'rtsp';
  if (/\.m3u8|\.ts(?:[?#]|$)|\/hls\//.test(s)) return 'hls';
  if (/mjpe?g|mjpg/.test(s)) return 'mjpeg';
  return 'http';
}

// Mutlak yayın adreslerini HER YERDEN çıkar (iç içe JSON, inline JS, escape'li) —
// eski hali sadece düz {...} içinde ve .m3u8 arıyordu → 13 kaynağın 13'ü boş dönüyordu.
function extractStreamUrls(text: string): string[] {
  const urls = new Set<string>();
  const clean = text.replace(/\\\//g, '/');
  for (const m of clean.matchAll(/rtsp:\/\/[^\s"'\\<>]+/gi)) urls.add(m[0].replace(/[),;]+$/, ''));
  for (const m of clean.matchAll(/https?:\/\/[^\s"'\\<>]+?\.m3u8[^\s"'\\<>]*/gi)) urls.add(m[0]);
  for (const m of clean.matchAll(/https?:\/\/[^\s"'\\<>]+?\.(?:flv|mjpg|mjpeg)(?:\?[^\s"'\\<>]*)?/gi)) urls.add(m[0]);
  for (const m of clean.matchAll(/https?:\/\/[^\s"'\\<>]+\/(?:live|hls|canli|yayin)[^\s"'\\<>]*\.(?:m3u8|ts)[^\s"'\\<>]*/gi)) urls.add(m[0]);
  return [...urls].filter(isStreamUrl);
}

function extractCoords(text: string): { lat: number; lon: number } | null {
  const lat = /"(?:lat|latitude|enlem|y)"\s*:\s*"?(-?\d{1,2}\.\d{3,})/i.exec(text)?.[1];
  const lon = /"(?:lng|lon|longitude|boylam|x)"\s*:\s*"?(-?\d{1,3}\.\d{3,})/i.exec(text)?.[1];
  if (lat && lon) return { lat: Number(lat), lon: Number(lon) };
  return null;
}

// İç içe {} içeren GERÇEK JSON'da da çalışır: "anahtar":"url" eşleşmesini bulur,
// çevresindeki ±500 karakterden lat/lon/isim toplar. (Eski regex [^{}]* yüzünden
// {properties:{...},geometry:{...}} gibi yaygın şemaları tamamen kaçırıyordu.)
function extractCamObjects(body: string): Array<{ name: string; url: string; lat: number; lon: number }> {
  const out: Array<{ name: string; url: string; lat: number; lon: number }> = [];
  const clean = body.replace(/\\\//g, '/');
  const re =
    /"(?:url|stream|streamUrl|stream_url|streamurl|link|yayin|yayin_url|yayinUrl|videoUrl|video_url|hls|hlsUrl|rtsp|src)"\s*:\s*"((?:https?|rtsp):[^"]{6,400})"/gi;
  const seen = new Set<string>();
  for (const m of clean.matchAll(re)) {
    const url = m[1];
    if (!url || !isStreamUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const at = m.index ?? 0;
    const ctx = clean.slice(Math.max(0, at - 500), at + 500);
    const lat = Number(/"(?:lat|latitude|enlem)"\s*:\s*"?(-?\d{1,3}\.\d{2,})/i.exec(ctx)?.[1] || 0);
    const lon = Number(/"(?:lng|lon|longitude|boylam)"\s*:\s*"?(-?\d{1,3}\.\d{2,})/i.exec(ctx)?.[1] || 0);
    const name =
      /"(?:name|adi|ad|title|baslik|kamera|camera|aciklama|description)"\s*:\s*"([^"]{2,80})"/i.exec(ctx)?.[1] || '';
    out.push({ name, url, lat: Number.isFinite(lat) ? lat : 0, lon: Number.isFinite(lon) ? lon : 0 });
  }
  return out;
}

// KAYNAKLAR — canlı test sonucu: api.ibb.gov.tr 500, trafik.ibb.gov.tr DNS yok.
// Ölü/tahmin URL'ler çıkarıldı; 200 dönen gerçek sayfalar kaldı.
const PUBLIC_SOURCES: Array<{ label: string; url: string; il: string }> = [
  { label: 'İBB Trafik', url: 'https://www.ibb.istanbul/', il: 'İstanbul' },
  { label: 'İBB Açık Veri', url: 'https://data.ibb.gov.tr/api/3/action/package_search?q=kamera&rows=20', il: 'İstanbul' },
  { label: 'KGM', url: 'https://www.kgm.gov.tr/', il: 'Ankara' },
  { label: 'Ankara BB', url: 'https://www.ankara.bel.tr/trafik-kameralari', il: 'Ankara' },
  { label: 'İzmir BB', url: 'https://www.izmir.bel.tr/', il: 'İzmir' },
  { label: 'Bursa BB', url: 'https://www.bursa.bel.tr/canli-trafik-kamerasi', il: 'Bursa' },
  { label: 'Antalya BB', url: 'https://www.antalya.bel.tr/trafik-kameralari', il: 'Antalya' },
  { label: 'Kocaeli BB', url: 'https://www.kocaeli.bel.tr/trafik-kameralari', il: 'Kocaeli' },
  { label: 'Gaziantep BB', url: 'https://www.gaziantep.bel.tr/trafik-kameralari', il: 'Gaziantep' },
  { label: 'Adana BB', url: 'https://www.adana.bel.tr/trafik-kameralari', il: 'Adana' },
  { label: 'Mersin BB', url: 'https://www.mersin.bel.tr/canli-kamera', il: 'Mersin' },
  { label: 'Samsun BB', url: 'https://www.samsun.bel.tr/canli-yayin', il: 'Samsun' },
  { label: 'Kayseri BB', url: 'https://www.kayseri.bel.tr/trafik-kameralari', il: 'Kayseri' },
  { label: 'Eskişehir BB', url: 'https://www.eskisehir.bel.tr/canli-yayin', il: 'Eskişehir' },
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
    protocol: protoOf(url),
    url,
    // HTML'de URL görmek "online" demek DEĞİL — runPublicScrape doğrulayıp yükseltir.
    status: 'unknown',
    source: 'import',
    lastSeen: Date.now(),
    latencyMs: null,
    verified: false,
  };
}

// Sayfadaki script/iframe hedefleri (kamera/oynatıcı içerenler önce).
function collectRefs(html: string, base: string): string[] {
  const refs = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      refs.add(new URL(m[1], base).toString());
    } catch {
      /* skip */
    }
  }
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    try {
      refs.add(new URL(m[1], base).toString());
    } catch {
      /* skip */
    }
  }
  const score = (u: string) => (/camera|kamera|yayin|canli|stream|player|embed|hls|m3u8|video/i.test(u) ? 1 : 0);
  return [...refs].sort((a, b) => score(b) - score(a)).slice(0, 8);
}

// Sayfa JS'inde geçen kamera API yolları (/api/.../camera gibi).
function apiPaths(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/["'`](\/[A-Za-z0-9_\-./]*(?:camera|kamera|yayin|canli|stream|hls)[A-Za-z0-9_\-./]*)["'`]/gi)) {
    const p = m[1];
    if (p.length < 5 || p.length > 120) continue;
    if (/\.(?:js|css|png|jpe?g|svg|gif|ico|woff2?|webp)$/i.test(p)) continue;
    if (/^\/(?:tr|en|ar|ru|de|fr)\//i.test(p)) continue; // dil klasörleri
    out.add(p);
  }
  return [...out].slice(0, 5);
}

// Tüm kamu kaynaklarını tara — bağımsız, biri düşse diğerleri çalışır.
// DERİN TARAMA: belediye oynatıcıları yayın adresini HTML'e değil JS/iframe'e
// gömüyor → sayfanın script'leri + iframe'leri + JS'te geçen API yolları da taranır.
export async function scrapePublic(): Promise<RegisteredCamera[]> {
  const out: RegisteredCamera[] = [];
  const seenUrl = new Set<string>();
  const seenPage = new Set<string>();

  const take = (text: string, src: { label: string; il: string }, geo: { lat: number; lon: number } | null) => {
    for (const o of extractCamObjects(text)) {
      if (!o.url || seenUrl.has(o.url)) continue;
      seenUrl.add(o.url);
      out.push(toCam(o.name || src.label, o.url, o.lat || geo?.lat || 0, o.lon || geo?.lon || 0));
    }
    for (const u of extractStreamUrls(text)) {
      if (seenUrl.has(u)) continue;
      seenUrl.add(u);
      out.push(toCam(src.label, u, geo?.lat ?? 0, geo?.lon ?? 0));
    }
  };

  for (const src of PUBLIC_SOURCES) {
    try {
      const body = await getText(src.url);
      if (!body || body.length < 40) continue;
      const geo = extractCoords(body) || (await geocodeName(src.il));
      take(body, src, geo);

      const targets = collectRefs(body, src.url);
      for (const p of apiPaths(body)) {
        try {
          targets.push(new URL(p, src.url).toString());
        } catch {
          /* skip */
        }
      }
      for (const t of targets) {
        if (t === src.url || seenPage.has(t)) continue;
        seenPage.add(t);
        try {
          const sub = await getText(t);
          if (sub && sub.length > 40) take(sub, src, geo);
        } catch {
          /* alt kaynak düştü */
        }
      }
    } catch {
      /* kaynak düştü → sonraki */
    }
    if (out.length > 500) break; // aşırı büyümeyi kıs
  }
  return out;
}

export async function ibbTraffic(): Promise<RegisteredCamera[]> {
  return scrapePublic();
}

export async function kgmCameras(): Promise<RegisteredCamera[]> {
  return [];
}

