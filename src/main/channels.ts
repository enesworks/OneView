// V2 — NVR kanal keşfi + RTSP path enumeration.

import * as net from 'net';
import { basicAuth } from './auth';

type DescribeResult = 'ok' | 'auth' | 'fail';

function rtspDescribe(
  host: string,
  port: number,
  path: string,
  authHeader: string | null,
  timeoutMs = 2500,
): Promise<DescribeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (r: DescribeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      let req = `DESCRIBE rtsp://${host}:${port}${path} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: OneView/2.0\r\n`;
      if (authHeader) req += `Authorization: ${authHeader}\r\n`;
      req += '\r\n';
      socket.write(req);
    });
    socket.once('timeout', () => done('fail'));
    socket.once('error', () => done('fail'));
    socket.on('data', (buf) => {
      const text = buf.toString('utf8');
      if (/^RTSP\/1\.0 200/i.test(text)) done('ok');
      else if (/^RTSP\/1\.0 401/i.test(text)) done('auth');
      else if (/^RTSP\/1\.0 \d/i.test(text)) done('fail');
    });
  });
}

function hikvisionChannelPaths(c: number): string[] {
  return [`/Streaming/Channels/${c}01`, `/Streaming/Channels/${c}02`];
}

function dahuaChannelPaths(c: number): string[] {
  return [`/cam/realmonitor?channel=${c}&subtype=0`, `/cam/realmonitor?channel=${c}&subtype=1`];
}

function genericChannelPaths(c: number): string[] {
  return [`/cam/realmonitor?channel=${c}&subtype=0`, `/live/ch${c}`, `/h264/ch${c}/main/av_stream`];
}

function foscamChannelPaths(c: number): string[] {
  const idx = String(c - 1).padStart(2, '0');
  return [`/live/ch${idx}_0`, `/live/ch${idx}_1`];
}

function channelPathsForVendor(vendor: string, c: number): string[] {
  switch (vendor) {
    case 'hikvision':
      return hikvisionChannelPaths(c);
    case 'dahua':
      return dahuaChannelPaths(c);
    case 'foscam':
      return foscamChannelPaths(c);
    default:
      return genericChannelPaths(c);
  }
}

export async function discoverStreams(
  host: string,
  rtspPort: number,
  user: string,
  pass: string,
  vendor: string,
  maxChannels = 16,
): Promise<string[]> {
  const authHeader = user ? basicAuth(user, pass) : null;
  const out: string[] = [];
  let fails = 0;

  for (let c = 1; c <= maxChannels; c++) {
    const paths = channelPathsForVendor(vendor, c);
    let found = false;
    for (const p of paths) {
      const r = await rtspDescribe(host, rtspPort, p, authHeader, 2500);
      if (r === 'ok') {
        const authPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
        out.push(`rtsp://${authPart}${host}:${rtspPort}${p}`);
        found = true;
        break;
      }
    }
    if (found) {
      fails = 0;
    } else {
      fails++;
      if (fails >= 2) break;
    }
  }
  return out;
}
