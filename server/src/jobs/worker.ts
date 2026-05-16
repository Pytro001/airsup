import { runJobPollOnce } from "./poll.js";
import { tickColdLoop } from "./cold-loop.js";
import { runXPoster, runXReplier } from "./x-automation.js";

const POLL_INTERVAL = 15_000;
const POST_INTERVAL_MS = 2 * 60 * 60 * 1000;   // every 2h
const REPLY_INTERVAL_MS = 30 * 60 * 1000;       // every 30min

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

  if (process.env.X_API_KEY) {
    console.log("[Worker] X automation enabled");
    runXPoster().catch(err => console.error("[XPoster] Initial run failed:", err.message));
    setInterval(() => {
      runXPoster().catch(err => console.error("[XPoster] Error:", err.message));
    }, POST_INTERVAL_MS);
    setInterval(() => {
      runXReplier().catch(err => console.error("[XReplier] Error:", err.message));
    }, REPLY_INTERVAL_MS);
  } else {
    console.log("[Worker] X automation disabled (X_API_KEY not set)");
  }
}
