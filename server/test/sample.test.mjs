// A first visit has to show what the project does before anything has been
// compiled, and while the model backend may be unreachable. Every visitor gets
// one prepared conversation, pinned, in their own copy: two answers from the
// model, the third request compiled and answered by that compiled program, and a
// fourth question left on the one decision that belongs to the visitor.
//
// These tests go through the HTTP API with two guest identities, so the "one
// copy per visitor" promise is checked rather than assumed. The reuse assertions
// are meaningful because the compiled path answers locally: no model is involved
// in the compiled answer, and the message it produces says so.
//
// Run with: npm --prefix server test

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RECUR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recur-sample-")), "db.json");
process.env.NODE_ENV = "test";

const { db } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { SAMPLE_VERSION } = await import("../src/sample.js");

const ALICE = { cookie: "guest_id=guest-aaaaaaaaaaaa" };
const BOB = { cookie: "guest_id=guest-bbbbbbbbbbbb" };

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function json(pathname, who, init = {}) {
  const res = await fetch(base + pathname, { ...init, headers: { ...who, ...(init.headers || {}) } });
  return { status: res.status, body: await res.json() };
}

async function sampleChat(who) {
  const list = await json("/api/chats", who);
  const sample = list.body.find((chat) => chat.sample);
  assert.ok(sample, "the list contains a sample chat");
  const { body } = await json(`/api/chats/${sample.id}`, who);
  return body;
}

async function send(who, chat, text) {
  return json(`/api/chats/${chat.id}/messages`, who, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, tier: "default" }),
  });
}

function decide(who, chat, messageId, action, tier = "default") {
  return json(`/api/chats/${chat.id}/offers/${messageId}/resolve`, who, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, tier }),
  });
}

// A page load fires several requests at once, before the server has set its
// guest cookie. They all have to be answered as the same visitor, or the sample
// the browser was shown belongs to a guest it can no longer be: the auto-opened
// chat came back as "Chat not found".
test("several requests from one first visit keep one identity", async () => {
  const headers = { "x-recur-guest": "visit-7f3c1a9d2b4e" };
  const [chatsRes, toolsRes, statsRes, meRes] = await Promise.all([
    fetch(`${base}/api/chats`, { headers }),
    fetch(`${base}/api/tools`, { headers }),
    fetch(`${base}/api/stats`, { headers }),
    fetch(`${base}/api/auth/me`, { headers }),
  ]);
  const chats = await chatsRes.json();
  assert.equal(toolsRes.status, 200);
  assert.equal(statsRes.status, 200);
  assert.equal(meRes.status, 401);
  for (const res of [chatsRes, toolsRes, statsRes]) {
    assert.match(res.headers.get("set-cookie") || "", /guest_id=visit-7f3c1a9d2b4e/, "every answer names the same guest");
  }

  const sample = chats.find((chat) => chat.sample);
  assert.ok(sample, "the visit was seeded");
  // The chat the sample row points at opens for that same visitor.
  const opened = await json(`/api/chats/${sample.id}`, headers);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.sample, true);
});

test("the first visit is seeded with one pinned sample chat", async () => {
  const first = await json("/api/chats", ALICE);
  assert.equal(first.status, 200);
  assert.equal(first.body.length, 1);
  assert.equal(first.body[0].sample, true);
  assert.equal(first.body[0].pinned, true);
  assert.match(first.body[0].title, /sample/i);

  const again = await json("/api/chats", ALICE);
  assert.equal(again.body.length, 1, "the sample is created once, not on every load");
  assert.equal(again.body[0].id, first.body[0].id);
});

test("two visitors get separate copies of the sample", async () => {
  const alice = await sampleChat(ALICE);
  const bob = await sampleChat(BOB);
  assert.notEqual(alice.id, bob.id);
  assert.notEqual(alice.userId, bob.userId);
});

test("the sample says what it is, in one short note", async () => {
  const chat = await sampleChat(ALICE);
  const note = chat.messages[0];
  assert.equal(note.kind, "sample_note");
  assert.match(note.text, /sample/i);
  // A note nobody reads is not a note: it stays short, and it says what the
  // thread is about to show.
  assert.ok(note.text.length < 260, `the note is ${note.text.length} characters long`);
  assert.ok(!/[\u2013\u2014]/.test(note.text), "no en or em dashes");
});

test("the third request is compiled, and the compiled program answers it", async () => {
  const chat = await sampleChat(ALICE);
  const questions = chat.messages.filter((message) => message.role === "user").map((message) => message.text);
  assert.deepEqual(questions, ["is civic a palindrome", "is abcd a palindrome", "is racecar a palindrome", "is kayak a palindrome"]);

  // Two answers came from the model, and the label says so, by saying nothing:
  // no viaTool, no program run.
  const spoken = chat.messages.filter((message) => message.role === "assistant" && message.kind === "text" && !message.viaTool);
  assert.deepEqual(spoken.map((message) => message.text), [
    'Yes, "civic" is a palindrome.',
    'No, "abcd" is not a palindrome.',
  ]);

  // The third request raised the compile offer, and it was accepted: the offer
  // card says so, and the program details follow it.
  const created = chat.messages.find((message) => message.kind === "offer" && message.offerType === "create");
  assert.equal(created.resolved, "create");
  assert.equal(created.clusterCount, 3);
  assert.equal(created.taskText, "is racecar a palindrome");
  const details = chat.messages.find((message) => message.kind === "program_info");
  assert.match(details.text, /palindrome-checker/);
  assert.match(details.text, /First execution/);

  // The answer to that third request came from the program, and the message
  // carries the same label a live reuse carries: the program, its latency, and
  // the fact that no model was called.
  const compiled = chat.messages.find((message) => message.programRun);
  assert.equal(compiled.text, 'Yes, "racecar" is a palindrome.');
  assert.equal(compiled.viaTool, "palindrome-checker");
  assert.equal(compiled.tierApplied, undefined, "no model tier answered this one");
  assert.ok(compiled.latency < 1000, `the compiled run took ${compiled.latency}ms`);
  assert.ok(compiled.toolTrace?.length, "the run is traceable");
});

test("the sample leaves the fourth question on the reuse ask", async () => {
  const chat = await sampleChat(ALICE);
  const last = chat.messages.at(-1);
  assert.equal(last.kind, "offer");
  assert.equal(last.offerType, "use");
  assert.equal(last.resolved, null, "the decision is the visitor's");
  assert.equal(last.toolName, "palindrome-checker");
  assert.equal(last.taskText, "is kayak a palindrome");
  assert.ok(last.similarity > 0.9);
  assert.equal(chat.messages.length, 11);
  assert.equal(chat.sampleVersion, SAMPLE_VERSION);
});

test("the sample program is a real compiled artifact in the registry", async () => {
  const tools = await json("/api/tools", ALICE);
  const checker = tools.body.find((tool) => tool.name === "palindrome-checker");
  assert.ok(checker, "the registry lists the sample program");
  assert.ok(checker.program && checker.program.version);
  assert.equal(checker.metrics.demonstrations, 2);
  assert.equal(checker.metrics.reproduced, 2);
});

test("accepting the reuse ask answers locally, with no model call", async () => {
  const chat = await sampleChat(ALICE);
  const offer = chat.messages.at(-1);
  const accepted = await decide(ALICE, chat, offer.id, "use");
  assert.equal(accepted.status, 200);
  const answer = accepted.body.added.find((message) => message.programRun);
  assert.ok(answer, "the compiled program answered");
  assert.equal(answer.text, 'Yes, "kayak" is a palindrome.');
  assert.equal(answer.viaTool, "palindrome-checker");
  assert.equal(answer.tierApplied, undefined);
  assert.ok(answer.latency < 1000, `a local run took ${answer.latency}ms`);
});

test("declining the reuse ask goes to the model instead of the program", async () => {
  const chat = await sampleChat(BOB);
  const offer = chat.messages.at(-1);
  const declined = await decide(BOB, chat, offer.id, "general");
  // Whatever the model backend is doing, the answer did not come from the
  // compiled program: no run, no program label. A reachable backend answers, and
  // an unreachable one is reported as the backend being offline.
  if (declined.status === 200) {
    const answer = declined.body.added.at(-1);
    assert.equal(answer.viaTool, undefined);
    assert.equal(answer.programRun, undefined);
    assert.ok(answer.text, "the model answered");
  } else {
    assert.match(declined.body.error, /offline|model backend/i);
  }
  const after = await sampleChat(BOB);
  assert.equal(after.messages.find((message) => message.id === offer.id).resolved, "general");
});

test("a palindrome question of the visitor's own gets the ask, not an answer", async () => {
  const chat = await sampleChat(ALICE);
  const sent = await send(ALICE, chat, "is level a palindrome");
  assert.equal(sent.status, 200);
  const offer = sent.body.added.at(-1);
  assert.equal(offer.kind, "offer");
  assert.equal(offer.offerType, "use");
  assert.equal(offer.resolved, null);
  assert.equal(offer.taskText, "is level a palindrome");
  // Nothing was answered for it, by a program or by the model.
  assert.equal(sent.body.added.some((message) => message.role === "assistant" && message.kind === "text" && !message.viaTool), false);
});

test("one visitor's sample is untouched by another visitor using theirs", async () => {
  const alice = await sampleChat(ALICE);
  assert.equal(alice.messages.find((message) => message.kind === "offer" && message.offerType === "use").resolved, "use");
  const bob = await sampleChat(BOB);
  assert.notEqual(bob.id, alice.id);
  assert.equal(bob.messages[0].kind, "sample_note");
  assert.equal(bob.messages.find((message) => message.kind === "offer" && message.offerType === "use").resolved, "general");
});

// The transcript one earlier build left behind: the ask on the third request
// with no answer after it. Untouched copies of it have to be replaced, because
// the whole point of the sample is that the compiled answer is visible.
function olderTranscript() {
  const at = Date.now();
  return [
    { id: "old-note", role: "system", kind: "sample_note", text: "A sample chat for you to try.", ts: at },
    { id: "old-q1", role: "user", kind: "text", text: "is civic a palindrome", ts: at },
    { id: "old-a1", role: "assistant", kind: "text", text: 'Yes, "civic" is a palindrome.', ts: at },
    { id: "old-q2", role: "user", kind: "text", text: "is abcd a palindrome", ts: at },
    { id: "old-a2", role: "assistant", kind: "text", text: 'No, "abcd" is not a palindrome.', ts: at },
    { id: "old-q3", role: "user", kind: "text", text: "is racecar a palindrome", ts: at },
    { id: "old-create", role: "assistant", kind: "offer", offerType: "create", clusterCount: 3, clusterExamples: ["is civic a palindrome", "is abcd a palindrome"], taskText: "is racecar a palindrome", resolved: null, ts: at },
  ];
}

test("an untouched copy from an older build is rebuilt, a used one is left alone", async () => {
  const fresh = await sampleChat(ALICE);
  const stored = db.data.chats.find((chat) => chat.id === fresh.id);
  stored.sampleVersion = 2;
  stored.messages = olderTranscript();
  await db.write();

  const rebuilt = await sampleChat(ALICE);
  assert.equal(rebuilt.sampleVersion, SAMPLE_VERSION);
  assert.equal(rebuilt.messages.length, 11);
  assert.equal(rebuilt.messages.find((message) => message.programRun).text, 'Yes, "racecar" is a palindrome.');
  assert.equal(rebuilt.messages.at(-1).offerType, "use");
  assert.equal(rebuilt.messages.at(-1).resolved, null);

  // Now the visitor uses it. Their own message means the copy is theirs, and the
  // script never replaces it, however old it is.
  await send(ALICE, rebuilt, "is level a palindrome");
  db.data.chats.find((chat) => chat.id === rebuilt.id).sampleVersion = 1;
  await db.write();
  const kept = await sampleChat(ALICE);
  assert.equal(kept.sampleVersion, 1, "a copy the visitor used is never rewritten");
  assert.ok(kept.messages.length > 11);

  // So does deciding an offer: that conversation is theirs from then on.
  const decided = db.data.chats.find((chat) => chat.id === rebuilt.id);
  decided.sampleVersion = 1;
  decided.messages = olderTranscript();
  decided.messages.push({ id: "old-use", role: "assistant", kind: "offer", offerType: "use", toolId: "palindrome-checker-id", toolName: "palindrome-checker", taskText: "is kayak a palindrome", similarity: 0.94, resolved: "use", ts: Date.now() });
  await db.write();
  const keptAgain = await sampleChat(ALICE);
  assert.equal(keptAgain.sampleVersion, 1);
  assert.equal(keptAgain.messages.at(-1).resolved, "use");
});
