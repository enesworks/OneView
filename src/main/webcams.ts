import { RegisteredCamera, hashId } from './registry';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractCoords(html: string): { lat: number; lon: number } {
  const latM = html.match(/"(?:lat|latitude)"\s*:\s*"?(-?\d{1,2}\.\d+)"/i);
  const lonM = html.match(/"(?:lng|lon|longitude)"\s*:\s*"?(-?\d{1,3}\.\d+)"/i);
  return {
    lat: latM ? Number(latM[1]) : 0,
    lon: lonM ? Number(lonM[1]) : 0,
  };
}

function extractStream(html: string): string | null {
  const m = html.match(/https?:(?:\\\/|\/){2}[^"'\\\s]+\.m3u8[^"'\\\s]*/i);
  if (!m) return null;
  return m[0].replace(/\\\//g, '/');
}

export async function skylineTurkey(): Promise<RegisteredCamera[]> {
  const out: RegisteredCamera[] = [];
  let listing = '';
  try {
    listing = await getText('https://www.skylinewebcams.com/en/webcam/turkey.html');
  } catch {
    return out;
  }

  const links = new Set<string>();
  for (const m of listing.matchAll(/href="(\/en\/webcam\/turkey\/[^"#?]+\.html)"/g)) {
    links.add(m[1]);
  }

  for (const link of links) {
    try {
      const page = await getText(`https://www.skylinewebcams.com${link}`);
      const url = extractStream(page);
      if (!url) continue;
      const titleM = page.match(/<title>([^<]+)<\/title>/i);
      const name = (titleM ? titleM[1] : link)
        .replace(/【[^】]*】/g, '')
        .replace(/Live Cam/gi, '')
        .replace(/\|.*$/, '')
        .trim();
      const c = extractCoords(page);
      out.push({
        id: hashId(url),
        name: name || link,
        il: '',
        ilce: '',
        lat: c.lat,
        lon: c.lon,
        protocol: 'hls',
        url,
        status: 'unknown',
        source: 'import',
        lastSeen: Date.now(),
        latencyMs: null,
      });
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      /* skip camera */
    }
  }

  return out;
}
