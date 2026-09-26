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

const { db, init } = await import("../src/db.js");
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
  assert.equal(tool.metrics.generalization.passed, tool.metrics.generalization.folds);
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

test("a repeated request reuses the program instead of the model", async () => {
  const members = [
    observe("what is 2 plus 2", "4"),
    observe("what is 1+1", "2"),
  ];
  const text = "what is 10 plus 5";
  const compiled = await compileToolFrom(members, text, profileTask(text), embed(text));
  assert.ok(compiled.tool, compiled.reason);
  assert.equal(compiled.tool.name, "arithmetic-evaluator");

  // No model backend exists here, so these messages can only come from the
  // compiled program.
  const messages = await processTask(null, "what is 10 plus 5", "default", null);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "15");
  assert.equal(messages[0].viaTool, "arithmetic-evaluator");
  assert.equal(messages[0].programRun, true);
  assert.ok(messages[0].toolTrace.length >= 2);

  const second = await processTask(null, "what is 6 times 7", "default", null);
  assert.equal(second[0].text, "42");
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

test("legacy tools without a program are never executed", async () => {
  db.data.tools.push({ id: "legacy", name: "old-contract", specification: "handles recurring check-palindrome", sourceTasks: ["is civic a palindrome"], examples: [{ input: "is civic a palindrome", output: "yes" }] });
  const run = await runProgramTool(db.data.tools[0], "is civic a palindrome");
  assert.equal(run.ok, false);
  assert.match(run.reason, /no executable program/);
});
