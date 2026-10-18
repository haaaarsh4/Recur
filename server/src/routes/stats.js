import { Router } from "express";
import { db } from "../db.js";
import { identity } from "../middleware/auth.js";

const router = Router();

// The numbers are the same for everyone, but the identity is still resolved:
// every response a page load gets back should name the same visitor, so the
// browser cannot end up holding a different guest than the chat it was shown.
router.use(identity);

// Public on purpose: these are aggregate, non-personal numbers, same reasoning
// as tools.js.
router.get("/", async (req, res) => {
  await db.read();
  const log = db.data.log;
  const total = log.length;
  // "program" is a compiled-program execution; "hit" is the earlier name for the
  // same event, kept so historical numbers still add up.
  const isProgramRun = (l) => l.type === "program" || l.type === "hit";
  const hits = log.filter(isProgramRun).length;
  const hitLat = log.filter(isProgramRun).map((l) => l.latencyMs);
  const genLat = log.filter((l) => l.type === "general").map((l) => l.latencyMs);
  // Same set the registry calls live: a program that a later compilation
  // replaced is history, and a legacy contract holds nothing executable, so
  // neither counts as a program doing work here.
  const compiledTools = db.data.tools.filter((t) => t.program && t.status !== "superseded");
  // A locally executed program usually finishes in a fraction of a millisecond,
  // so the average keeps three decimals instead of rounding every run to zero.
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 1000) / 1000 : null);

  res.json({
    toolsCount: compiledTools.length,
    totalTasks: total,
    hits,
    reuseRate: total ? Math.round((hits / total) * 100) : null,
    avgToolLatencyMs: avg(hitLat),
    avgGeneralLatencyMs: avg(genLat),
  });
});

export default router;
