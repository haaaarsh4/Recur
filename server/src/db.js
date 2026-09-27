import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { profileTask } from "./embeddings.js";
import { specificationFor, programListing, programPath, misdeclaredNumbers } from "./program.js";

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

// A legacy contract holds no program, so there is no computation to describe and
// its line has to be honest about what the saved request actually was. It is
// described by the request itself, or by the one property the request's own
// words state. Naming an internal operation instead would print a label like
// "ordinal-item" in front of the reader, which describes the compiler rather
// than the task.
function inferredLegacySpecification(tool, profile) {
  const examples = (tool.tests || tool.examples || []).filter((example) => example && String(example.input || "").trim());
  const source = ((tool.sourceTasks || []).map(String).join(" ") || String(examples[0]?.input || "")).toLowerCase();
  if (/\bpalindrom/.test(source)) return "Check whether a word reads the same forwards and backwards.";
  const first = String(examples[0]?.input || (tool.sourceTasks || [])[0] || "").trim();
  if (first) return `Answer requests like "${first.slice(0, 90)}".`;
  if (profile.domain && profile.domain !== "general") return `Answer a recurring ${profile.domain} request from an earlier build.`;
  return "Answer a recurring request from an earlier build.";
}

// Registry copy is generated from the artifact itself, so what the registry says
// about a program is always what the program really is.
function registryDescription(tool, profile) {
  if (tool.status === "superseded") {
    return `This tool was replaced by ${tool.supersededBy || "a later program"}: ${tool.supersededReason || "a later compilation covers this task family with better evidence"}. It stays in the registry as history and is never matched again.`;
  }
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

// Keeps the registry copy for one tool in step with the artifact it describes,
// and returns true when anything changed. Both the store at boot and the
// registry route go through here, so a stored program can never be described as
// something it is not, whichever path reads it first. Every sentence is built
// from the stored program's own operations, which is why this works the same way
// for every task rather than for the tasks somebody thought of.
function syncToolCopy(tool, profile) {
  let changed = false;
  const set = (field, value) => {
    if (tool[field] !== value) {
      tool[field] = value;
      changed = true;
    }
  };
  if (tool.program && tool.program.version) {
    set("specification", specificationFor(tool.program));
    const listing = programListing(tool.program);
    if (JSON.stringify(tool.listing) !== JSON.stringify(listing)) {
      tool.listing = listing;
      changed = true;
    }
    if (tool.summary) set("summary", { ...tool.summary, path: programPath(tool.program) });
  } else {
    // A contract saved before programs were compiled holds nothing executable,
    // so it is marked and described by the request it came from.
    set("status", "legacy");
    set("specification", inferredLegacySpecification(tool, profile));
  }
  set("description", registryDescription(tool, profile));
  return changed;
}

// Everything Recur has to be sure about before it serves a request: no
// placeholder artifacts, no observations without recorded answers, one live
// program per task family, and registry copy that matches the artifact it
// describes. Returns true when anything changed so the caller can persist it.
// Exported so the repair rules can be tested on a plain object, without a file.
function normalizeData(data) {
  let changed = false;
  if (!data) return false;
  for (const key of Object.keys(defaultData)) {
    if (!Array.isArray(data[key])) {
      data[key] = [];
      changed = true;
    }
  }
  // Never keep a tool that was created from the old prompt placeholder. It is
  // not a usable program and would otherwise win future similarity matches.
  const beforeTools = data.tools.length;
  data.tools = data.tools.filter((tool) => {
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
  if (data.tools.length !== beforeTools) changed = true;
  // Observations without a recorded answer can never be evidence for a program:
  // there is nothing to reproduce. Older builds stored repetition counters with
  // no answers at all, and keeping them only pollutes the next cluster.
  const beforePending = data.pending.length;
  data.pending = data.pending.filter((pending) => String(pending?.output || "").trim());
  if (data.pending.length !== beforePending) changed = true;
  // A rule program is only executable while it still derives what it says. A
  // build that compiled a program by copying a number out of a recorded reply
  // leaves one that states facts it never computed, so it stops being a program
  // and goes back to being the saved request it was compiled from. This is
  // checked before the family election below, so a program that cannot run can
  // never hold a task family against a recompilation.
  for (const tool of data.tools) {
    if (!tool.program?.version) continue;
    const demonstrations = (tool.tests || tool.examples || [])
      .map((example) => ({ input: String(example?.input ?? ""), output: String(example?.output ?? "") }))
      .filter((pair) => pair.input && pair.output);
    if (!demonstrations.length) continue;
    if (!misdeclaredNumbers(tool.program, demonstrations).length) continue;
    delete tool.program;
    delete tool.neural;
    tool.status = "legacy";
    changed = true;
  }
  // Keep one canonical program per task family among the live programs. A program
  // a later compilation replaced is history, and a legacy contract holds nothing
  // executable at all, so neither may take part in this election: a legacy
  // contract with more recorded runs must never crowd a working program out of
  // the registry.
  const canonical = new Map();
  const history = [];
  for (const tool of data.tools) {
    if (tool.status === "superseded" || !tool.program || !tool.program.version) {
      history.push(tool);
      continue;
    }
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    const canonicalName = String(tool.name || "").toLowerCase().replace(/-(?:number|sequence|checker|detector|classifier|program)$/, "");
    const key = canonicalName || profile.fingerprint || tool.name;
    const previous = canonical.get(key);
    if (!previous || (tool.executions || 0) > (previous.executions || 0)) canonical.set(key, tool);
  }
  const dedupedTools = [...canonical.values(), ...history];
  if (dedupedTools.length !== data.tools.length) changed = true;
  data.tools = dedupedTools;
  for (const tool of data.tools) {
    const profile = profileTask(tool.sourceTasks?.[0] || tool.specification || "");
    if (profile.meaningful && JSON.stringify(tool.profile) !== JSON.stringify(profile)) {
      tool.profile = profile;
      changed = true;
    }
    if (syncToolCopy(tool, profile)) changed = true;
    delete tool.dataset;
    delete tool.trainingStatus;
  }
  // Hide responses produced by the broken prompt-wrapper version. Keeping those
  // messages visible makes an otherwise repaired chat look broken forever.
  for (const chat of data.chats) {
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
  return changed;
}

async function init() {
  await db.read();
  let changed = false;
  if (!db.data) {
    db.data = structuredClone(defaultData);
    changed = true;
  }
  if (normalizeData(db.data)) changed = true;
  // Only hit the disk when something actually needed fixing. Writing on every
  // boot makes file-watching dev tools think the project changed and restart
  // the server in a loop.
  if (changed) await db.write();
}

export { db, init, normalizeData, syncToolCopy, registryDescription, inferredLegacySpecification, file as dbFile };
