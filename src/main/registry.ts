import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { readJson, writeAtomic } from './fstore';

export type CamStatus = 'online' | 'offline' | 'unknown';
export type CamProtocol = 'demo' | 'rtsp' | 'hls' | 'http' | 'mjpeg' | 'onvif' | 'cloud' | 'unknown';

export interface RegisteredCamera {
  id: string;
  name: string;
  il: string;
  ilce: string;
  lat: number;
  lon: number;
  protocol: CamProtocol;
  url: string;
  status: CamStatus;
  source: 'scan' | 'onvif' | 'import' | 'manual' | 'seed' | 'intrusion' | 'cloud';
  lastSeen: number | null;
  latencyMs: number | null;
  verified?: boolean;
}

export interface PrivateCameraInput {
  url: string;
  name?: string;
  il?: string;
  ilce?: string;
  lat?: number;
  lon?: number;
}

export class CameraRegistry {
  private cameras = new Map<string, RegisteredCamera>();
  private file: string;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'cameras.json');
  }

  load(): void {
    const raw = readJson<RegisteredCamera[]>(this.file, []);
    if (Array.isArray(raw)) {
      for (const c of raw) {
        if (c && typeof c.id === 'string') this.cameras.set(c.id, c);
      }
    }
  }

  save(): void {
    writeAtomic(this.file, JSON.stringify([...this.cameras.values()], null, 2));
  }

  all(): RegisteredCamera[] {
    return [...this.cameras.values()];
  }

  get(id: string): RegisteredCamera | undefined {
    return this.cameras.get(id);
  }

  add(cam: RegisteredCamera): void {
    this.cameras.set(cam.id, { ...cam });
  }

  addMany(list: RegisteredCamera[]): number {
    let added = 0;
    for (const cam of list) {
      if (!this.cameras.has(cam.id)) {
        this.cameras.set(cam.id, cam);
        added++;
      }
    }
    if (added > 0) this.save();
    return added;
  }

  remove(id: string): void {
    if (this.cameras.delete(id)) this.save();
  }

  update(id: string, patch: Partial<RegisteredCamera>): void {
    const existing = this.cameras.get(id);
    if (existing) {
      this.cameras.set(id, { ...existing, ...patch });
    }
  }

  purge(predicate: (c: RegisteredCamera) => boolean): number {
    let removed = 0;
    for (const [id, c] of [...this.cameras.entries()]) {
      if (predicate(c)) {
        this.cameras.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  stats() {
    const all = this.all();
    return {
      total: all.length,
      online: all.filter((c) => c.status === 'online').length,
      offline: all.filter((c) => c.status === 'offline').length,
      unknown: all.filter((c) => c.status === 'unknown').length,
    };
  }
}

export function hashId(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `cam-${(h >>> 0).toString(36)}`;
}
