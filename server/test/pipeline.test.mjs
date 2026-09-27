// End to end pipeline: repeat a task, compile a program from the verified
// demonstrations, then reuse it. The reuse assertions are meaningful because
// there is no model backend in the test environment: any hidden model call
// would fail the test instead of quietly answering.
//
// Run with: npm --prefix server test

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RECUR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recur-test-")), "db.json");

const { db, init, normalizeData } = await import("../src/db.js");
const { compileToolFrom, runProgramTool, processTask, verifiedPairs, resolveOffer, msg } = await import("../src/engine.js");
const { profileTask, embed } = await import("../src/embeddings.js");

await init();

function observe(text, output) {
  const profile = profileTask(text);
  const member = { id: `pending-${db.data.pending.length}`, text, profile, vector: embed(text), output, createdAt: Date.now() };
  db.data.pending.push(member);
  return member;
}

beforeEach(() => {
  db.data.tools = [];
  db.data.pending = [];
  db.data.log = [];
  db.data.chats = [];
});

test("conflicting observations are discarded before compiling", () => {
  const items = [
    observe("is civic a palindrome", 'Yes, "civic" is a palindrome.'),
    observe("is civic a palindrome", 'No, "civic" is not a palindrome.'),
    observe("is madam a palindrome", 'Yes, "madam" is a palindrome.'),
  ];
  const { pairs, discarded } = verifiedPairs(items);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].input, "is civic a palindrome");
  assert.equal(discarded[0].outputs.length, 2);
  assert.deepEqual(pairs, [{ input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' }]);
});

test("compiling builds an executable program with local evidence", async () => {
  const members = [
    observe("is civic a palindrome", 'Yes, "civic" is a palindrome.'),
    observe("check madam as a palindrome", 'Yes, "madam" is a palindrome.'),
  ];
  const text = "is racecar a palindrome";
  const compiled = await compileToolFrom(members, text, profileTask(text), embed(text));
  const tool = compiled.tool;
  assert.ok(tool, compiled.reason);
  assert.equal(tool.program.version, 1);
  assert.equal(tool.summary.family, "rule");
  assert.equal(tool.metrics.consistency, 1);
  assert.equal(tool.metrics.modelCalls, 0);
  // Two demonstrations are not enough for leave-one-out to measure anything: the
  // remaining single training demonstration does not identify a task. The tool
  // says so rather than reporting a number that means nothing.
  assert.equal(tool.metrics.generalization.measured, 0);
  assert.match(tool.metrics.generalization.note, /at least three demonstrations/);
  assert.equal(tool.metrics.stress.crashes, 0);
  assert.ok(tool.neural?.weights > 0, "acceptance head was trained");
  assert.equal(db.data.tools.length, 1);
  // The observations became a program, so they are no longer waiting in the
  // repetition buffer.
  assert.equal(db.data.pending.length, 0);

  const run = await runProgramTool(tool, "is kayak a palindrome");
  assert.ok(run.ok, run.reason);
  assert.equal(run.text, 'Yes, "kayak" is a palindrome.');
  assert.equal(tool.executions, 1);
  assert.equal(db.data.log.at(-1).type, "program");
});

// A registered program is never used silently: the request is offered the
// program first, and the program runs only once the user picks it. This test pins
// that rule, because a program answering on its own is indistinguishable from the
// model answering and takes the decision away from the person who asked.
test("a matched program is offered first and never runs on its own", async () => {
  const members = [
    observe("what is 2 plus 2", "4"),
    observe("what is 1+1", "2"),
  ];
  const text = "what is 10 plus 5";
  const compiled = await compileToolFrom(members, text, profileTask(text), embed(text));
  assert.ok(compiled.tool, compiled.reason);
  assert.equal(compiled.tool.name, "arithmetic-evaluator");

  const offered = await processTask(null, "what is 10 plus 5", "default", null);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].kind, "offer");
  assert.equal(offered[0].offerType, "use");
  assert.equal(offered[0].toolName, "arithmetic-evaluator");
  // Nothing ran, so nothing was counted as a run and nothing was answered.
  assert.equal(compiled.tool.executions, 0);
  assert.equal(db.data.log.filter((entry) => entry.type === "program").length, 0);

  // Approving the offer is what runs it, and no model is involved in the answer.
  const chat = { messages: [offered[0]] };
  const ran = await resolveOffer(chat, offered[0], "use", "default", null);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].text, "15");
  assert.equal(ran[0].viaTool, "arithmetic-evaluator");
  assert.equal(ran[0].programRun, true);
  assert.ok(ran[0].toolTrace.length >= 2);
  assert.equal(compiled.tool.executions, 1);

  // The next request is offered the same program again rather than answered by it.
  const second = await processTask(null, "what is 6 times 7", "default", null);
  assert.equal(second[0].kind, "offer");
  assert.equal(second[0].offerType, "use");
  const secondRun = await resolveOffer({ messages: [second[0]] }, second[0], "use", "default", null);
  assert.equal(secondRun[0].text, "42");
  assert.equal(db.data.tools[0].executions, 2);
  // Running a program is not new evidence about the task, so nothing was queued
  // for another compile.
  assert.equal(db.data.pending.length, 0);
});

test("approving an offer runs the program, never the model", async () => {
  const members = [
    observe("how many letters are in strawberry", "10"),
    observe("how many letters are in banana", "6"),
  ];
  const text = "how many letters are in kiwi";
  const compiled = await compileToolFrom(members, text, profileTask(text), embed(text));
  assert.ok(compiled.tool, compiled.reason);

  const chat = { messages: [] };
  const offer = msg({ role: "assistant", kind: "offer", offerType: "use", toolId: compiled.tool.id, toolName: compiled.tool.name, toolSpec: compiled.tool.specification, similarity: 0.9, taskText: "how many letters are in mango", resolved: null });
  chat.messages.push(offer);
  const out = await resolveOffer(chat, offer, "use", "default", null);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "5");
  assert.equal(out[0].viaTool, compiled.tool.name);
  assert.equal(chat.messages[0].resolved, "use");
});

test("a program that cannot read the request declines instead of guessing", async () => {
  const members = [
    observe("is civic a palindrome", 'Yes, "civic" is a palindrome.'),
    observe("check madam as a palindrome", 'Yes, "madam" is a palindrome.'),
  ];
  const text = "is racecar a palindrome";
  const compiled = await compileToolFrom(members, text, profileTask(text), embed(text));
  const run = await runProgramTool(compiled.tool, "what is the capital of france");
  assert.equal(run.ok, false);
  assert.match(run.reason, /input pattern/);
  assert.equal(compiled.tool.executions, 0);
});

test("registering the same task twice reaches for the existing program", async () => {
  const first = await compileToolFrom(
    [observe("is civic a palindrome", 'Yes, "civic" is a palindrome.'), observe("check madam as a palindrome", 'Yes, "madam" is a palindrome.')],
    "is racecar a palindrome",
    profileTask("is racecar a palindrome"),
    embed("is racecar a palindrome")
  );
  assert.ok(first.tool);
  const second = await compileToolFrom(
    [observe("is level a palindrome", 'Yes, "level" is a palindrome.'), observe("is kayak a palindrome", 'Yes, "kayak" is a palindrome.')],
    "verify rotor as a palindrome",
    profileTask("verify rotor as a palindrome"),
    embed("verify rotor as a palindrome")
  );
  // The second cluster is the same task family, so no second program is created
  // and the existing one answers it.
  assert.equal(second.existing, true);
  assert.equal(second.tool.id, first.tool.id);
  assert.equal(db.data.tools.length, 1);
  assert.deepEqual(db.data.tools[0].summary.uncoveredBranches, []);
  const run = await runProgramTool(first.tool, "verify rotor as a palindrome");
  assert.equal(run.text, 'Yes, "rotor" is a palindrome.');
});

// The reported failure: "whats the reverse of '<word>'" was asked three times
// and no reusable program was ever offered, because a reversal request was not
// recognised as a task at all. The whole path is exercised here without a model
// backend, so any hidden model call would fail the test instead of answering.
test("a repeated reversal is offered a program, then answered locally", async () => {
  observe("whats the reverse of 'abcd'", "The reverse of 'abcd' is 'cba'.");
  observe("whats the reverse of 'defg'", "The reverse of 'defg' is 'gfde'.");

  const offered = await processTask(null, "whats the reverse of 'hello'", "default", null);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].kind, "offer");
  assert.equal(offered[0].offerType, "create");
  assert.equal(offered[0].clusterCount, 3);

  const chat = { messages: [offered[0]] };
  const resolved = await resolveOffer(chat, offered[0], "create", "default", null);
  // Both recorded replies reversed the word wrongly. Reversal is decidable, so
  // the compiled program computes the answer instead of imitating them.
  const first = resolved.find((message) => message.programRun);
  assert.equal(first.text, "The reverse of 'hello' is 'olleh'.");
  assert.equal(db.data.tools[0].name, "text-reverser");
  assert.equal(db.data.tools[0].metrics.coverage.faults, 2);

  // The next reversal is offered the program, and runs it locally once accepted.
  const later = await processTask(null, "whats the reverse of 'king'", "default", null);
  assert.equal(later[0].kind, "offer");
  assert.equal(later[0].offerType, "use");
  assert.equal(later[0].toolName, "text-reverser");
  const ranLater = await resolveOffer({ messages: [later[0]] }, later[0], "use", "default", null);
  assert.equal(ranLater[0].text, "The reverse of 'king' is 'gnik'.");
  assert.equal(ranLater[0].programRun, true);
  assert.equal(db.data.pending.length, 0);
});

test("a repeated palindrome check compiles a checker, not a dead lookup", async () => {
  observe("is abdor a palindrome", 'No, "abcdeba" is not a palindrome.');
  observe("is hello a palindrome", "Yes, hello is a palindrome.");

  const offered = await processTask(null, "is racecar a palindrome", "default", null);
  assert.equal(offered[0].offerType, "create");

  const chat = { messages: [offered[0]] };
  const resolved = await resolveOffer(chat, offered[0], "create", "default", null);
  const tool = db.data.tools[0];
  assert.equal(tool.name, "palindrome-checker");
  assert.equal(tool.summary.family, "rule");
  // The recorded replies echoed a different word and claimed a palindrome that is
  // not one. Both are reported, and the program answers correctly anyway.
  const reasons = tool.metrics.coverage.outliers.map((outlier) => outlier.reason);
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /different word/);
  assert.match(reasons[1], /verdict contradicts/);
  assert.equal(resolved.find((message) => message.programRun).text, "Yes, racecar is a palindrome.");

  const later = await processTask(null, "is zebra a palindrome", "default", null);
  assert.equal(later[0].kind, "offer");
  assert.equal(later[0].offerType, "use");
  const ranLater = await resolveOffer({ messages: [later[0]] }, later[0], "use", "default", null);
  assert.equal(ranLater[0].text, 'No, "zebra" is not a palindrome.');
  assert.equal(ranLater[0].programRun, true);
});

test("a stale lookup is replaced instead of blocking its task family", async () => {
  // Exactly the artifact that was in the registry: a verified lookup that could
  // answer nothing, sitting in the palindrome family.
  const stale = {
    id: "stale-lookup",
    name: "check-palindrome-lookup",
    specification: 'Reads the word before "palindrome" and looks up the verified answer',
    runtime: "recur-vm 1.1",
    compiler: "recur-compiler/1.1",
    status: "active",
    program: { version: 1, family: "table", read: { op: "wordBefore", arg: { keyword: "palindrome" } }, steps: [], emit: { op: "table", arg: { map: { elsewhere: "Yes" } } } },
    summary: { family: "table", path: 'the word before "palindrome" → lookup' },
    sourceTasks: ["is civic a palindrome"],
    profile: profileTask("is civic a palindrome"),
    embedding: embed("is civic a palindrome"),
    tests: [{ input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' }],
    metrics: { demonstrations: 1 },
    executions: 0,
    totalLatencyMs: 0,
  };
  db.data.tools.push(stale);

  const members = [observe("is civic a palindrome", 'Yes, "civic" is a palindrome.'), observe("is madam a palindrome", 'Yes, "madam" is a palindrome.')];
  const compiled = await compileToolFrom(members, "is racecar a palindrome", profileTask("is racecar a palindrome"), embed("is racecar a palindrome"));
  assert.equal(compiled.existing, undefined);
  assert.equal(compiled.tool.name, "palindrome-checker");
  assert.deepEqual(compiled.superseded, ["check-palindrome-lookup"]);
  assert.equal(stale.status, "superseded");
  assert.equal(stale.supersededBy, "palindrome-checker");

  // The replacement answers, and a later cluster for the same family reaches for
  // the replacement rather than the dead lookup.
  const run = await runProgramTool(compiled.tool, "is racecar a palindrome");
  assert.equal(run.text, 'Yes, "racecar" is a palindrome.');
  const again = await compileToolFrom([observe("is level a palindrome", 'Yes, "level" is a palindrome.'), observe("is kayak a palindrome", 'Yes, "kayak" is a palindrome.')], "verify rotor as a palindrome", profileTask("verify rotor as a palindrome"), embed("verify rotor as a palindrome"));
  assert.equal(again.existing, true);
  assert.equal(again.tool.name, "palindrome-checker");
});

// The second half of the reported failure: a registered program that cannot read
// a request used to swallow it, so the family could never be offered again and
// the dead program stayed in place. Repeats must still reach the offer, and the
// offer must compile a program rather than hand the request back to the dead one.
test("a program that cannot read the request does not block its family", async () => {
  const stale = {
    id: "stale-lookup",
    name: "check-palindrome-lookup",
    specification: 'Reads the word before "palindrome" and looks up the verified answer',
    runtime: "recur-vm 1.1",
    compiler: "recur-compiler/1.1",
    status: "active",
    program: { version: 1, family: "table", read: { op: "wordBefore", arg: { keyword: "palindrome" } }, steps: [], emit: { op: "table", arg: { map: { elsewhere: "Yes" } } } },
    summary: { family: "table", path: 'the word before "palindrome" → lookup' },
    sourceTasks: ["is civic a palindrome"],
    profile: profileTask("is civic a palindrome"),
    embedding: embed("is civic a palindrome"),
    tests: [{ input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' }],
    metrics: { demonstrations: 1 },
    executions: 9,
    totalLatencyMs: 900,
  };
  db.data.tools.push(stale);

  observe("is abdor a palindrome", 'No, "abcdeba" is not a palindrome.');
  observe("is hello a palindrome", "Yes, hello is a palindrome.");

  const offered = await processTask(null, "is racecar a palindrome", "default", null);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].kind, "offer");
  assert.equal(offered[0].offerType, "create");
  assert.match(offered[0].clusterNote, /check-palindrome-lookup/);

  const chat = { messages: [offered[0]] };
  const resolved = await resolveOffer(chat, offered[0], "create", "default", null);
  // The dead lookup is not reused: a checker is compiled and it answers.
  assert.equal(chat.messages[0].resolved, "create");
  assert.equal(resolved.find((message) => message.programRun).text, "Yes, racecar is a palindrome.");
  assert.equal(db.data.tools.find((tool) => tool.id === stale.id).status, "superseded");
  assert.equal(db.data.tools.find((tool) => tool.name === "palindrome-checker").summary.family, "rule");
});

// The registry decides which one of two programs for a family it keeps. A
// program that runs must never lose that election to an inert legacy contract
// that merely has a longer history behind it.
test("a legacy contract never evicts a working program from the registry", async () => {
  const members = [observe("is civic a palindrome", 'Yes, "civic" is a palindrome.'), observe("check madam as a palindrome", 'Yes, "madam" is a palindrome.')];
  const compiled = await compileToolFrom(members, "is racecar a palindrome", profileTask("is racecar a palindrome"), embed("is racecar a palindrome"));
  assert.ok(compiled.tool, compiled.reason);
  db.data.tools.push({
    id: "legacy",
    name: "palindrome-check",
    specification: "handles recurring check-palindrome",
    sourceTasks: ["is civic a palindrome"],
    examples: [{ input: "is civic a palindrome", output: "yes" }],
    executions: 40,
    totalLatencyMs: 4000,
  });

  // The boot repair rules run on a plain object here, so the registry can be
  // checked without touching a file.
  normalizeData(db.data);

  const names = db.data.tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["palindrome-check", "palindrome-checker"]);
  assert.equal(db.data.tools.find((tool) => tool.name === "palindrome-check").status, "legacy");
  assert.ok(db.data.tools.find((tool) => tool.name === "palindrome-checker").program);
  // The legacy contract is kept as history, and the live program still answers.
  const survivor = db.data.tools.find((tool) => tool.name === "palindrome-checker");
  const run = await runProgramTool(survivor, "is kayak a palindrome");
  assert.equal(run.text, 'Yes, "kayak" is a palindrome.');
});

test("legacy tools without a program are never executed", async () => {
  db.data.tools.push({ id: "legacy", name: "old-contract", specification: "handles recurring check-palindrome", sourceTasks: ["is civic a palindrome"], examples: [{ input: "is civic a palindrome", output: "yes" }] });
  const run = await runProgramTool(db.data.tools[0], "is civic a palindrome");
  assert.equal(run.ok, false);
  assert.match(run.reason, /no executable program/);
});
