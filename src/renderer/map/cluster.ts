import { Camera } from '../data/cameras';
import { ILS, Il } from '../data/ils';

export type ClusterType = 'il' | 'ilce' | 'camera';

export interface ClusterPoint {
  id: string;
  type: ClusterType;
  lat: number;
  lon: number;
  name: string;
  count: number;
  status?: Camera['status'];
  camera?: Camera;
}

export interface ClusterLayer {
  points: ClusterPoint[];
  labels: { lat: number; lon: number; name: string }[];
}

const IL_ZOOM = 8;
const CAMERA_ZOOM = 12;

export function buildClusterLayer(cameras: Camera[], zoom: number): ClusterLayer {
  if (zoom < IL_ZOOM) {
    return buildIlClusters(cameras);
  }
  if (zoom < CAMERA_ZOOM) {
    return buildIlceClusters(cameras);
  }
  return buildRawCameras(cameras);
}

function buildIlClusters(cameras: Camera[]): ClusterLayer {
  const byIl = new Map<number, Camera[]>();
  for (const cam of cameras) {
    const list = byIl.get(cam.ilId) || [];
    list.push(cam);
    byIl.set(cam.ilId, list);
  }

  const points: ClusterPoint[] = [];
  for (const il of ILS) {
    const list = byIl.get(il.plate);
    if (!list || list.length === 0) continue;
    points.push({
      id: `il-${il.plate}`,
      type: 'il',
      lat: il.lat,
      lon: il.lon,
      name: il.name,
      count: list.length,
      status: dominantStatus(list),
    });
  }

  return { points, labels: ILS.map((il) => ({ lat: il.lat, lon: il.lon, name: il.name })) };
}

function buildIlceClusters(cameras: Camera[]): ClusterLayer {
  const byKey = new Map<string, Camera[]>();
  for (const cam of cameras) {
    const key = `${cam.ilId}:${cam.ilce}`;
    const list = byKey.get(key) || [];
    list.push(cam);
    byKey.set(key, list);
  }

  const points: ClusterPoint[] = [];
  for (const [key, list] of byKey) {
    const lat = list.reduce((s, c) => s + c.lat, 0) / list.length;
    const lon = list.reduce((s, c) => s + c.lon, 0) / list.length;
    points.push({
      id: `ilce-${key}`,
      type: 'ilce',
      lat,
      lon,
      name: list[0].ilce,
      count: list.length,
      status: dominantStatus(list),
    });
  }

  const labels: { lat: number; lon: number; name: string }[] = [];
  const seen = new Set<number>();
  for (const cam of cameras) {
    if (!seen.has(cam.ilId)) {
      seen.add(cam.ilId);
      const il = ILS.find((i) => i.plate === cam.ilId);
      if (il) labels.push({ lat: il.lat, lon: il.lon, name: il.name });
    }
  }

  return { points, labels };
}

function buildRawCameras(cameras: Camera[]): ClusterLayer {
  const points: ClusterPoint[] = cameras.map((cam) => ({
    id: `cam-${cam.id}`,
    type: 'camera',
    lat: cam.lat,
    lon: cam.lon,
    name: cam.name,
    count: 1,
    status: cam.status,
    camera: cam,
  }));

  return { points, labels: [] };
}

function dominantStatus(list: Camera[]): Camera['status'] {
  const offline = list.filter((c) => c.status === 'offline').length;
  if (offline === list.length) return 'offline';
  if (offline > 0) return 'online';
  return 'online';
}
