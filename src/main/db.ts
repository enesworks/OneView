import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// V2 — Kalıcılık katmanı. node:sqlite (DatabaseSync) öncelik, JSON fallback.
// ---------------------------------------------------------------------------

export type DeviceStatus =
  | 'DISCOVERED'
  | 'ACCESSIBLE'
  | 'LIVE'
  | 'OFFLINE'
  | 'INACCESSIBLE'
  | 'DEAD';

export type DeviceVendor =
  | 'hikvision' | 'dahua' | 'axis' | 'foscam' | 'reolink'
  | 'uniview' | 'tplink' | 'dlink' | 'vivotek' | 'amcrest'
  | 'geovision' | 'panasonic' | 'samsung' | 'generic' | 'unknown';

export interface DeviceRecord {
  id: string;
  ip: string;
  port: number;
  vendor: DeviceVendor;
  model: string;
  city: string;
  district: string;
  lat: number;
  lon: number;
  status: DeviceStatus;
  protocol: string;
  url: string;
  username: string;
  password: string;
  source: string;
  firstSeen: number;
  lastSeen: number;
  lastExploit: number;
}

export interface TaskRecord {
  id: string;
  intervalMs: number;
  nextRun: number;
}

export interface ThumbRecord {
  deviceId: string;
  jpeg: Buffer;
  ts: number;
}

export interface CameraStore {
  upsertDevice(d: DeviceRecord): void;
  getDevice(id: string): DeviceRecord | undefined;
  listDevices(status?: DeviceStatus): DeviceRecord[];
  setDeviceStatus(id: string, status: DeviceStatus, ts?: number): void;
  removeDevice(id: string): void;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  recordCredSuccess(vendor: DeviceVendor | 'generic', username: string, password: string): void;
  preferredCreds(vendor: DeviceVendor | 'generic'): Array<[string, string]>;
  logAccess(cameraId: string, method: string, credential: string, success: boolean): void;
  saveThumb(deviceId: string, jpeg: Buffer): void;
  getThumb(deviceId: string): ThumbRecord | undefined;
  listThumbs(): ThumbRecord[];
  upsertTask(t: TaskRecord): void;
  listTasks(): TaskRecord[];
  close(): void;
}

// --- node:sqlite tip yüzeyi -------------------------------------------------

interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (file: string) => SqliteDb };

function loadSqlite(): SqliteModule | null {
  try {
    return require('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

function asStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function asNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

// --- SQLite store ----------------------------------------------------------

const DEVICE_COLS =
  'id, ip, port, vendor, model, city, district, lat, lon, status, protocol, url, username, password, source, first_seen, last_seen, last_exploit';

function rowToDevice(r: Record<string, unknown>): DeviceRecord {
  return {
    id: asStr(r.id),
    ip: asStr(r.ip),
    port: asNum(r.port),
    vendor: asStr(r.vendor) as DeviceVendor,
    model: asStr(r.model),
    city: asStr(r.city),
    district: asStr(r.district),
    lat: asNum(r.lat),
    lon: asNum(r.lon),
    status: asStr(r.status) as DeviceStatus,
    protocol: asStr(r.protocol),
    url: asStr(r.url),
    username: asStr(r.username),
    password: asStr(r.password),
    source: asStr(r.source),
    firstSeen: asNum(r.first_seen),
    lastSeen: asNum(r.last_seen),
    lastExploit: asNum(r.last_exploit),
  };
}

class SqliteStore implements CameraStore {
  private db: SqliteDb;
  private thumbs = new Map<string, ThumbRecord>();

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new (loadSqlite() as SqliteModule).DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 0,
        vendor TEXT NOT NULL DEFAULT 'unknown',
        model TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        lat REAL NOT NULL DEFAULT 0,
        lon REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'DISCOVERED',
        protocol TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0,
        last_exploit INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cred_rotation (
        vendor TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (vendor, username, password)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        interval_ms INTEGER NOT NULL DEFAULT 0,
        next_run INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        attempt_method TEXT NOT NULL DEFAULT '',
        attempt_credential TEXT NOT NULL DEFAULT '',
        success INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  upsertDevice(d: DeviceRecord): void {
    this.db
      .prepare(
        `INSERT INTO devices (${DEVICE_COLS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           ip=excluded.ip, port=excluded.port, vendor=excluded.vendor,
           model=excluded.model, city=excluded.city, district=excluded.district,
           lat=excluded.lat, lon=excluded.lon, status=excluded.status,
           protocol=excluded.protocol, url=excluded.url,
           username=excluded.username, password=excluded.password,
           source=excluded.source, last_seen=excluded.last_seen,
           last_exploit=excluded.last_exploit`,
      )
      .run(
        d.id, d.ip, d.port, d.vendor, d.model, d.city, d.district, d.lat, d.lon,
        d.status, d.protocol, d.url, d.username, d.password, d.source,
        d.firstSeen, d.lastSeen, d.lastExploit,
      );
  }

  getDevice(id: string): DeviceRecord | undefined {
    const r = this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE id = ?`).get(id);
    return r ? rowToDevice(r) : undefined;
  }

  listDevices(status?: DeviceStatus): DeviceRecord[] {
    const rows = status
      ? this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE status = ?`).all(status)
      : this.db.prepare(`SELECT ${DEVICE_COLS} FROM devices`).all();
    return rows.map(rowToDevice);
  }

  setDeviceStatus(id: string, status: DeviceStatus, ts = Date.now()): void {
    this.db
      .prepare('UPDATE devices SET status = ?, last_seen = ? WHERE id = ?')
      .run(status, ts, id);
  }

  removeDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return r ? asStr(r.value) : null;
  }

  recordCredSuccess(vendor: DeviceVendor | 'generic', username: string, password: string): void {
    this.db
      .prepare(
        `INSERT INTO cred_rotation (vendor, username, password, success_count, last_success)
         VALUES (?,?,?,1,?)
         ON CONFLICT(vendor, username, password) DO UPDATE SET
           success_count = success_count + 1, last_success = excluded.last_success`,
      )
      .run(vendor, username, password, Date.now());
  }

  preferredCreds(vendor: DeviceVendor | 'generic'): Array<[string, string]> {
    const rows = this.db
      .prepare(
        `SELECT username, password FROM cred_rotation
         WHERE vendor = ? OR vendor = 'generic'
         ORDER BY success_count DESC, last_success DESC LIMIT 20`,
      )
      .all(vendor);
    return rows.map((r) => [asStr(r.username), asStr(r.password)]);
  }

  saveThumb(deviceId: string, jpeg: Buffer): void {
    this.thumbs.set(deviceId, { deviceId, jpeg, ts: Date.now() });
  }

  getThumb(deviceId: string): ThumbRecord | undefined {
    return this.thumbs.get(deviceId);
  }

  listThumbs(): ThumbRecord[] {
    return [...this.thumbs.values()];
  }

  upsertTask(t: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, interval_ms, next_run) VALUES (?,?,?)
         ON CONFLICT(id) DO UPDATE SET interval_ms=excluded.interval_ms, next_run=excluded.next_run`,
      )
      .run(t.id, t.intervalMs, t.nextRun);
  }

  listTasks(): TaskRecord[] {
    return this.db
      .prepare('SELECT id, interval_ms, next_run FROM tasks')
      .all()
      .map((r) => ({ id: asStr(r.id), intervalMs: asNum(r.interval_ms), nextRun: asNum(r.next_run) }));
  }

  logAccess(cameraId: string, method: string, credential: string, success: boolean): void {
    this.db
      .prepare(
        'INSERT INTO access_log (camera_id, attempt_method, attempt_credential, success, timestamp) VALUES (?,?,?,?,?)',
      )
      .run(cameraId, method, credential, success ? 1 : 0, Date.now());
  }

  close(): void {
    this.db.close();
  }
}


// --- JSON fallback store ---------------------------------------------------

interface CredEntry {
  vendor: string;
  username: string;
  password: string;
  successCount: number;
  lastSuccess: number;
}

class JsonStore implements CameraStore {
  private file: string;
  private devices = new Map<string, DeviceRecord>();
  private creds: CredEntry[] = [];
  private tasks = new Map<string, TaskRecord>();
  private thumbs = new Map<string, ThumbRecord>();
  private accessLog: Array<{ cameraId: string; method: string; credential: string; success: boolean; timestamp: number }> = [];
  private meta = new Map<string, string>();

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as {
        devices?: DeviceRecord[];
        creds?: CredEntry[];
        tasks?: TaskRecord[];
        accessLog?: Array<{ cameraId: string; method: string; credential: string; success: boolean; timestamp: number }>;
        meta?: Array<[string, string]>;
      };
      for (const d of raw.devices || []) if (d && d.id) this.devices.set(d.id, d);
      this.creds = raw.creds || [];
      for (const t of raw.tasks || []) if (t && t.id) this.tasks.set(t.id, t);
      this.accessLog = raw.accessLog || [];
      this.meta = new Map(raw.meta || []);
    } catch (err) {
      console.error('[Store] load error:', err);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          { devices: [...this.devices.values()], creds: this.creds, tasks: [...this.tasks.values()], accessLog: this.accessLog, meta: [...this.meta.entries()] },
          null,
          2,
        ),
        'utf-8',
      );
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[Store] save error:', err);
    }
  }

  upsertDevice(d: DeviceRecord): void {
    const prev = this.devices.get(d.id);
    this.devices.set(d.id, prev ? { ...prev, ...d, firstSeen: prev.firstSeen } : d);
    this.save();
  }

  getDevice(id: string): DeviceRecord | undefined {
    return this.devices.get(id);
  }

  listDevices(status?: DeviceStatus): DeviceRecord[] {
    const all = [...this.devices.values()];
    return status ? all.filter((d) => d.status === status) : all;
  }

  setDeviceStatus(id: string, status: DeviceStatus, ts = Date.now()): void {
    const d = this.devices.get(id);
    if (d) {
      this.devices.set(id, { ...d, status, lastSeen: ts });
      this.save();
    }
  }

  removeDevice(id: string): void {
    if (this.devices.delete(id)) this.save();
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
    this.save();
  }

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  recordCredSuccess(vendor: DeviceVendor | 'generic', username: string, password: string): void {
    const hit = this.creds.find(
      (c) => c.vendor === vendor && c.username === username && c.password === password,
    );
    if (hit) {
      hit.successCount += 1;
      hit.lastSuccess = Date.now();
    } else {
      this.creds.push({ vendor, username, password, successCount: 1, lastSuccess: Date.now() });
    }
    this.save();
  }

  preferredCreds(vendor: DeviceVendor | 'generic'): Array<[string, string]> {
    return this.creds
      .filter((c) => c.vendor === vendor || c.vendor === 'generic')
      .sort((a, b) => b.successCount - a.successCount || b.lastSuccess - a.lastSuccess)
      .slice(0, 20)
      .map((c) => [c.username, c.password]);
  }

  saveThumb(deviceId: string, jpeg: Buffer): void {
    this.thumbs.set(deviceId, { deviceId, jpeg, ts: Date.now() });
  }

  getThumb(deviceId: string): ThumbRecord | undefined {
    return this.thumbs.get(deviceId);
  }

  listThumbs(): ThumbRecord[] {
    return [...this.thumbs.values()];
  }

  upsertTask(t: TaskRecord): void {
    this.tasks.set(t.id, t);
    this.save();
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  logAccess(cameraId: string, method: string, credential: string, success: boolean): void {
    this.accessLog.push({ cameraId, method, credential, success, timestamp: Date.now() });
    this.save();
  }

  close(): void {
    this.save();
  }
}

// --- factory ---------------------------------------------------------------

export function openStore(userDataDir: string, preferSqlite = true): CameraStore {
  const sqlite = loadSqlite();
  if (preferSqlite && sqlite) {
    try {
      return new SqliteStore(path.join(userDataDir, 'oneview.db'));
    } catch (err) {
      console.error('[Store] sqlite init failed, falling back to JSON:', err);
    }
  }
  return new JsonStore(path.join(userDataDir, 'oneview-v2.json'));
}

