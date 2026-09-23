import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { profileTask } from "./embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "data", "db.json");
// db.json is gitignored, so fresh deploys (Render, Railway) do not have the
// data directory at all. lowdb writes through a .tmp sibling file and would
// crash with ENOENT on the first save. Create the directory before anything
// tries to write.
fs.mkdirSync(path.dirname(file), { recursive: true });

const defaultData = {
  users: [],   // { id, email, passwordHash, name, createdAt }
  chats: [],   // { id, userId, guest, title, messages:[], awaiting, createdAt, updatedAt }
  tools: [],   // { id, name, specification, examples, sourceTasks, embedding, createdAt, executions, totalLatencyMs }
  pending: [], // { id, text, vector, createdAt }
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

function registryDescription(tool, profile) {
  const specification = String(tool.specification || "").replace(/\s+/g, " ").trim();
  const examples = (tool.examples || []).length;
  const sources = (tool.sourceTasks || []).length;
  const task = specification && !/^handles recurring|^performs the recurring/i.test(specification)
    ? specification.charAt(0).toLowerCase() + specification.slice(1).replace(/[.]$/, "")
    : `the recurring ${profile.operation} computation in the ${profile.domain} domain`;
  return `This reusable program is designed to ${task}. It accepts a new request from the same task family, applies the behavior inferred from verified demonstrations, and returns the computed result rather than a general explanation. The registry currently records ${examples} verified behavior example${examples === 1 ? "" : "s"} from ${sources} source request${sources === 1 ? "" : "s"}; future executions are matched to this task contract before another program is created.`;
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
    for (const example of tool.examples || []) {
      const input = String(example.input || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!input || seenInputs.has(input)) return false;
      seenInputs.add(input);
    }
    return true;
  });
  if (db.data.tools.length !== beforeTools) changed = true;
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
    // Legacy compilers sometimes saved one concrete answer as the whole task
    // description (for example, "the 8th number is 13"). Replace that stale
    // description with an honest generic contract instead of presenting it as
    // the reusable program's definition.
    if (/^(?:handles recurring|performs the recurring)/i.test(String(tool.specification || "")) || /\b\d+(?:st|nd|rd|th)\b.*\b(?:is|equals)\b/i.test(String(tool.specification || ""))) {
      tool.specification = inferredLegacySpecification(tool, profile);
      changed = true;
    }
    const description = registryDescription(tool, profile);
    if (tool.description !== description) {
      tool.description = description;
      changed = true;
    }
    if (!tool.dataset || (tool.dataset.target || 0) < 2000) {
      const count = tool.examples?.length || 0;
      tool.dataset = { seed: count, generated: 0, total: count, target: 2000, generationTarget: 256, split: { train: Math.floor(count * 0.7), validation: Math.floor(count * 0.15), test: count - Math.floor(count * 0.7) - Math.floor(count * 0.15) }, status: "legacy dataset; new synthesis required" };
      tool.trainingStatus = "legacy contract; separate neural-weight training not run; recompile to synthesize the larger dataset";
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

export { db, init, registryDescription, inferredLegacySpecification };
