import { startHealthServer } from "./health";
import { Scheduler } from "./scheduler";
import { cubecraft } from "./tasks/cubecraft";
import { serverStatus } from "./tasks/server-status";

// Scheduling lives here because Railway cron cannot run more often than every 5 minutes.

// Checked at boot rather than on the first run, which could be minutes away.
for (const name of ["DATABASE_URL", "MC_USERNAME"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
}

const scheduler = new Scheduler([cubecraft, serverStatus]);
scheduler.start();

const health = startHealthServer(scheduler);

let stopping = false;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;

    console.log(`${signal} received, shutting down`);
    await health.stop();
    await scheduler.stop();
    process.exit(0);
  });
}

// Logged but not fatal: killing the process would take every other task down with it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Unknown state after this, so let Railway restart rather than keep scheduling on top of it.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, exiting:", err);
  process.exit(1);
});
