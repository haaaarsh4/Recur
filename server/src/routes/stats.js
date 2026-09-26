import { Router } from "express";
import { db } from "../db.js";

const router = Router();

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
  const compiledTools = db.data.tools.filter((t) => t.program);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

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
