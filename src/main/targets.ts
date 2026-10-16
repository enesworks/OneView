// ---------------------------------------------------------------------------
// V2 — Keşif motoru hedef kaynağı.
//
// RIPE NCC stat API'si Türkiye'nin v4 prefix'lerini ve ASN listesini verir.
// Öncelikli operatör ASN'leri önce, kalan TR v4 sonra taranır. Queue CIDR
// aralıklarını lazy genişletir — milyonlarca IP memory'ye yığılmaz.
// ---------------------------------------------------------------------------

const RIPE = 'https://stat.ripe.net/data';

// Öncelikli operatörler (priority 0 — önce taranır)
export const PRIORITY_ASNS: Record<string, string> = {
  AS9121: 'Turk Telekom',
  AS47331: 'TTNet',
  AS16135: 'Turkcell',
  AS8386: 'Vodafone',
  AS15924: 'Vodafone Net',
  AS15897: 'Vodafone Mobile',
  AS34984: 'Superonline/Tellcom',
  AS12735: 'TurkNet',
  AS197328: 'Millenicom',
  AS206991: 'NGN',
};

const UA = 'OneView/2.0 (camera mapper)';

async function getJson(url: string, timeoutMs = 20000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function ripeTrV4Prefixes(): Promise<string[]> {
  try {
    const data = (await getJson(`${RIPE}/country-resource-list/data.json?resource=TR`)) as {
      data?: { resources?: { ipv4?: string[] } };
    };
    return data?.data?.resources?.ipv4 || [];
  } catch {
    return [];
  }
}

export async function ripeTrAsns(): Promise<string[]> {
  try {
    const data = (await getJson(`${RIPE}/asns/data.json?resource=TR`)) as {
      data?: { asns?: string[] };
    };
    return data?.data?.asns || [];
  } catch {
    return [];
  }
}

export async function ripeAsnPrefixes(asn: string): Promise<string[]> {
  try {
    const data = (await getJson(`${RIPE}/announced-prefixes/data.json?resource=${encodeURIComponent(asn)}`)) as {
      data?: { prefixes?: Array<{ prefix?: string }> };
    };
    return (data?.data?.prefixes || [])
      .map((p) => p.prefix)
      .filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

// --- CIDR → IP aralığı yardımcıları ---------------------------------------

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function prefixToRange(cidr: string): { start: number; end: number } {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipn = ipToInt(ip);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const start = (ipn & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

export function prefixCount(cidr: string): number {
  const { start, end } = prefixToRange(cidr);
  return end - start + 1;
}

// --- Taranabilir kuyruk ----------------------------------------------------

export interface ScanRange {
  cidr: string;
  asn: string;
  priority: number;
  density: number;
}

export class ScanQueue {
  private ranges: ScanRange[] = [];
  private rangeIdx = 0;
  private cursor = -1;
  private cur: { start: number; end: number } | null = null;

  push(cidr: string, asn: string, priority = 2, density = 0): void {
    this.ranges.push({ cidr, asn, priority, density });
    // Sıra: önce öğrenilmiş İSABET YOĞUNLUĞU, sonra büyük aralık (residential), sonra küçük.
    this.ranges.sort(
      (a, b) => a.priority - b.priority || b.density - a.density || prefixCount(b.cidr) - prefixCount(a.cidr),
    );
  }

  get size(): number {
    return this.ranges.length;
  }

  get totalRange(): number {
    let total = 0;
    for (const r of this.ranges) total += prefixCount(r.cidr);
    return total;
  }

  // ⚠️ ARTIK CIDR ile konumlanır (index DEĞİL): kuyruk her döngüde yoğunluğa/
  // "ölü prefix" durumuna göre YENİDEN SIRALANIYOR. Eskiden index'e güveniliyordu →
  // sıra değişince imleç başka prefix'e uygulanıyor, next() milyarlarca IP'lik
  // sapma yapıyor ve tarama aynı bloğa KİLİTLENİYORDU (uzun koşuda 0 yeni kamera).
  getPosition(): { cidr: string; cursor: number } {
    const r = this.ranges[this.rangeIdx];
    return { cidr: r ? r.cidr : '', cursor: this.cursor };
  }

  restore(pos: { cidr?: string; cursor: number }): void {
    const ip = Number.isFinite(pos?.cursor) ? pos.cursor : -1;
    let idx = -1;
    if (pos?.cidr) idx = this.ranges.findIndex((r) => r.cidr === pos.cidr);
    if (idx < 0 && ip >= 0) {
      idx = this.ranges.findIndex((r) => {
        const { start, end } = prefixToRange(r.cidr);
        return ip >= start && ip <= end;
      });
    }
    if (idx < 0) idx = 0;
    this.rangeIdx = Math.min(idx, this.ranges.length);
    if (this.rangeIdx < this.ranges.length) {
      const { start, end } = prefixToRange(this.ranges[this.rangeIdx].cidr);
      this.cur = { start, end };
      // SINIRLA: cursor aralığın dışındaysa kırp → prefix ıskalama/sapma olmaz.
      this.cursor = Math.max(start - 1, Math.min(ip, end));
    } else {
      this.cur = null;
      this.cursor = -1;
    }
  }

  // Kuyruk bitti → baştan başla (IP'ler TEKRAR taransın).
  reset(): void {
    this.rangeIdx = 0;
    this.cursor = -1;
    this.cur = null;
    this.loadCurrent();
  }

  get pending(): number {
    let total = 0;
    for (let i = 0; i < this.ranges.length; i++) {
      const { start, end } = prefixToRange(this.ranges[i].cidr);
      if (i < this.rangeIdx) continue;
      if (i === this.rangeIdx && this.cur) {
        total += end - this.cursor;
      } else {
        total += end - start + 1;
      }
    }
    return total;
  }

  next(n: number): string[] {
    const out: string[] = [];
    if (this.cur === null && this.rangeIdx < this.ranges.length) this.loadCurrent();
    while (out.length < n && this.cur !== null) {
      if (this.cursor >= this.cur.end) {
        this.rangeIdx += 1;
        this.loadCurrent();
        continue;
      }
      this.cursor += 1;
      out.push(intToIp(this.cursor));
    }
    return out;
  }

  private loadCurrent(): void {
    if (this.rangeIdx >= this.ranges.length) {
      this.cur = null;
      return;
    }
    const { start, end } = prefixToRange(this.ranges[this.rangeIdx].cidr);
    this.cur = { start, end };
    this.cursor = start - 1;
  }
}

export async function buildScanQueue(
  hitIps: string[] = [],
  scanCounts: Map<number, number> = new Map(),
): Promise<ScanQueue> {
  const q = new ScanQueue();
  const seen = new Set<string>();

  // ÖĞRENME: daha önce kamera/erişim veren /16'lar → isabet yoğunluğu haritası.
  const hits = new Map<number, number>();
  for (const ip of hitIps) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || !p.every((n) => Number.isFinite(n))) continue;
    const key = ((p[0] << 8) | p[1]) >>> 0;
    hits.set(key, (hits.get(key) || 0) + 1);
  }

  // SADECE Türkiye'nin kayıtlı v4 uzayı (RIPE country-resource-list = TR).
  // ASN announced-prefixes KALDIRILDI: Türk ASN'lerin yurt dışı ilanları
  // (transit/leased) yabancı IP sokuyordu (ör. 91.177.x = Belçika/Rusya).
  const all = await ripeTrV4Prefixes();
  for (const p of all) {
    if (seen.has(p)) continue;
    seen.add(p);
    const { start, end } = prefixToRange(p);
    let h = 0;
    let sc = 0;
    const s16 = start >>> 16;
    const e16 = end >>> 16;
    for (let k = s16; k <= e16 && k - s16 < 8192; k++) {
      h += hits.get(k) || 0;
      sc += scanCounts.get(k) || 0;
    }
    const size = end - start + 1;
    const density = h === 0 ? 0 : (h / size) * 1e6; // isabet / milyon IP
    // COOLDOWN (C): taranmış ama hiç isabet vermemiş prefix → en sona atılır.
    const dead = h === 0 && sc >= 256;
    q.push(p, 'TR', 1, dead ? -1 : density);
  }

  return q;
}
