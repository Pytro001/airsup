import { runJobPollOnce } from "./poll.js";

const POLL_INTERVAL = 15_000;

async function poll(): Promise<void> {
  try {
    await runJobPollOnce();
  } catch (err) {
    console.error("[Worker] poll error:", err);
  }
}

export function startWorker(): void {
  console.log(`[Worker] Starting job poller (every ${POLL_INTERVAL / 1000}s)`);
  poll();
  setInterval(poll, POLL_INTERVAL);
}
