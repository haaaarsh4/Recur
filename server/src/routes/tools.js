import { Router } from "express";
import { db, syncToolCopy } from "../db.js";
import { profileTask } from "../embeddings.js";

const router = Router();

// Public on purpose: the compiled-tool registry is shared, and showing real
// numbers before someone logs in is the point (see the landing cards).
// The registry lists every program that was ever compiled, including the ones a
// later compilation replaced. Reading deletes nothing: one program per family is
// already guaranteed when a program is compiled, and a superseded program is the
// record of what the family used to be. It does keep each row's copy in step
// with the program behind it, so a description can never outlive the thing it
// describes.
router.get("/", async (req, res) => {
  await db.read();
  let changed = false;
  for (const tool of db.data.tools) {
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    if (syncToolCopy(tool, profile)) changed = true;
  }
  if (changed) await db.write();
  const tools = [...db.data.tools].sort((a, b) => (b.executions || 0) - (a.executions || 0));
  res.json(tools);
});

// Deleting is public for the same reason reading is: this is one shared registry
// that anybody browsing it can already compile a program into, not a personal
// collection, so a row cannot be offered with a button that only works for some
// visitors. Clearing it removes the programs, the observations waiting to be
// compiled, and the execution log those numbers were measured from.
router.delete("/", async (req, res) => {
  await db.read();
  const removed = db.data.tools.length;
  db.data.tools = [];
  db.data.pending = [];
  db.data.log = [];
  await db.write();
  res.json({ ok: true, removed });
});

// One program, addressed by the id the registry listed (its name works too, so a
// row can be deleted by the thing it displays). The execution log entries for it
// go with it: the reuse numbers describe the programs that exist, and a deleted
// program is not answering anything.
router.delete("/:id", async (req, res) => {
  await db.read();
  const wanted = String(req.params.id);
  const index = db.data.tools.findIndex((tool) => tool.id === wanted || tool.name === wanted);
  if (index === -1) return res.status(404).json({ error: "That program is no longer in the registry." });
  const [removed] = db.data.tools.splice(index, 1);
  db.data.log = db.data.log.filter((entry) => entry.toolId !== removed.id);
  await db.write();
  res.json({ ok: true, removed: removed.name });
});

export default router;
