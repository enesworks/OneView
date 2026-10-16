import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { writeAtomic, readJson } from './fstore';

export interface Geo {
  lat: number;
  lon: number;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'OneView/1.0 (camera mapper)', Accept: 'application/json' },
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class Geocoder {
  private cache: Record<string, Geo> = {};
  private file: string;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'geo.json');
  }

  load(): void {
    this.cache = readJson<Record<string, Geo>>(this.file, {});
  }

  save(): void {
    writeAtomic(this.file, JSON.stringify(this.cache));
  }

  get(key: string): Geo | undefined {
    return this.cache[key];
  }

  async resolve(name: string, il: string): Promise<Geo | null> {
    const key = `${name},${il}`;
    if (this.cache[key]) return this.cache[key];
    let geo = await this.viaPhoton(name, il);
    if (!geo) geo = await this.viaNominatim(name, il);
    if (geo) this.cache[key] = geo;
    return geo;
  }

  private async viaPhoton(name: string, il: string): Promise<Geo | null> {
    try {
      const q = encodeURIComponent([name, il, 'Türkiye'].filter(Boolean).join(', '));
      const data = (await fetchJson(`https://photon.komoot.io/api/?q=${q}&limit=1&lang=tr`)) as {
        features?: Array<{ geometry?: { coordinates?: number[] } }>;
      };
      const c = data?.features?.[0]?.geometry?.coordinates;
      if (Array.isArray(c) && c.length >= 2 && c[0] && c[1]) {
        return { lon: c[0], lat: c[1] };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private async viaNominatim(name: string, il: string): Promise<Geo | null> {
    try {
      const q = encodeURIComponent([name, il].filter(Boolean).join(', '));
      const data = (await fetchJson(
        `https://nominatim.openstreetmap.org/search?q=${q}&countrycodes=tr&format=json&limit=1`,
      )) as Array<{ lat?: string; lon?: string }>;
      const r = Array.isArray(data) ? data[0] : null;
      if (r && r.lat && r.lon) return { lat: Number(r.lat), lon: Number(r.lon) };
    } catch {
      /* ignore */
    }
    return null;
  }
}
