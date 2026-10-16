import * as crypto from 'crypto';

export function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop: string;
  opaque?: string;
  algorithm?: string;
}

export function parseWwwAuthenticate(
  header: string | undefined,
): { scheme: 'basic' | 'digest' | 'bearer' | 'none'; challenge?: DigestChallenge } {
  if (!header) return { scheme: 'none' };
  const h = header.trim();
  if (/^basic/i.test(h)) return { scheme: 'basic' };
  if (/^bearer/i.test(h)) return { scheme: 'bearer' };
  if (/^digest/i.test(h)) {
    const params: Record<string, string> = {};
    const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h)) !== null) {
      params[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
    }
    return {
      scheme: 'digest',
      challenge: {
        realm: params.realm || '',
        nonce: params.nonce || '',
        qop: params.qop || '',
        opaque: params.opaque,
        algorithm: params.algorithm,
      },
    };
  }
  return { scheme: 'none' };
}

function hasher(algorithm: string): (s: string) => string {
  if (/SHA-256/i.test(algorithm)) {
    return (s) => crypto.createHash('sha256').update(s).digest('hex');
  }
  return (s) => crypto.createHash('md5').update(s).digest('hex');
}

export function digestAuth(
  user: string,
  pass: string,
  method: string,
  uri: string,
  ch: DigestChallenge,
  ncValue = 1,
): string {
  const algorithm = ch.algorithm || 'MD5';
  const H = hasher(algorithm);
  const session = /-sess/i.test(algorithm);
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = ncValue.toString(16).padStart(8, '0');

  let ha1 = H(`${user}:${ch.realm}:${pass}`);
  if (session) ha1 = H(`${ha1}:${ch.nonce}:${cnonce}`);

  const ha2 = H(`${method}:${uri}`);
  const qop = ch.qop ? ch.qop.split(',')[0].trim() : '';
  const response = qop
    ? H(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${ch.nonce}:${ha2}`);

  let h = `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  if (ch.algorithm) h += `, algorithm=${ch.algorithm}`;
  return h;
}

export function wsSecurity(user: string, pass: string, created: string): string {
  const nonceBuf = crypto.randomBytes(16);
  const nonce = nonceBuf.toString('base64');
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonceBuf, Buffer.from(created, 'utf8'), Buffer.from(pass, 'utf8')]))
    .digest('base64');
  return (
    `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${user}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`
  );
}

export function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
