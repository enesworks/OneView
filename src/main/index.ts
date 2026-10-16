import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { StreamEngine, CameraDescriptor } from './stream';
import { CameraRegistry, hashId, RegisteredCamera, CamProtocol } from './registry';
import { LivenessMonitor } from './liveness';
import { CAMERAS } from '../shared/cameras';
import { ssdpDiscover, sadpDiscover, dahuaDiscover, Infiltrator } from './intrusion';
import { arpHosts } from './netscan';
import { SourceCatalog } from './sources';
import { Geocoder } from './geocode';
import { skylineTurkey } from './webcams';
import { shodanKey, censysToken, shodanHosts, censysHosts, reachCameras } from './shodan';
import { validateBatch } from './validate';
import { Scheduler } from './scheduler';
import { openStore, CameraStore } from './db';
import { registerEngineTasks, storeStats } from './pipeline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.name = 'OneView';
app.setAppUserModelId('com.enesworks.oneview');

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
const streamEngine = new StreamEngine();
const registry = new CameraRegistry();
const liveness = new LivenessMonitor(registry, streamEngine);
const sources = new SourceCatalog();
const geocoder = new Geocoder();
const scheduler = new Scheduler();
let store: CameraStore | null = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    resizable: true,
    backgroundColor: '#0A0E14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  } else {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
  }

  return mainWindow;
}

// --- IPC: stream engine ---
ipcMain.handle('stream:acquire', async (_e, camera: CameraDescriptor) => {
  try {
    return await streamEngine.acquire(camera);
  } catch (err) {
    console.error('[OneView] acquire failed:', err);
    throw new Error(err instanceof Error ? err.message : 'acquire failed');
  }
});

ipcMain.handle('stream:probe', async (_e, url: string) => {
  try {
    return await streamEngine.probe(url);
  } catch {
    return false;
  }
});

ipcMain.on('stream:release', (_e, sessionId: string) => {
  streamEngine.release(sessionId);
});

ipcMain.on('stream:touch', (_e, sessionId: string) => {
  streamEngine.touch(sessionId);
});

// --- IPC: registry & discovery ---
ipcMain.handle('registry:list', () => registry.all());
ipcMain.handle('registry:stats', () => registry.stats());
ipcMain.handle('store:stats', () => (store ? storeStats(store) : { total: 0, live: 0 }));
ipcMain.handle('store:thumbnails', () => (store ? store.listThumbs() : []));
ipcMain.handle('store:scan', () => {
  if (!store) return { scanned: 0, devices: 0, live: 0, open: 0 };
  const all = store.listDevices();
  return {
    scanned: Number(store.getMeta('scan-total') || '0'),
    open: Number(store.getMeta('scan-open') || '0'),
    devices: all.length,
    live: all.filter((d) => d.status === 'LIVE').length,
  };
});












ipcMain.handle('liveness:check', async () => {
  await liveness.checkNow();
  return registry.stats();
});



// --- IPC: window controls ---
ipcMain.on('window:hide', () => mainWindow?.hide());
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('app:quit', () => quitGracefully());

async function quitGracefully(): Promise<void> {
  if (isQuitting) return;
  isQuitting = true;
  try {
    await streamEngine.shutdown();
  } catch (err) {
    console.error('[OneView] stream shutdown error:', err);
  }
  app.exit(0);
}

function seedRegistry(): void {
  for (const cam of CAMERAS) {
    const existing = registry.get(cam.id);
    if (existing && existing.source !== 'seed') continue;
    registry.add({
      id: cam.id,
      name: cam.name,
      il: cam.il,
      ilce: cam.ilce,
      lat: cam.lat,
      lon: cam.lon,
      protocol: cam.protocol as CamProtocol,
      url: cam.url,
      status: cam.status,
      source: 'seed',
      lastSeen: null,
      latencyMs: null,
    });
  }
  registry.save();
}

async function autoDiscover(): Promise<void> {
  try {
    const hosts = new Set<string>(await arpHosts());
    const [ssdp, sadp, dahua] = await Promise.all([
      ssdpDiscover(2000),
      sadpDiscover(1500),
      dahuaDiscover(1500),
    ]);
    for (const h of [...ssdp, ...sadp, ...dahua]) hosts.add(h);

    const inf = new Infiltrator();
    for (const host of hosts) {
      let access = await inf.accessHttp(host, 80);
      if (!access) access = await inf.accessOnvif(host, 80);
      if (!access) access = await inf.accessRtsp(host, 554);
      if (!access) continue;
      const id = hashId(access.url);
      if (registry.get(id)) continue;
      registry.add({
        id,
        name: host,
        il: '',
        ilce: '',
        lat: 0,
        lon: 0,
        protocol: access.protocol as CamProtocol,
        url: access.url,
        status: 'online',
        source: 'intrusion',
        lastSeen: Date.now(),
        latencyMs: null,
      });
    }
    registry.save();
  } catch (err) {
    console.error('[Autopilot] discover error:', err);
  }
}

async function autoSyncSources(): Promise<void> {
  try {
    for (const s of sources.list()) {
      if (!s.enabled) continue;
      const cams = await sources.sync(s.id);
      const valid = await validateBatch(cams, 8);
      for (const c of valid) c.verified = true;
      registry.addMany(valid);
    }
    registry.save();
  } catch (err) {
    console.error('[Autopilot] sync error:', err);
  }
}

function startAutopilot(): void {
  scheduler.register('sync-sources', autoSyncSources, 10 * 60_000, true);
  scheduler.register('discover', autoDiscover, 15 * 60_000, true);
  scheduler.register('webcams', autoWebcams, 20 * 60_000, true);
  scheduler.register('geocode', geocodeJob, 30 * 60_000, true);
  scheduler.register('global', autoGlobal, 60 * 60_000, true);
  if (store) registerEngineTasks(scheduler, store, registry, streamEngine);
}

async function autoGlobal(): Promise<void> {
  try {
    const key = shodanKey();
    const token = censysToken();
    if (!key && !token) return;
    const hosts = [...(await shodanHosts(key)), ...(await censysHosts(token))];
    if (!hosts.length) return;
    const cams = await reachCameras(hosts);
    if (cams.length) {
      for (const c of cams) c.verified = true;
      registry.addMany(cams);
      registry.save();
    }
  } catch (err) {
    console.error('[Autopilot] global error:', err);
  }
}

async function geocodeJob(): Promise<void> {
  try {
    const groups = new Map<string, RegisteredCamera[]>();
    for (const c of registry.all()) {
      if (!c.il || !c.ilce) continue;
      const key = `${c.ilce},${c.il}`;
      const arr = groups.get(key) || [];
      arr.push(c);
      groups.set(key, arr);
    }

    let changed = false;
    for (const [key, list] of groups) {
      let geo = geocoder.get(key);
      if (!geo) {
        const [ilce, il] = key.split(',');
        geo = (await geocoder.resolve(ilce, il)) || undefined;
        if (geo) geocoder.save();
        await new Promise((r) => setTimeout(r, 350));
        if (!geo) continue;
      }
      const g = geo;
      list.forEach((c, i) => {
        const lat = g.lat + (((i * 37) % 40) - 20) / 9000;
        const lon = g.lon + (((i * 53) % 40) - 20) / 9000;
        if (Math.abs(c.lat - lat) > 1e-6 || Math.abs(c.lon - lon) > 1e-6) {
          registry.update(c.id, { lat, lon });
          changed = true;
        }
      });
    }
    if (changed) registry.save();
  } catch (err) {
    console.error('[Autopilot] geocode error:', err);
  }
}

async function autoWebcams(): Promise<void> {
  try {
    const cams = await skylineTurkey();
    for (const c of cams) {
      if (!c.lat || !c.lon) {
        const city = c.name.split(/[-–|]/)[0].trim();
        const geo = await geocoder.resolve(city, '');
        if (geo) {
          c.lat = geo.lat;
          c.lon = geo.lon;
          geocoder.save();
        }
      }
    }
    if (cams.length) {
      const valid = await validateBatch(cams, 8);
      for (const c of valid) c.verified = true;
      registry.addMany(valid);
      registry.save();
    }
  } catch (err) {
    console.error('[Autopilot] webcams error:', err);
  }
}

app.whenReady().then(() => {
  registry.load();
  sources.load();
  geocoder.load();
  store = openStore(app.getPath('userData'));
  // ⚠️ Eskiden: source==='scan' && status!=='online' → TÜM keşfedilmiş kameralar
  // her açılışta siliniyordu. Artık sadece url'siz/konumsuz junk temizlenir.
  registry.purge((c) => c.protocol === 'demo' || c.source === 'seed' || (c.source === 'scan' && !c.url && c.status === 'unknown'));
  liveness.start();
  startAutopilot();
  createWindow();
});

app.on('before-quit', (e) => {
  if (!isQuitting) {
    e.preventDefault();
    quitGracefully();
  }
});

app.on('window-all-closed', () => {
  quitGracefully();
});
