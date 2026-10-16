import * as net from 'net';
import * as dgram from 'dgram';

const CAMERA_PORTS = [554, 8554, 80, 8080, 37777, 34567];
const ONVIF_MULTICAST = '239.255.255.250';
const ONVIF_PORT = 3702;

const WS_DISCOVERY_PROBE = `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"
          xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <Header><wsa:Action xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">
    http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action></Header>
  <Body><tds:Probe xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"/></Body>
</Envelope>`;

export class SubnetScanner {
  private concurrency: number;

  constructor(concurrency = 64) {
    this.concurrency = concurrency;
  }

  async scan(baseIp: string, ports: number[] = CAMERA_PORTS, timeoutMs = 700): Promise<string[]> {
    const targets: string[] = [];
    for (let i = 1; i <= 254; i++) targets.push(`${baseIp}.${i}`);

    const found: string[] = [];
    let idx = 0;
    const workers = Array.from({ length: this.concurrency }, async () => {
      while (idx < targets.length) {
        const ip = targets[idx++];
        for (const port of ports) {
          if (await this.tcpOpen(ip, port, timeoutMs)) {
            found.push(`${ip}:${port}`);
            break;
          }
        }
      }
    });
    await Promise.all(workers);
    return found;
  }

  private tcpOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
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
      socket.connect(port, ip);
    });
  }
}

export async function onvifDiscover(timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const socket = dgram.createSocket('udp4');

    socket.on('message', (msg) => {
      const text = msg.toString('utf-8');
      const matches = text.match(/https?:\/\/[^\s<"]+/g) || [];
      for (const m of matches) {
        const clean = m.replace(/&amp;/g, '&');
        found.add(clean);
      }
    });

    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.setMulticastTTL(2);
      try {
        socket.addMembership(ONVIF_MULTICAST);
      } catch {
        /* network may not support multicast */
      }
      socket.send(Buffer.from(WS_DISCOVERY_PROBE), ONVIF_PORT, ONVIF_MULTICAST);
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

export function localSubnets(): string[] {
  const { networkInterfaces } = require('os') as typeof import('os');
  const subs = new Set<string>();
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const parts = iface.address.split('.');
      if (parts.length === 4) {
        subs.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }
  return [...subs];
}
