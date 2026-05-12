import { runJobPollOnce } from "./poll.js";
import { tickColdLoop } from "./cold-loop.js";

const POLL_INTERVAL = 15_000;

let lastDigestDate = "";

async function poll(): Promise<void> {
  try {
    await runJobPollOnce();
  } catch (err) {
    console.error("[Worker] poll error:", err);
  }

  try {
    await tickColdLoop();
  } catch (err) {
    console.error("[Worker] cold-loop error:", err);
  }

  // Daily digest at 9:00 local server time
  const now = new Date();
  const dateKey = now.toISOString().split("T")[0];
  if (now.getHours() === 9 && lastDigestDate !== dateKey) {
    lastDigestDate = dateKey;
    try {
      const { triggerSkill } = await import("../skills/index.js");
      await triggerSkill("daily-digest", {});
    } catch (err) {
      console.error("[Worker] daily-digest error:", err);
    }
  }
}

export function startWorker(): void {
  console.log(`[Worker] Starting job poller (every ${POLL_INTERVAL / 1000}s)`);
  poll();
  setInterval(poll, POLL_INTERVAL);
}
