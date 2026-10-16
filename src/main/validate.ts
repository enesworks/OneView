const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface LiveProof {
  ok: boolean;
  latencyMs: number;
  kind: string;
}

async function timed(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function drain(stream: ReadableStream<Uint8Array> | null, minBytes = 1): Promise<number> {
  if (!stream) return 0;
  const reader = stream.getReader();
  try {
    const { value } = await reader.read();
    return value ? value.byteLength : 0;
  } catch {
    return 0;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function proveLive(url: string, protocol: string, timeoutMs = 6000): Promise<LiveProof> {
  const t0 = Date.now();
  if (!url) return { ok: false, latencyMs: 0, kind: 'no-url' };
  if (protocol === 'rtsp') return { ok: true, latencyMs: 0, kind: 'rtsp-describe' };

  try {
    const res = await timed(url, timeoutMs);
    if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, kind: `http-${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (protocol === 'mjpeg' || ct.includes('multipart/x-mixed-replace')) {
      const bytes = await drain(res.body, 1);
      return { ok: bytes > 0, latencyMs: Date.now() - t0, kind: bytes > 0 ? 'mjpeg-flow' : 'mjpeg-empty' };
    }

    const isHls = protocol === 'hls' || ct.includes('mpegurl') || url.split('?')[0].toLowerCase().endsWith('.m3u8');
    if (isHls) {
      const text = await res.text();
      if (!text.includes('#EXTM3U')) return { ok: false, latencyMs: Date.now() - t0, kind: 'no-manifest' };
      const base = new URL(url);
      const refs = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

      if (refs.length === 0) return { ok: false, latencyMs: Date.now() - t0, kind: 'empty-manifest' };

      let flows = 0;
      for (const ref of refs.slice(-2)) {
        try {
          const child = new URL(ref, base).toString();
          const r2 = await timed(child, timeoutMs);
          if (!r2.ok) continue;
          const ct2 = (r2.headers.get('content-type') || '').toLowerCase();
          if (child.split('?')[0].toLowerCase().endsWith('.m3u8') || ct2.includes('mpegurl')) {
            const t2 = await r2.text();
            const segs = t2
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s && !s.startsWith('#'));
            if (segs.length >= 2) flows++;
          } else if ((await drain(r2.body, 1)) > 200) {
            flows++;
          }
        } catch {
          /* try next ref */
        }
      }
      return { ok: flows > 0, latencyMs: Date.now() - t0, kind: `hls-flow:${flows}` };
    }

    return {
      ok: ct.includes('video/') || ct.includes('image/'),
      latencyMs: Date.now() - t0,
      kind: ct || 'unknown',
    };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0, kind: 'error' };
  }
}

export async function validateStream(url: string, protocol: string, timeoutMs = 6000): Promise<boolean> {
  return (await proveLive(url, protocol, timeoutMs)).ok;
}

export async function validateBatch<T extends { url: string; protocol: string }>(
  items: T[],
  concurrency = 8,
): Promise<T[]> {
  const out: T[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (idx < items.length) {
      const it = items[idx++];
      try {
        if (await validateStream(it.url, it.protocol)) out.push(it);
      } catch {
        /* skip invalid */
      }
    }
  });
  await Promise.all(workers);
  return out;
}
