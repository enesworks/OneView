import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

export type CameraProtocol = 'demo' | 'rtsp' | 'hls' | 'http' | 'mjpeg' | 'webrtc';

export interface CameraDescriptor {
  id: string;
  name: string;
  protocol: CameraProtocol;
  url: string;
  il: string;
  ilce: string;
}

export interface StreamSession {
  sessionId: string;
  url: string;
  type: 'hls' | 'direct';
  protocol: CameraProtocol;
}

interface ActiveSession {
  camera: CameraDescriptor;
  proc: ChildProcess | null;
  dir: string;
  createdAt: number;
  lastActive: number;
  restarts: number;
  released: boolean;
  refCount: number;
}

const HLS_PORT = 47700;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_SESSIONS = 6;
const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
};

function rewriteM3u8(text: string, base: URL, port: number): string {
  const wrap = (uri: string): string => {
    try {
      return `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(new URL(uri, base).toString())}`;
    } catch {
      return uri;
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${wrap(uri)}"`);
      }
      return wrap(trimmed);
    })
    .join('\n');
}

export class StreamEngine {
  private sessions = new Map<string, ActiveSession>();
  private server: http.Server | null = null;
  private baseDir: string;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.baseDir = path.join(os.tmpdir(), 'oneview-streams');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async probe(url: string, timeoutMs = 3000): Promise<boolean> {
    if (!url) return false;
    if (url.startsWith('demo')) return true;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  }

  async probeRtsp(url: string, timeoutMs = 3000): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 554;

    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        socket.write(`OPTIONS ${url} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: OneView/1.0\r\n\r\n`);
      });
      socket.once('data', (data) => {
        done(data.toString('utf-8').startsWith('RTSP/'));
      });
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  async probeHttp(url: string, timeoutMs = 3000): Promise<{ reachable: boolean; hint: string | null }> {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        const ct = res.headers['content-type'] || '';
        let hint: string | null = null;
        if (ct.includes('multipart/x-mixed-replace')) hint = 'mjpeg';
        else if (ct.includes('mpegurl')) hint = 'hls';
        else if (ct.includes('video/')) hint = 'http';
        res.resume();
        resolve({ reachable: true, hint });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false, hint: null });
      });
      req.on('error', () => resolve({ reachable: false, hint: null }));
    });
  }

  async detectProtocol(target: string): Promise<{ reachable: boolean; protocol: string; url: string }> {
    let url = target.trim();
    if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { reachable: false, protocol: 'unknown', url: target };
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'rtsp:' ? 554 : 80;

    if (parsed.protocol === 'rtsp:' || port === 554 || port === 8554) {
      if (await this.probeRtsp(url)) return { reachable: true, protocol: 'rtsp', url };
      if (await this.probe(url)) return { reachable: true, protocol: 'rtsp', url };
      return { reachable: false, protocol: 'rtsp', url };
    }

    const httpRes = await this.probeHttp(url);
    if (httpRes.reachable) {
      return { reachable: true, protocol: httpRes.hint || 'http', url };
    }
    if (await this.probe(url)) return { reachable: true, protocol: 'http', url };
    return { reachable: false, protocol: 'unknown', url };
  }

  async acquire(camera: CameraDescriptor): Promise<StreamSession> {
    if (camera.protocol === 'hls' && camera.url) {
      this.ensureServer();
      return {
        sessionId: `direct-${camera.id}`,
        url: `http://127.0.0.1:${HLS_PORT}/proxy?url=${encodeURIComponent(camera.url)}`,
        type: 'hls',
        protocol: 'hls',
      };
    }
    if (['http', 'mjpeg', 'webrtc'].includes(camera.protocol)) {
      return {
        sessionId: `direct-${camera.id}`,
        url: camera.url,
        type: 'direct',
        protocol: camera.protocol,
      };
    }
    // Aynı kamera için aktif oturum varsa yeniden kullan (tek RTSP bağlantısı).
    for (const [sid, s] of this.sessions) {
      if (s.camera.id === camera.id && !s.released) {
        s.refCount += 1;
        s.lastActive = Date.now();
        return {
          sessionId: sid,
          url: `http://127.0.0.1:${HLS_PORT}/${sid}/index.m3u8`,
          type: 'hls',
          protocol: 'rtsp',
        };
      }
    }
    return this.startHls(camera);
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.refCount -= 1;
    if (session.refCount > 0) {
      session.lastActive = Date.now();
      return;
    }
    session.released = true;
    this.teardown(session);
    this.sessions.delete(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActive = Date.now();
  }

  activeCount(): number {
    return this.sessions.size;
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const sessionId of [...this.sessions.keys()]) {
      this.release(sessionId);
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private async startHls(camera: CameraDescriptor): Promise<StreamSession> {
    this.ensureServer();
    this.ensureIdleSweep();

    const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(this.baseDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'index.m3u8');
    const args = this.buildFfmpegArgs(camera, out);

    const session: ActiveSession = {
      camera,
      proc: null,
      dir,
      createdAt: Date.now(),
      lastActive: Date.now(),
      restarts: 0,
      released: false,
      refCount: 1,
    };
    this.sessions.set(sessionId, session);

    const launch = (): void => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const errLog = fs.createWriteStream(path.join(dir, 'ffmpeg.log'), { flags: 'a' });
      p.stderr?.pipe(errLog);
      session.proc = p;
      p.once('exit', () => {
        if (!session.released && session.restarts < 5) {
          session.restarts++;
          launch();
        } else {
          this.sessions.delete(sessionId);
        }
      });
    };
    launch();

    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      this.release(oldest[0]);
    }

    await this.waitForFile(out, 15000);

    return {
      sessionId,
      url: `http://127.0.0.1:${HLS_PORT}/${sessionId}/index.m3u8`,
      type: 'hls',
      protocol: camera.protocol,
    };
  }

  private buildFfmpegArgs(camera: CameraDescriptor, out: string): string[] {
    const seg = path.join(path.dirname(out), 'seg-%d.ts');
    const hls: string[] = [
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '4',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', seg,
      out,
    ];

    if (camera.protocol === 'demo') {
      return [
        '-re',
        '-f', 'lavfi',
        '-i', 'testsrc2=size=1280x720:rate=15',
        '-vf', this.cctvFilter(camera),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-g', '15',
        '-pix_fmt', 'yuv420p',
        '-an',
        ...hls,
      ];
    }

    return [
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
      '-fflags', 'nobuffer',
      '-i', camera.url,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-an',
      ...hls,
    ];
  }

  private cctvFilter(camera: CameraDescriptor): string {
    const base =
      'format=gray,boxblur=6:2,noise=alls=34:allf=t+u,eq=contrast=1.15:brightness=0.02,vignette=PI/4';
    if (!fs.existsSync('C:/Windows/Fonts/consola.ttf')) return base;
    const label = (camera.name || 'CAM').replace(/[\\'":,%]/g, ' ').slice(0, 26).trim();
    return (
      base +
      `,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='${label}  %{pts\\:hms}':x=24:y=22:fontsize=26:fontcolor=white@0.9:box=1:boxcolor=black@0.45:boxborderw=8`
    );
  }

  private teardown(session: ActiveSession): void {
    const proc = session.proc;
    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const killer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000);
      killer.unref?.();
    }
    this.rmSafe(session.dir);
  }

  private rmSafe(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* transient file lock — best effort */
    }
  }

  private waitForFile(file: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          if (fs.existsSync(file) && fs.statSync(file).size > 0) return resolve();
        } catch {
          /* retry */
        }
        if (Date.now() - start > timeoutMs) return reject(new Error('transcode timeout'));
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  private ensureServer(): void {
    if (this.server) return;

    const baseDir = this.baseDir;
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (reqUrl.pathname === '/proxy') {
        void this.handleProxy(reqUrl, res);
        return;
      }
      const urlPath = decodeURIComponent(reqUrl.pathname);
      const rel = urlPath.replace(/^\/+/, '');
      const filePath = path.join(baseDir, rel);

      if (!filePath.startsWith(baseDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let isFile = false;
      try {
        isFile = fs.statSync(filePath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        res.writeHead(404);
        res.end();
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', () => {
        try {
          res.destroy();
        } catch {
          /* noop */
        }
      });
    });

    server.listen(HLS_PORT, '127.0.0.1');
    this.server = server;
  }

  private async handleProxy(reqUrl: URL, res: http.ServerResponse): Promise<void> {
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    try {
      const upstream = await fetch(target, { redirect: 'follow' });
      const ct = upstream.headers.get('content-type') || '';
      const isPlaylist =
        target.split('?')[0].toLowerCase().endsWith('.m3u8') || ct.includes('mpegurl');
      const cors: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      };
      if (isPlaylist) {
        const text = await upstream.text();
        const rewritten = rewriteM3u8(text, new URL(target), HLS_PORT);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(rewritten);
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { ...cors, 'Content-Type': ct || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    }
  }

  private ensureIdleSweep(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActive > IDLE_TIMEOUT_MS) {
          this.release(id);
        }
      }
    }, 30_000);
    this.idleTimer.unref?.();
  }
}

