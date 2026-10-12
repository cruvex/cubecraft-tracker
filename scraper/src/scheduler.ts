import { Cron } from "croner";

export type TaskContext = {
  firedAt: Date;
  // Aborts on timeout and on shutdown.
  signal: AbortSignal;
};

export type Task = {
  name: string;
  schedule: string;
  // Keep under the schedule interval.
  timeoutMs: number;
  run(ctx: TaskContext): Promise<void>;
};

// A skip keeps the previous state, a timeout is just a failure, and a shutdown abort is never read.
export type TaskState = {
  status: "pending" | "running" | "ok" | "failed";
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type TaskSnapshot = TaskState & {
  schedule: string;
  nextRunAt: string | null;
};

type Outcome = { ran: true; error: unknown } | { ran: false };

type Entry = {
  task: Task;
  job: Cron;
  state: TaskState;
  // At most one: croner drops a trigger that would overlap this run.
  inFlight: Promise<void> | null;
};

export class Scheduler {
  #tasks = new Map<string, Entry>();
  #shutdown = new AbortController();

  constructor(tasks: Task[]) {
    for (const task of tasks) {
      if (this.#tasks.has(task.name)) {
        throw new Error(`Duplicate task name: ${task.name}`);
      }

      const job = new Cron(
        task.schedule,
        {
          name: task.name,
          // Resumed in start(), so a bad pattern later in the list cannot leave earlier tasks firing.
          paused: true,
          // Drop the trigger rather than stack a second copy on a slow run.
          protect: () =>
            console.warn(`[${task.name}] still running, skipping this trigger`),
        },
        // Croner passes the job, not the trigger time, so it is taken here.
        () => this.#run(task.name, new Date()),
      );

      this.#tasks.set(task.name, {
        task,
        job,
        inFlight: null,
        state: {
          status: "pending",
          lastRunAt: null,
          lastOkAt: null,
          lastDurationMs: null,
          lastError: null,
          consecutiveFailures: 0,
        },
      });
    }
  }

  start(): void {
    for (const { task, job } of this.#tasks.values()) {
      job.resume();
      console.log(
        `[${task.name}] scheduled '${task.schedule}', next run ${iso(job.nextRun())}`,
      );
    }
  }

  // Kept under Railway's ~30s SIGTERM-to-kill window.
  async stop(graceMs = 20_000): Promise<void> {
    for (const { job } of this.#tasks.values()) job.stop();
    this.#shutdown.abort(new Error("Scheduler is shutting down"));

    const running = [...this.#tasks.values()].flatMap((e) => e.inFlight ?? []);
    if (running.length === 0) return;

    console.log(`Waiting up to ${graceMs / 1000}s for ${running.length} running task(s)`);
    await Promise.race([Promise.allSettled(running), Bun.sleep(graceMs)]);
  }

  snapshot(): Record<string, TaskSnapshot> {
    return Object.fromEntries(
      [...this.#tasks].map(([name, { task, job, state }]) => [
        name,
        { ...state, schedule: task.schedule, nextRunAt: iso(job.nextRun()) },
      ]),
    );
  }

  #run(name: string, firedAt: Date): Promise<void> {
    // Only reachable through a job this scheduler built.
    const entry = this.#tasks.get(name)!;

    // Held so stop() can wait it out; #execute never rejects.
    const promise = this.#execute(entry, firedAt);
    entry.inFlight = promise;

    return promise.finally(() => {
      entry.inFlight = null;
    });
  }

  async #execute({ task, state }: Entry, firedAt: Date): Promise<void> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(task.timeoutMs),
      this.#shutdown.signal,
    ]);
    const started = Bun.nanoseconds();

    update(state, { status: "running", lastRunAt: firedAt.toISOString() });
    console.log(`[${task.name}] started`);

    // Raced rather than left to the signal: Bun's SQL client ignores it. Rejection becomes a value to stay handled.
    const work: Promise<Outcome> = task.run({ firedAt, signal }).then(
      () => ({ ran: true, error: null }),
      (error: unknown) => ({ ran: true, error: error ?? new Error(`${task.name} rejected`) }),
    );

    const outcome = await Promise.race([work, expiry(signal)]);

    if (!outcome.ran) {
      const shuttingDown = this.#shutdown.signal.aborted;

      // Not recorded on shutdown: the run did not fail, and nothing will read it.
      if (!shuttingDown) fail(state, started, `Exceeded ${task.timeoutMs}ms timeout`);

      console.error(
        `[${task.name}] ${shuttingDown ? "aborted" : "timed out"} after ` +
          `${secs(started)}s, still unwinding`,
      );

      // Left in flight on purpose: croner's overrun protection then drops the next trigger.
      await work;
      console.warn(`[${task.name}] unwound at ${secs(started)}s`);
      return;
    }

    if (outcome.error === null) {
      update(state, {
        status: "ok",
        lastOkAt: new Date().toISOString(),
        lastDurationMs: elapsed(started),
        lastError: null,
        consecutiveFailures: 0,
      });

      console.log(`[${task.name}] ok in ${secs(started)}s`);
      return;
    }

    // Nothing rethrows: one failing task must not stop the others being scheduled.
    fail(state, started, describe(outcome.error));
    console.error(`[${task.name}] failed after ${secs(started)}s`, outcome.error);
  }
}

// Typed so a mistyped key is a compile error, not a stray property.
function update(state: TaskState, patch: Partial<TaskState>): void {
  Object.assign(state, patch);
}

function fail(state: TaskState, startedAtNs: number, error: string): void {
  update(state, {
    status: "failed",
    lastDurationMs: elapsed(startedAtNs),
    lastError: error,
    consecutiveFailures: state.consecutiveFailures + 1,
  });
}

function expiry(signal: AbortSignal): Promise<Outcome> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ ran: false });
    else signal.addEventListener("abort", () => resolve({ ran: false }), { once: true });
  });
}

function elapsed(startedAtNs: number): number {
  return Math.round((Bun.nanoseconds() - startedAtNs) / 1_000_000);
}

function secs(startedAtNs: number): string {
  return (elapsed(startedAtNs) / 1000).toFixed(1);
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
