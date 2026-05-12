/**
 * Cold outreach orchestration loop.
 *
 * Cadence (per tick — driven from worker.ts):
 *   - reply check:   every tick (poll IMAP)
 *   - outreach send: every 30 min, gated by COLD_DAILY_LIMIT
 *   - discovery:     every 4 hours
 *   - quality:       every hour (works through 'discovered' backlog)
 *   - conversion reconcile: every hour
 *
 * Off by default — set COLD_OUTREACH_ENABLED=1 in env to turn on.
 */

import { runColdDiscovery } from "../agents/cold-discovery.js";
import { runColdQuality } from "../agents/cold-quality.js";
import { runColdOutreach } from "../agents/cold-outreach.js";
import { runColdReply, reconcileConversions } from "../agents/cold-reply.js";

let lastDiscovery = 0;
let lastQuality = 0;
let lastOutreach = 0;
let lastReconcile = 0;

const HOUR = 60 * 60 * 1000;

export async function tickColdLoop(): Promise<void> {
  if (process.env.COLD_OUTREACH_ENABLED !== "1") return;

  const now = Date.now();

  // Inbound replies — every tick.
  try {
    const n = await runColdReply();
    if (n) console.log(`[cold] processed ${n} inbound`);
  } catch (err) {
    console.error("[cold] reply tick failed:", err);
  }

  // Outreach send — every 30 min.
  if (now - lastOutreach > 30 * 60 * 1000) {
    lastOutreach = now;
    try {
      const n = await runColdOutreach(10);
      if (n) console.log(`[cold] sent ${n} outbound`);
    } catch (err) {
      console.error("[cold] outreach tick failed:", err);
    }
  }

  // Quality — hourly.
  if (now - lastQuality > HOUR) {
    lastQuality = now;
    try {
      const r = await runColdQuality(15);
      if (r.qualified || r.disqualified)
        console.log(`[cold] quality: +${r.qualified} qualified, +${r.disqualified} disqualified`);
    } catch (err) {
      console.error("[cold] quality tick failed:", err);
    }
  }

  // Discovery — every 4h.
  if (now - lastDiscovery > 4 * HOUR) {
    lastDiscovery = now;
    try {
      const n = await runColdDiscovery();
      if (n) console.log(`[cold] discovered ${n} new targets`);
    } catch (err) {
      console.error("[cold] discovery tick failed:", err);
    }
  }

  // Conversion reconcile — hourly.
  if (now - lastReconcile > HOUR) {
    lastReconcile = now;
    try {
      const n = await reconcileConversions();
      if (n) console.log(`[cold] ${n} targets converted`);
    } catch (err) {
      console.error("[cold] reconcile tick failed:", err);
    }
  }
}
