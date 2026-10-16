// ---------------------------------------------------------------------------
// V2 — İç zamanlayıcı.
//
// C2 yok, VPS yok. Tek main-thread scheduler. setInterval yığını yerine
// task registry + tek setTimeout döngüsü. Her task'ın interval ve next-run
// değeri var; çakışan task'lar sırayla koşar.
// ---------------------------------------------------------------------------

export type TaskFn = () => Promise<void>;

interface ScheduledTask {
  id: string;
  fn: TaskFn;
  intervalMs: number;
  nextRun: number;
  running: boolean;
}

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  register(id: string, fn: TaskFn, intervalMs: number, runImmediately = false): void {
    this.tasks.set(id, {
      id,
      fn,
      intervalMs,
      nextRun: runImmediately ? Date.now() : Date.now() + intervalMs,
      running: false,
    });
    this.kick();
  }

  unregister(id: string): void {
    this.tasks.delete(id);
  }

  async runNow(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (!t || t.running) return;
    t.running = true;
    try {
      await t.fn();
    } catch (err) {
      console.error(`[Scheduler] task ${id} failed:`, err);
    } finally {
      t.running = false;
      t.nextRun = Date.now() + t.intervalMs;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private kick(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), 1000);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;

    const now = Date.now();
    const due = [...this.tasks.values()].filter((t) => !t.running && now >= t.nextRun);

    for (const t of due) {
      t.running = true;
      void (async () => {
        try {
          await t.fn();
        } catch (err) {
          console.error(`[Scheduler] task ${t.id} failed:`, err);
        } finally {
          t.running = false;
          t.nextRun = Date.now() + t.intervalMs;
        }
      })();
    }

    this.kick();
  }
}
