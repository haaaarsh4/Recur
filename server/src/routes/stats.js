import { Router } from "express";
import { db } from "../db.js";

const router = Router();

// Public on purpose: these are aggregate, non-personal numbers, same reasoning
// as tools.js.
router.get("/", async (req, res) => {
  await db.read();
  const log = db.data.log;
  const total = log.length;
  const hits = log.filter((l) => l.type === "hit").length;
  const hitLat = log.filter((l) => l.type === "hit").map((l) => l.latencyMs);
  const genLat = log.filter((l) => l.type === "general").map((l) => l.latencyMs);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

  res.json({
    toolsCount: db.data.tools.length,
    totalTasks: total,
    hits,
    reuseRate: total ? Math.round((hits / total) * 100) : null,
    avgToolLatencyMs: avg(hitLat),
    avgGeneralLatencyMs: avg(genLat),
  });
});

export default router;
