import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, registryDescription } from "../db.js";
import { profileTask } from "../embeddings.js";

const router = Router();

// Public on purpose: the compiled-tool registry is shared, and showing real
// numbers before someone logs in is the point (see the landing cards).
router.get("/", async (req, res) => {
  await db.read();
  let changed = false;
  const byFamily = new Map();
  for (const tool of db.data.tools) {
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    const key = profile.fingerprint || tool.name;
    const description = registryDescription(tool, profile);
    if (tool.description !== description) {
      tool.description = description;
      changed = true;
    }
    const previous = byFamily.get(key);
    if (!previous || (tool.executions || 0) > (previous.executions || 0) || ((tool.dataset?.target || 0) > (previous.dataset?.target || 0))) byFamily.set(key, tool);
  }
  if (byFamily.size !== db.data.tools.length) {
    db.data.tools = [...byFamily.values()];
    changed = true;
  }
  if (changed) await db.write();
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
