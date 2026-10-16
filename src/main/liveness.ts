import { StreamEngine } from './stream';
import { CameraRegistry, RegisteredCamera } from './registry';

export class LivenessMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private backoff = new Map<string, number>();
  private readonly intervalMs = 60_000;
  private readonly concurrency = 16;

  constructor(private registry: CameraRegistry, private engine: StreamEngine) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async checkNow(): Promise<void> {
    await this.checkBatch(this.registry.all());
    this.registry.save();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const due = this.registry.all().filter((c) => {
      const next = this.backoff.get(c.id) || 0;
      return now >= next;
    });
    if (due.length > 0) {
      await this.checkBatch(due);
      this.registry.save();
    }
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  private async checkBatch(cameras: RegisteredCamera[]): Promise<void> {
    let idx = 0;
    const workers = Array.from({ length: this.concurrency }, async () => {
      while (idx < cameras.length) {
        const cam = cameras[idx++];
        if (cam.protocol === 'demo' || cam.source === 'seed') continue;
        const start = Date.now();
        const online = await this.engine.probe(cam.url, 2500);
        const now = Date.now();

        if (online) {
          this.registry.update(cam.id, { status: 'online', verified: true, lastSeen: now, latencyMs: now - start });
          this.backoff.set(cam.id, now + this.intervalMs);
        } else {
          this.registry.update(cam.id, { status: 'offline', verified: false, lastSeen: now, latencyMs: null });
          const next = this.backoff.get(cam.id) || 0;
          const level = Math.min(Math.floor((now - next) / this.intervalMs) + 1, 8);
          this.backoff.set(cam.id, now + this.intervalMs * Math.max(level, 1));
        }
      }
    });
    await Promise.all(workers);
  }
}
