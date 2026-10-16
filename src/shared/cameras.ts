import { ILS, Il } from './ils';

export type CameraProtocol = 'demo' | 'rtsp' | 'hls' | 'http' | 'mjpeg' | 'webrtc';

export type CameraStatus = 'online' | 'offline' | 'unknown';

export interface Camera {
  id: string;
  ilId: number;
  il: string;
  ilce: string;
  name: string;
  lat: number;
  lon: number;
  status: CameraStatus;
  protocol: CameraProtocol;
  url: string;
  verified?: boolean;
}

const LOCATION_SUFFIXES = [
  'Kavşağı',
  'Meydan',
  'Girişi',
  'Bulvarı',
  'İstasyon',
  'Park',
  'Üst Geçit',
  'Çarşı',
  'Terminal',
  'Stadyum',
];

const GENERIC_ILCES = [
  'Merkez', 'Yenişehir', 'Bahçelievler', 'Sanayi', 'Liman', 'Kale',
  'Cumhuriyet', 'Fatih', 'Atatürk', 'İstasyon', 'Gazi', 'Zafer',
  'Barbaros', 'Yıldız', 'Çarşı', 'Üniversite', 'Organize', 'Esenler',
  'Güneşli', 'İnönü', 'Mevlana', 'Şehitler', 'Yavuz', 'Şirinevler',
];

function ilcesFor(il: Il): string[] {
  if (il.ilces && il.ilces.length > 0) return il.ilces;
  const count = 4 + (il.plate % 6);
  const start = (il.plate * 7) % GENERIC_ILCES.length;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(GENERIC_ILCES[(start + i * 5) % GENERIC_ILCES.length]);
  }
  return [...new Set(out)];
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function statusFor(seed: number): CameraStatus {
  const v = seed % 10;
  if (v < 7) return 'online';
  if (v < 9) return 'offline';
  return 'unknown';
}

function offsetFor(seed: number): { lat: number; lon: number } {
  const a = seed % 1000;
  const b = Math.floor(seed / 1000) % 1000;
  return {
    lat: ((a % 60) - 30) / 600,
    lon: ((b % 60) - 30) / 600,
  };
}

function buildCameras(): Camera[] {
  const cameras: Camera[] = [];

  for (const il of ILS) {
    const ilces: string[] = ilcesFor(il);
    ilces.forEach((ilce, ilceIdx) => {
      const count = 5 + (hashString(`${il.plate}:${ilce}`) % 8);
      for (let c = 0; c < count; c++) {
        const seed = hashString(`${il.plate}-${ilceIdx}-${c}`);
        const off = offsetFor(seed);
        const suffix = LOCATION_SUFFIXES[seed % LOCATION_SUFFIXES.length];
        cameras.push({
          id: `cam-${il.plate}-${ilceIdx}-${c}`,
          ilId: il.plate,
          il: il.name,
          ilce,
          name: `${ilce} ${suffix}`,
          lat: il.lat + off.lat,
          lon: il.lon + off.lon,
          status: statusFor(seed),
          protocol: 'demo',
          url: '',
        });
      }
    });
  }

  return cameras;
}

export const CAMERAS: Camera[] = buildCameras();

export const IL_LOOKUP: Map<number, Il> = new Map(ILS.map((il) => [il.plate, il]));

export function cameraCountByIl(): Map<string, number> {
  const m = new Map<string, number>();
  for (const cam of CAMERAS) {
    m.set(cam.il, (m.get(cam.il) || 0) + 1);
  }
  return m;
}
