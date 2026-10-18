import { Router } from "express";
import { db, syncToolCopy } from "../db.js";
import { profileTask } from "../embeddings.js";
import { identity } from "../middleware/auth.js";

const router = Router();

// The registry is one shared library, so every visitor needs an identity even
// though reading it needs no account: that identity is what makes clearing it
// personal instead of destructive.
router.use(identity);

function hiddenSet(ownerId) {
  return new Set((db.data.hidden || []).filter((row) => row.ownerId === ownerId).map((row) => row.toolId));
}

// Public on purpose: the compiled-tool registry is shared, and showing real
// numbers before someone logs in is the point (see the landing cards).
// The registry lists every program that was ever compiled, including the ones a
// later compilation replaced. Reading deletes nothing: one program per family is
// already guaranteed when a program is compiled, and a superseded program is the
// record of what the family used to be. It does keep each row's copy in step
// with the program behind it, so a description can never outlive the thing it
// describes.
//
// What was cleared by this visitor is still listed, flagged so the client can
// put it behind a "show hidden" control. The programs themselves never leave the
// store for anyone else.
router.get("/", async (req, res) => {
  await db.read();
  let changed = false;
  for (const tool of db.data.tools) {
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    if (syncToolCopy(tool, profile)) changed = true;
  }
  if (changed) await db.write();
  const hidden = hiddenSet(req.ownerId);
  const tools = [...db.data.tools]
    .sort((a, b) => (b.executions || 0) - (a.executions || 0))
    .map((tool) => ({ ...tool, hiddenForYou: hidden.has(tool.id) }));
  res.json(tools);
});

// Clearing hides every program from the caller's own view. It is the "clear"
// people expect, without taking anything away from the visitors who did not ask:
// the programs, their evidence and their execution log all stay, and another
// visitor sees exactly the same registry as before.
router.delete("/", async (req, res) => {
  await db.read();
  const already = hiddenSet(req.ownerId);
  let hidden = 0;
  for (const tool of db.data.tools) {
    if (already.has(tool.id)) continue;
    db.data.hidden.push({ ownerId: req.ownerId, toolId: tool.id, ts: Date.now() });
    hidden += 1;
  }
  if (hidden) await db.write();
  res.json({ ok: true, hidden });
});

// Undo for the button above, so hiding is a view change and never a loss.
router.delete("/hidden", async (req, res) => {
  await db.read();
  const before = db.data.hidden.length;
  db.data.hidden = db.data.hidden.filter((row) => row.ownerId !== req.ownerId);
  if (db.data.hidden.length !== before) await db.write();
  res.json({ ok: true, restored: before - db.data.hidden.length });
});

// One program, addressed by the id the registry listed (its name works too, so a
// row can be hidden by the thing it displays). Nothing is removed from the
// store: this is the same personal hide as the clear above, for one row.
router.delete("/:id", async (req, res) => {
  await db.read();
  const wanted = String(req.params.id);
  const tool = db.data.tools.find((candidate) => candidate.id === wanted || candidate.name === wanted);
  if (!tool) return res.status(404).json({ error: "That program is no longer in the registry." });
  if (!hiddenSet(req.ownerId).has(tool.id)) {
    db.data.hidden.push({ ownerId: req.ownerId, toolId: tool.id, ts: Date.now() });
    await db.write();
  }
  res.json({ ok: true, hidden: tool.name });
});

export default router;
