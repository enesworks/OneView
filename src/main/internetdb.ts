// InternetDB — Shodan'ın ÜCRETSİZ, API anahtarı GEREKTİRMEYEN per-IP servisi.
// Bulunan bir IP'nin TÜM açık portlarını ve bilinen zafiyetlerini döner.
// Aktif tarama 554 için açık bulduysa, buradan 8000/37777/80 gibi kaçan portlar çıkar.

export interface InternetDbInfo {
  ip: string;
  ports: number[];
  vulns: string[];
  tags: string[];
  hostnames: string[];
}

export async function internetDb(ip: string, timeoutMs = 6000): Promise<InternetDbInfo | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'OneView/2.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = (await res.json()) as { ports?: number[]; vulns?: string[]; tags?: string[]; hostnames?: string[] };
    return {
      ip,
      ports: Array.isArray(j.ports) ? j.ports : [],
      vulns: Array.isArray(j.vulns) ? j.vulns : [],
      tags: Array.isArray(j.tags) ? j.tags : [],
      hostnames: Array.isArray(j.hostnames) ? j.hostnames : [],
    };
  } catch {
    return null;
  }
}
