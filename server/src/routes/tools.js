import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db.js";

const router = Router();

// Public on purpose: the compiled-tool registry is shared, and showing real
// numbers before someone logs in is the point (see the landing cards).
router.get("/", async (req, res) => {
  await db.read();
  const tools = [...db.data.tools].sort((a, b) => (b.executions || 0) - (a.executions || 0));
  res.json(tools);
});

router.delete("/", requireAuth, async (req, res) => {
  await db.read();
  db.data.tools = [];
  db.data.pending = [];
  db.data.log = [];
  await db.write();
  res.json({ ok: true });
});

export default router;
