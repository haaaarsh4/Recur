import path from "path";
import { fileURLToPath } from "url";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "data", "db.json");

const defaultData = {
  users: [],   // { id, email, passwordHash, name, createdAt }
  chats: [],   // { id, userId, guest, title, messages:[], awaiting, createdAt, updatedAt }
  tools: [],   // { id, name, specification, examples, sourceTasks, embedding, createdAt, executions, totalLatencyMs }
  pending: [], // { id, text, vector, createdAt }
  log: [],     // { id, type: 'hit'|'general', toolId?, toolName?, latencyMs, ts }
};

const adapter = new JSONFile(file);
const db = new Low(adapter, defaultData);

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
  // Only hit the disk when something actually needed fixing. Writing on every
  // boot makes file-watching dev tools think the project changed and restart
  // the server in a loop.
  if (changed) await db.write();
}

export { db, init };
