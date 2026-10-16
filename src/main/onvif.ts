// ONVIF — WS-Discovery + Media (GetProfiles / GetStreamUri), WS-Security UsernameToken Digest.
// Anahtar gerekmez. ONVIF destekli kameralardan doğrudan RTSP akış adresi çeker.

import * as http from 'http';
import * as crypto from 'crypto';

export interface OnvifStream {
  url: string;
  profile: string;
}

const DEVICE_PATHS = ['/onvif/device_service', '/onvif/services', '/onvif/device', '/onvif/Device', '/device_service'];

function soapEnvelope(body: string, header = ''): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
    'xmlns:tt="http://www.onvif.org/ver10/schema">' +
    (header ? `<s:Header>${header}</s:Header>` : '') +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

function wsSecurity(user: string, pass: string, created?: string): string {
  const nonce = crypto.randomBytes(16);
  const stamp = created || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(stamp + pass, 'utf8')])).digest('base64');
  return (
    '<wsse:Security s:mustUnderstand="1" ' +
    'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
    'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
    '<wsse:UsernameToken><wsse:Username>' + user + '</wsse:Username>' +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + '</wsse:Password>' +
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonce.toString('base64') + '</wsse:Nonce>' +
    '<wsu:Created>' + stamp + '</wsu:Created></wsse:UsernameToken></wsse:Security>'
  );
}

function soapPost(host: string, port: number, path: string, xml: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const body = Buffer.from(xml, 'utf8');
    const req = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': body.length,
          'User-Agent': 'OneView/2.0',
        },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          b += c;
          if (b.length > 500_000) res.destroy();
        });
        res.on('close', () => resolve(b));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
    req.on('error', () => resolve(''));
    req.write(body);
    req.end();
  });
}

function devicesUtc(xml: string): string | undefined {
  const m = /<tt:UTCDateTime>\s*<tt:Date>(\d{4})-(\d{2})-(\d{2})<\/tt:Date>\s*<tt:Time>(\d{2}):(\d{2}):(\d{2})<\/tt:Time>/i.exec(xml);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// ONVIF servis yolunu sına — auth'suz GetSystemDateAndTime yanıtı = ONVIF cihaz.
export async function onvifProbe(host: string, port: number, timeoutMs = 3500): Promise<string> {
  for (const path of DEVICE_PATHS) {
    const res = await soapPost(host, port, path, soapEnvelope('<tds:GetSystemDateAndTime/>'), timeoutMs);
    if (/GetSystemDateAndTimeResponse/i.test(res)) return path;
  }
  return '';
}

async function onvifGetProfiles(host: string, port: number, path: string, user: string, pass: string, created?: string, timeoutMs = 5000): Promise<string[]> {
  const res = await soapPost(host, port, path, soapEnvelope('<trt:GetProfiles/>', wsSecurity(user, pass, created)), timeoutMs);
  const tokens: string[] = [];
  const re = /<trt:Profiles[^>]*token="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res))) tokens.push(m[1]);
  return tokens;
}

async function onvifGetStreamUri(host: string, port: number, path: string, user: string, pass: string, profile: string, created?: string, timeoutMs = 5000): Promise<string> {
  const body =
    '<trt:GetStreamUri><trt:StreamSetup>' +
    '<tt:Stream>RTP-Unicast</tt:Stream>' +
    '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>' +
    '</trt:StreamSetup>' +
    `<trt:ProfileToken>${profile}</trt:ProfileToken></trt:GetStreamUri>`;
  const res = await soapPost(host, port, path, soapEnvelope(body, wsSecurity(user, pass, created)), timeoutMs);
  return (/<trt:Uri>([^<]+)<\/trt:Uri>/i.exec(res) || [])[1] || '';
}

// Cihazın tüm ONVIF profilleri için RTSP adreslerini topla.
export async function onvifStreams(host: string, port: number, user: string, pass: string, timeoutMs = 5000): Promise<OnvifStream[]> {
  const out: OnvifStream[] = [];
  for (const path of DEVICE_PATHS) {
    const dateRes = await soapPost(host, port, path, soapEnvelope('<tds:GetSystemDateAndTime/>'), Math.min(timeoutMs, 4000));
    const created = devicesUtc(dateRes);
    const profiles = await onvifGetProfiles(host, port, path, user, pass, created, timeoutMs);
    if (!profiles.length) continue;
    for (const p of profiles.slice(0, 8)) {
      const uri = await onvifGetStreamUri(host, port, path, user, pass, p, created, timeoutMs);
      if (uri.startsWith('rtsp://')) out.push({ url: uri, profile: p });
    }
    if (out.length) break; // doğru servis yolu bulundu
  }
  return out;
}
