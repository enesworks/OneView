import { exec } from 'child_process';
import * as net from 'net';

export function arpHosts(): Promise<string[]> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'arp -a' : 'arp -an';
    exec(cmd, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const hosts = new Set<string>();
      const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stdout)) !== null) {
        const ip = m[1];
        if (
          ip.startsWith('224.') ||
          ip.startsWith('239.') ||
          ip.startsWith('127.') ||
          ip === '0.0.0.0' ||
          ip === '255.255.255.255' ||
          ip.endsWith('.255') ||
          ip.endsWith('.0')
        ) {
          continue;
        }
        hosts.add(ip);
      }
      resolve([...hosts]);
    });
  });
}

export function probePort(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export async function openCameraPorts(
  hosts: string[],
  ports: number[],
  timeoutMs = 600,
  concurrency = 256,
): Promise<string[]> {
  const targets: Array<[string, number]> = [];
  for (const h of hosts) for (const p of ports) targets.push([h, p]);

  const found: string[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, async () => {
    while (idx < targets.length) {
      const [h, p] = targets[idx++];
      if (await probePort(h, p, timeoutMs)) found.push(`${h}:${p}`);
    }
  });
  await Promise.all(workers);
  return found;
}
