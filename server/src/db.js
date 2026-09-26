import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { profileTask } from "./embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// db.json is gitignored, so fresh deploys do not have the data directory at
// all. lowdb writes through a .tmp sibling file, so the directory has to exist
// and be writable before anything tries to save, or every request would fail
// with ENOENT or EACCERO. Serverless hosts such as Vercel mount the project
// bundle read-only and leave the system temp directory as the only writable
// place, so fall back to it.
function resolveDbFile() {
  if (process.env.RECUR_DB_PATH) return path.resolve(process.env.RECUR_DB_PATH);
  const inTemp = path.join(os.tmpdir(), "recur-data", "db.json");
  // A Vercel function mounts the project bundle read-only and leaves /tmp as
  // the only writable place, so go straight there instead of attempting a
  // write that is guaranteed to fail.
  const candidates = process.env.VERCEL
    ? [inTemp]
    : [path.join(__dirname, "..", "data", "db.json"), inTemp];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch {
      // Not writable here, so try the next location.
    }
  }
  throw new Error("Recur found no writable directory for its database. Set RECUR_DB_PATH to a writable path.");
}

const file = resolveDbFile();

const defaultData = {
  users: [],   // { id, email, passwordHash, name, createdAt }
  chats: [],   // { id, userId, guest, title, messages:[], awaiting, createdAt, updatedAt }
  tools: [],   // compiled programs: { id, name, specification, program, tests, metrics, neural, executions, totalLatencyMs }
  pending: [], // { id, text, profile, vector, output, createdAt }
  log: [],     // { id, type: 'hit'|'general', toolId?, toolName?, latencyMs, ts }
};

const adapter = new JSONFile(file);
const db = new Low(adapter, defaultData);

function inferredLegacySpecification(tool, profile) {
  const source = (tool.sourceTasks || []).join(" ").toLowerCase();
  const subject = (profile.keywords || []).find((keyword) => !/^(?:what|whats|is|the|a|an|number|numbers|series|sequence|nth|th|st|nd|rd|of|in|for|and|please|tell|me|does|do|calculate|calculate|find|give|my|your|this|that|task|request)$/.test(keyword) && !/^[0-9]/.test(keyword));
  if (/\b(?:series|sequence)\b/.test(source) && subject) return `Determine the nth ${subject} number in a series.`;
  return `Perform the recurring ${profile.operation || "task"} computation in the ${profile.domain || "general"} domain.`;
}

// Registry copy is generated from the artifact itself, so what the registry says
// about a program is always what the program really is.
function registryDescription(tool, profile) {
  const metrics = tool.metrics || {};
  const tests = (tool.tests || []).length;
  const path = tool.summary?.path || (tool.listing || []).join(" → ");
  const kind = tool.program
    ? tool.summary?.family === "table"
      ? "a verified lookup compiled from your own confirmed answers"
      : "an executable program compiled from your own confirmed answers"
    : "a legacy contract saved before programs were compiled, so it cannot run";
  const evidence = tests
    ? ` It was compiled from ${tests} verified demonstration${tests === 1 ? "" : "s"}, reproduces ${metrics.reproduced ?? tests}/${metrics.demonstrations ?? tests} of them exactly, and declines inputs its rules do not cover instead of guessing.`
    : " It holds no verified demonstrations yet.";
  const flow = path ? ` The compiled path is: ${path}.` : "";
  const operation = profile?.operation ? ` Task family: ${profile.operation} (${profile.domain}).` : "";
  const runtime = tool.program ? " It executes locally and deterministically, with no model call at reuse time." : "";
  return `This tool is ${kind}.${evidence}${flow}${operation}${runtime}`;
}

async function init() {
  await db.read();
  let changed = false;
  if (!db.data) {
    db.data = structuredClone(defaultData);
    changed = true;
  }
  for (const key of Object.keys(defaultData)) {
    if (!Array.isArray(db.data[key])) {
      db.data[key] = [];
      changed = true;
    }
  }
  // Never keep a tool that was created from the old prompt placeholder. It is
  // not a usable program and would otherwise win future similarity matches.
  const beforeTools = db.data.tools.length;
  db.data.tools = db.data.tools.filter((tool) => {
    const name = String(tool.name || "").toLowerCase();
    if (!name || /(?:kebab-case-name|semantic-kebab-name|placeholder)/.test(name)) return false;
    const seenInputs = new Set();
    for (const example of tool.tests || tool.examples || []) {
      const input = String(example.input || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!input || seenInputs.has(input)) return false;
      seenInputs.add(input);
    }
    return true;
  });
  if (db.data.tools.length !== beforeTools) changed = true;
  // Observations without a recorded answer can never be evidence for a program:
  // there is nothing to reproduce. Older builds stored repetition counters with
  // no answers at all, and keeping them only pollutes the next cluster.
  const beforePending = db.data.pending.length;
  db.data.pending = db.data.pending.filter((pending) => String(pending?.output || "").trim());
  if (db.data.pending.length !== beforePending) changed = true;
  // Keep one canonical program per task family. Older versions could compile
  // the same family twice when their fingerprint matcher missed a paraphrase.
  const canonical = new Map();
  for (const tool of db.data.tools) {
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    const canonicalName = String(tool.name || "").toLowerCase().replace(/-(?:number|sequence|checker|detector|classifier|program)$/, "");
    const key = canonicalName || profile.fingerprint || tool.name;
    const previous = canonical.get(key);
    if (!previous || (tool.executions || 0) > (previous.executions || 0)) canonical.set(key, tool);
  }
  const dedupedTools = [...canonical.values()];
  if (dedupedTools.length !== db.data.tools.length) changed = true;
  db.data.tools = dedupedTools;
  for (const tool of db.data.tools) {
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    if (profile.meaningful && JSON.stringify(tool.profile) !== JSON.stringify(profile)) {
      tool.profile = profile;
      changed = true;
    }
    // Tools saved by the earlier prompt-based compiler hold no program. They are
    // kept visible for history but marked so nothing can execute them.
    if (!tool.program || !tool.program.version) {
      if (tool.status !== "legacy") {
        tool.status = "legacy";
        changed = true;
      }
      if (/^(?:handles recurring|performs the recurring)/i.test(String(tool.specification || "")) || /\b\d+(?:st|nd|rd|th)\b.*\b(?:is|equals)\b/i.test(String(tool.specification || ""))) {
        tool.specification = inferredLegacySpecification(tool, profile);
        changed = true;
      }
      delete tool.dataset;
      delete tool.trainingStatus;
    }
    const description = registryDescription(tool, profile);
    if (tool.description !== description) {
      tool.description = description;
      changed = true;
    }
  }
  // Hide responses produced by the broken prompt-wrapper version. Keeping those
  // messages visible makes an otherwise repaired chat look broken forever.
  for (const chat of db.data.chats) {
    for (const message of chat.messages || []) {
      if (message.role === "assistant" && /(?:apply the contract|new request:|verified behavior examples|kebab-case-name-2-to-4-words)/i.test(String(message.text || ""))) {
        message.text = "The previous reusable-program execution was invalid. This response was removed; retry the request to run the repaired pipeline.";
        message.viaTool = null;
        changed = true;
      }
      if (message.kind === "compiled_notice" && /(?:kebab-case-name|semantic-kebab-name|placeholder)/i.test(String(message.toolName || ""))) {
        message.toolName = "invalid-program-removed";
        changed = true;
      }
    }
  }
  // Only hit the disk when something actually needed fixing. Writing on every
  // boot makes file-watching dev tools think the project changed and restart
  // the server in a loop.
  if (changed) await db.write();
}

export { db, init, registryDescription, inferredLegacySpecification, file as dbFile };
