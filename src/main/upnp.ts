// UPnP IGD keşfi (anahtarsız). Modemde UPnP ile port yönlendirmesi yapılmış
// kameraları bulur — "private sanılan ama aslında açık" cihazlar.
// SSDP M-SEARCH → IGD açıklaması → GetGenericPortMappingEntry listesi.

import * as dgram from 'dgram';
import * as http from 'http';

export interface UpnpMapping {
  extPort: number;
  intIp: string;
  intPort: number;
  desc: string;
}

export interface UpnpResult {
  externalIp: string;
  mappings: UpnpMapping[];
}

const CAMERA_PORTS = new Set([554, 8554, 8000, 8080, 80, 37777, 10554]);

function ssdpSearch(timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const locations = new Set<string>();
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n',
    );
    sock.on('message', (buf) => {
      const t = buf.toString('latin1');
      const m = /^location:\s*(.+)$/im.exec(t);
      if (m) locations.add(m[1].trim());
    });
    sock.on('error', () => {
      try { sock.close(); } catch { /* noop */ }
      resolve([...locations]);
    });
    try { sock.send(msg, 0, msg.length, 1900, '239.255.255.250'); } catch { /* noop */ }
    setTimeout(() => {
      try { sock.close(); } catch { /* noop */ }
      resolve([...locations]);
    }, timeoutMs).unref?.();
  });
}

function httpGetText(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request(
        { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { b += c; if (b.length > 200_000) res.destroy(); });
          res.on('close', () => resolve(b));
        },
      );
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
      req.end();
    } catch {
      resolve('');
    }
  });
}

function soapCall(controlUrl: string, service: string, action: string, inner = '', timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const xml =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const body = Buffer.from(xml, 'utf8');
    try {
      const u = new URL(controlUrl);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port || 80,
          path: u.pathname + u.search,
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            'Content-Length': body.length,
            SOAPAction: `"${service}#${action}"`,
            'User-Agent': 'OneView/2.0',
          },
        },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { b += c; if (b.length > 200_000) res.destroy(); });
          res.on('close', () => resolve(b));
        },
      );
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
      req.write(body);
      req.end();
    } catch {
      resolve('');
    }
  });
}

// IGD açıklama XML'inden WAN(IP|PPP)Connection kontrol URL'sini çıkar.
function findControlUrl(xml: string, base: string): string {
  const m = /<serviceType>\s*(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:1)\s*<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i.exec(xml);
  if (!m) return '';
  try {
    return new URL(m[2].trim(), base).toString();
  } catch {
    return '';
  }
}

export async function upnpDiscover(timeoutMs = 6000): Promise<UpnpResult> {
  const out: UpnpResult = { externalIp: '', mappings: [] };
  const locations = await ssdpSearch(timeoutMs);
  for (const loc of locations.slice(0, 4)) {
    const desc = await httpGetText(loc, 5000);
    if (!desc) continue;
    const ctrl = findControlUrl(desc, loc);
    if (!ctrl) continue;
    const svc = 'urn:schemas-upnp-org:service:WANIPConnection:1';
    const ipRes = await soapCall(ctrl, svc, 'GetExternalIPAddress');
    const ext = (/<NewExternalIPAddress>([^<]+)</i.exec(ipRes) || [])[1];
    if (ext) out.externalIp = ext.trim();
    for (let i = 0; i < 64; i++) {
      const r = await soapCall(ctrl, svc, 'GetGenericPortMappingEntry', `<NewPortMappingIndex>${i}</NewPortMappingIndex>`);
      if (!/<NewExternalPort>/i.test(r)) break;
      const extPort = Number((/<NewExternalPort>(\d+)</i.exec(r) || [])[1] || 0);
      const intIp = (/<NewInternalClient>([^<]+)</i.exec(r) || [])[1] || '';
      const intPort = Number((/<NewInternalPort>(\d+)</i.exec(r) || [])[1] || 0);
      const dsc = (/<NewPortMappingDescription>([^<]*)</i.exec(r) || [])[1] || '';
      if (extPort && intIp) out.mappings.push({ extPort, intIp, intPort, desc: dsc });
    }
    if (out.mappings.length || out.externalIp) break; // doğru IGD bulundu
  }
  return out;
}

// UPnP ile dışa açılmış kamera adresleri (dış IP + dış port).
export async function upnpCameraUrls(): Promise<string[]> {
  const res = await upnpDiscover();
  const urls: string[] = [];
  const host = res.externalIp;
  if (!host) return urls;
  for (const m of res.mappings) {
    if (!CAMERA_PORTS.has(m.intPort)) continue;
    if (m.intPort === 554 || m.intPort === 8554 || m.intPort === 10554) urls.push(`rtsp://${host}:${m.extPort}`);
    else if (m.intPort === 8000) urls.push(`http://${host}:${m.extPort}/ISAPI/System/deviceInfo`);
    else urls.push(`http://${host}:${m.extPort}/`);
  }
  return urls;
}
