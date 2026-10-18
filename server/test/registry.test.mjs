// The shared tool registry, over HTTP: what it lists, what hiding one program
// does, what clearing it does, and what neither of them does to anybody else.
// The registry is public on purpose, so these requests carry no account, only
// the guest cookie every visitor already has.
//
// Run with: npm --prefix server test

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RECUR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recur-registry-")), "db.json");

const { db, init, normalizeData } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { compileProgram, specificationFor, programPath } = await import("../src/program.js");
const { profileTask } = await import("../src/embeddings.js");

await init();

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

// Two visitors, so "cleared for me" can be checked against somebody else's view.
const ALICE = { Cookie: "guest_id=registry-alice-0001" };
const BOB = { Cookie: "guest_id=registry-bob-000001" };

function who(cookie = ALICE) {
  return { ...cookie, "content-type": "application/json" };
}

const list = async (cookie) => (await fetch(`${base}/api/tools`, { headers: who(cookie) })).json();

const PALINDROME_DEMONSTRATIONS = [
  { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
  { input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' },
];

function palindromeTool(name = "palindrome-checker") {
  const compiled = compileProgram(PALINDROME_DEMONSTRATIONS, profileTask(PALINDROME_DEMONSTRATIONS[0].input));
  return {
    id: `${name}-id`,
    name,
    status: "active",
    specification: "stale copy from an earlier build",
    program: compiled.program,
    tests: PALINDROME_DEMONSTRATIONS,
    summary: { family: "rule", path: "stale path" },
    listing: ["stale path"],
    executions: 0,
    totalLatencyMs: 0,
  };
}

function legacyTool(name = "saved-request") {
  return { id: `${name}-id`, name, status: "legacy", specification: "Handles recurring tasks.", sourceTasks: ["what is the capital of france"], tests: [] };
}

test("the registry lists every program without a session", async () => {
  db.data.tools = [palindromeTool(), legacyTool()];
  await db.write();
  const res = await fetch(`${base}/api/tools`);
  assert.equal(res.status, 200);
  const tools = await res.json();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["palindrome-checker", "saved-request"]);
  // Listing also keeps the stored copy honest about the program that is there:
  // description, compiled path and listing all come from the same operations.
  const programmed = tools.find((tool) => tool.name === "palindrome-checker");
  assert.equal(programmed.specification, specificationFor(programmed.program));
  assert.equal(programmed.summary.path, programPath(programmed.program));
  assert.ok(!programmed.listing.includes("stale path"));
  // Nothing has been cleared by this visitor, so nothing is flagged.
  assert.deepEqual(tools.map((tool) => tool.hiddenForYou), [false, false]);
});

test("hiding one program removes it from that visitor's view only", async () => {
  db.data.tools = [palindromeTool("keep-me"), palindromeTool("drop-me")];
  db.data.hidden = [];
  await db.write();

  const res = await fetch(`${base}/api/tools/drop-me`, { method: "DELETE", headers: who() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, hidden: "drop-me" });

  // The program is still in the store, still listed, and still answering: it is
  // only flagged for the visitor who cleared it, which is what the client uses
  // to move it behind its "show hidden" control.
  await db.read();
  assert.deepEqual(db.data.tools.map((tool) => tool.name).sort(), ["drop-me", "keep-me"]);
  const mine = await list();
  assert.deepEqual(mine.map((tool) => tool.name), ["keep-me", "drop-me"]);
  assert.deepEqual(mine.filter((tool) => tool.hiddenForYou).map((tool) => tool.name), ["drop-me"]);

  // Somebody else's registry is untouched.
  const theirs = await list(BOB);
  assert.deepEqual(theirs.filter((tool) => tool.hiddenForYou), []);

  // Hiding twice is not two rows, and the restore brings the whole list back.
  await fetch(`${base}/api/tools/drop-me`, { method: "DELETE", headers: who() });
  await db.read();
  assert.equal(db.data.hidden.length, 1);
  const restored = await fetch(`${base}/api/tools/hidden`, { method: "DELETE", headers: who() });
  assert.deepEqual(await restored.json(), { ok: true, restored: 1 });
  assert.deepEqual((await list()).filter((tool) => tool.hiddenForYou), []);
  // The restore is held to the visitor who asked for it: Bob never hid anything.
  await fetch(`${base}/api/tools/drop-me`, { method: "DELETE", headers: who(BOB) });
  assert.deepEqual(await (await fetch(`${base}/api/tools/hidden`, { method: "DELETE", headers: who() })).json(), { ok: true, restored: 0 });
  await db.read();
  assert.equal(db.data.hidden.length, 1);
  await fetch(`${base}/api/tools/hidden`, { method: "DELETE", headers: who(BOB) });
});

test("hiding a program that is not in the registry says so", async () => {
  const res = await fetch(`${base}/api/tools/not-a-program`, { method: "DELETE", headers: who() });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no longer in the registry/);
});

test("clearing hides every program for the visitor who cleared it", async () => {
  db.data.tools = [palindromeTool(), legacyTool()];
  db.data.pending = [{ id: "p1", text: "is kayak a palindrome", output: "Yes", createdAt: Date.now() }];
  db.data.log = [{ id: "log-1", type: "program", toolId: "palindrome-checker-id", latencyMs: 0.2 }];
  db.data.hidden = [];
  await db.write();

  const res = await fetch(`${base}/api/tools`, { method: "DELETE", headers: who() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, hidden: 2 });

  await db.read();
  // Nothing disappeared: the programs, the observations waiting to be compiled
  // and the execution log are all exactly where they were.
  assert.deepEqual(db.data.tools.map((tool) => tool.name).sort(), ["palindrome-checker", "saved-request"]);
  assert.deepEqual(db.data.pending.map((entry) => entry.id), ["p1"]);
  assert.deepEqual(db.data.log.map((entry) => entry.id), ["log-1"]);
  assert.deepEqual((await list()).map((tool) => tool.hiddenForYou), [true, true]);

  // Another visitor still sees the whole shared registry.
  assert.deepEqual((await list(BOB)).map((tool) => tool.hiddenForYou), [false, false]);
  await fetch(`${base}/api/tools/hidden`, { method: "DELETE", headers: who() });
  assert.deepEqual((await list()).map((tool) => tool.hiddenForYou), [false, false]);
});

test("registry copy is regenerated from the stored program, not from an old dump", () => {
  const tool = palindromeTool();
  tool.specification = 'Reads the word before "palindrome", applies text is all digits, and select wording for true/false ("Yes, {subject} is a palindrome." / "No, {subject} is not a palindrome.").';
  tool.listing = ["text is all digits"];
  const data = { users: [], chats: [], pending: [], log: [], tools: [tool] };

  normalizeData(data);

  const repaired = data.tools[0];
  assert.equal(repaired.specification, specificationFor(repaired.program));
  assert.ok(repaired.specification.length <= 140, repaired.specification);
  // No operation dump, no raw placeholders, no pasted recorded sentences.
  assert.ok(!/[{}]/.test(repaired.specification), repaired.specification);
  assert.ok(!/select wording|true\/false/.test(repaired.specification), repaired.specification);
  assert.ok(!repaired.listing.includes("text is all digits"), JSON.stringify(repaired.listing));
});

test("a stored program that states a number it never computed stops running", () => {
  // Exactly what one build saved: the only thing this program computes is
  // whether the word before "fibonacci" is a number, and its answer claims a
  // position ("the 7th number") nothing derived.
  const storedProgram = {
    version: 1,
    family: "rule",
    read: { op: "wordBefore", arg: { keyword: "fibonacci" } },
    steps: [{ op: "isDigits", arg: {} }],
    emit: {
      op: "truth",
      arg: {
        true: "Yes, {subject} is the 7th number in the Fibonacci sequence.",
        false: "The 10th {subject} in the Fibonacci series is 55.",
      },
    },
  };
  const tests = [
    { input: "is 12 in the fibonacci series", output: "Yes, 12 is the 7th number in the Fibonacci series." },
    { input: "what is the 10th element in the Fibonacci series", output: "The 10th element in the Fibonacci series is 55." },
    { input: "is 10 in the fibonacci series", output: "Yes, 10 is the 7th number in the Fibonacci sequence." },
  ];
  const data = {
    users: [],
    chats: [],
    pending: [],
    log: [],
    tools: [{ id: "stale", name: "digit-checker", status: "active", program: storedProgram, tests, executions: 4, totalLatencyMs: 1 }],
  };

  normalizeData(data);

  const tool = data.tools[0];
  assert.equal(tool.program, undefined);
  assert.equal(tool.status, "legacy");
  // It is described by the requests it was compiled from instead of by a
  // sentence about a computation that no longer exists.
  assert.match(tool.specification, /^Answer requests like "/);
});

test("a verified lookup keeps repeating its recorded answers", () => {
  // A lookup is the honest answer for a task nothing generalizes: it answers the
  // inputs it was shown and declines everything else, so its recorded numbers
  // are evidence rather than a claim.
  const pairs = [
    { input: "what is the capital of france", output: "Paris" },
    { input: "what is the capital of japan", output: "Tokyo" },
  ];
  const compiled = compileProgram(pairs, profileTask(pairs[0].input));
  assert.equal(compiled.program.emit.op, "table");
  const data = {
    users: [],
    chats: [],
    pending: [],
    log: [],
    tools: [{ id: "lookup", name: "capital-lookup", status: "active", program: compiled.program, tests: pairs }],
  };

  normalizeData(data);

  assert.ok(data.tools[0].program);
  assert.equal(data.tools[0].status, "active");
});
