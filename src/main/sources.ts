import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { RegisteredCamera, CamProtocol, hashId } from './registry';
import { writeAtomic, readJson } from './fstore';

export interface SourceDef {
  id: string;
  name: string;
  url: string;
  kind: 'json' | 'csv';
  enabled: boolean;
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const k of keys) {
    const v = lower[k];
    if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  }
  return '';
}

function normalize(obj: Record<string, unknown>): RegisteredCamera | null {
  const url = pick(obj, ['url', 'stream', 'streamurl', 'stream_url', 'yayin', 'yayin_url', 'rtsp', 'link', 'href', 'adres', 'kamera_url']);
  if (!/^(rtsp|http|https):\/\//i.test(url)) return null;

  const low = url.toLowerCase();
  const protocol: CamProtocol = low.startsWith('rtsp')
    ? 'rtsp'
    : low.includes('.m3u8')
      ? 'hls'
      : low.includes('mjpg') || low.includes('mjpeg') || low.includes('video.cgi')
        ? 'mjpeg'
        : 'http';

  const name = pick(obj, ['name', 'adi', 'ad', 'title', 'kamera', 'camera', 'isim', 'baslik']) || url;
  const latS = pick(obj, ['lat', 'latitude', 'enlem']);
  const lonS = pick(obj, ['lon', 'lng', 'longitude', 'boylam', 'long']);
  const lat = latS ? Number(latS) : 0;
  const lon = lonS ? Number(lonS) : 0;

  return {
    id: hashId(url),
    name,
    il: pick(obj, ['il', 'city', 'sehir', 'province']),
    ilce: pick(obj, ['ilce', 'district', 'town', 'ilce_adi']),
    lat: Number.isFinite(lat) ? lat : 0,
    lon: Number.isFinite(lon) ? lon : 0,
    protocol,
    url,
    status: 'unknown',
    source: 'import',
    lastSeen: Date.now(),
    latencyMs: null,
  };
}

function findArray(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 4 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findArray(v, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

function parseCsv(text: string): Array<Record<string, unknown>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(/[;,]/).map((h) => h.trim());
  const out: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(/[;,]/);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, j) => (obj[h] = cells[j]));
    out.push(obj);
  }
  return out;
}

export class SourceCatalog {
  private sources: SourceDef[] = [];
  private file: string;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'sources.json');
  }

  load(): void {
    const raw = readJson<SourceDef[]>(this.file, []);
    this.sources = Array.isArray(raw) ? raw.filter((s) => s && s.url) : [];
  }

  save(): void {
    writeAtomic(this.file, JSON.stringify(this.sources, null, 2));
  }

  list(): SourceDef[] {
    return this.sources;
  }

  add(def: Omit<SourceDef, 'id' | 'enabled'> & { enabled?: boolean }): SourceDef {
    const id = hashId(`${def.name}:${def.url}`);
    const existing = this.sources.find((s) => s.id === id);
    if (existing) return existing;
    const src: SourceDef = {
      id,
      name: def.name || def.url,
      url: def.url,
      kind: def.kind === 'csv' ? 'csv' : 'json',
      enabled: def.enabled !== false,
    };
    this.sources.push(src);
    this.save();
    return src;
  }

  remove(id: string): SourceDef[] {
    this.sources = this.sources.filter((s) => s.id !== id);
    this.save();
    return this.sources;
  }

  async sync(id: string): Promise<RegisteredCamera[]> {
    const src = this.sources.find((s) => s.id === id);
    if (!src || !src.enabled) return [];
    try {
      const res = await fetch(src.url, { redirect: 'follow' });
      const text = await res.text();
      const items = src.kind === 'csv' ? parseCsv(text) : findArray(JSON.parse(text));
      const out: RegisteredCamera[] = [];
      for (const it of items) {
        const cam = normalize(it);
        if (cam) out.push(cam);
      }
      return out;
    } catch (err) {
      console.error('[Sources] sync error:', src.url, err);
      return [];
    }
  }
}
