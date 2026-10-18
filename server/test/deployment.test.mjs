// The deployed failure, as a test.
//
// The app runs on a serverless host where every instance gets its own writable
// store. The sample chat is created by the instance that answers the chat list,
// and the next click can be answered by a different instance that has never
// heard of it. On the deployed site that click was "Run palindrome-checker", and
// the answer was "Chat not found" for a conversation visible on screen, on the
// one path in the project that needs no model at all.
//
// So this test does not stop at one server. It starts two, with separate
// databases, and drives the exact requests the browser makes: the list, the
// decision, and the visitor's own question, alternating between the instances.
// The browser's copy of the conversation is in every request, because that is
// what the client sends, and adoption is what makes the second instance able to
// answer for a chat it has never seen.
//
// Run with: npm --prefix server test

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUEST = "deployed-guest-0001";
// Each test is a different visitor, so one test's decisions cannot change the
// state another one is about to assert on.
const OTHER = "deployed-guest-0002";
const THIRD = "deployed-guest-0003";
const FOURTH = "deployed-guest-0004";
const FIFTH = "deployed-guest-0005";
const SEVENTH = "deployed-guest-0007";

let first;
let second;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startInstance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recur-instance-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      RECUR_DB_PATH: path.join(dir, "db.json"),
      NODE_ENV: "production",
      JWT_SECRET: "deployment-test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`instance exited early:\n${log.join("")}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch (e) {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`instance never became healthy:\n${log.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { base, child, log };
}

before(async () => {
  [first, second] = await Promise.all([startInstance(), startInstance()]);
});

after(() => {
  first?.child.kill();
  second?.child.kill();
});

async function call(instance, pathname, { method = "GET", body, headers = {}, guest = GUEST } = {}) {
  const res = await fetch(instance.base + pathname, {
    method,
    headers: { "content-type": "application/json", "x-recur-guest": guest, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}

function lastOffer(messages, offerType) {
  return [...messages].reverse().find((message) => message.kind === "offer" && message.offerType === offerType);
}

test("the chat list carries the sample whole, so opening it needs no request", async () => {
  const list = await call(first, "/api/chats");
  assert.equal(list.status, 200);
  const sample = list.body.find((chat) => chat.sample);
  assert.ok(sample, "the visit was seeded");
  assert.ok(Array.isArray(sample.messages) && sample.messages.length > 5, "the sample arrives with its conversation");
  assert.equal(lastOffer(sample.messages, "use").offerType, "use");
});

// The old failure, preserved as the negative case: a conversation this instance
// has never stored is not found. Adoption is what changes the answer, and it has
// to be the request body that changes it, not a blanket "return the sample".
test("without the browser's copy, a second instance has never heard of the chat", async () => {
  const list = await call(first, "/api/chats", { guest: OTHER });
  const sample = list.body.find((chat) => chat.sample);
  const offer = lastOffer(sample.messages, "use");
  const missing = await call(second, `/api/chats/${sample.id}/offers/${offer.id}/resolve`, {
    method: "POST",
    guest: OTHER,
    body: { action: "use", tier: "default" },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "Chat not found.");
});

test("clicking Run on the second instance answers locally, with no model call", async () => {
  const list = await call(first, "/api/chats", { guest: THIRD });
  const sample = list.body.find((chat) => chat.sample);
  const offer = lastOffer(sample.messages, "use");

  const resolved = await call(second, `/api/chats/${sample.id}/offers/${offer.id}/resolve`, {
    method: "POST",
    guest: THIRD,
    body: { action: "use", tier: "default", chat: sample },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const answer = resolved.body.added.find((message) => message.programRun);
  assert.ok(answer, "the compiled program answered");
  assert.equal(answer.text, 'Yes, "kayak" is a palindrome.');
  assert.equal(answer.viaTool, "palindrome-checker");
  assert.equal(answer.tierApplied, undefined, "no model tier answered this one");
  assert.ok(answer.toolTrace?.length, "the run is traceable");
  assert.ok(answer.latency < 1000, `a local run took ${answer.latency}ms`);

  // The program that answered was compiled on this instance, from the same
  // demonstrations, so the registry here lists it too.
  const tools = await call(second, "/api/tools", { guest: THIRD });
  const checker = tools.body.find((tool) => tool.name === "palindrome-checker");
  assert.ok(checker, "the rebuilt program is in this instance's registry");
  assert.ok(checker.program && checker.program.version);
});

test("a visitor's own question gets the ask on an instance that has never seen the chat", async () => {
  const list = await call(first, "/api/chats", { guest: FOURTH });
  const sample = list.body.find((chat) => chat.sample);
  const offer = lastOffer(sample.messages, "use");
  const resolved = await call(second, `/api/chats/${sample.id}/offers/${offer.id}/resolve`, {
    method: "POST",
    guest: FOURTH,
    body: { action: "use", tier: "default", chat: sample },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));

  const asked = await call(second, `/api/chats/${sample.id}/messages`, {
    method: "POST",
    guest: FOURTH,
    body: { text: "is level a palindrome", tier: "default", chat: resolved.body.chat },
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const next = asked.body.added.at(-1);
  assert.equal(next.kind, "offer");
  assert.equal(next.offerType, "use");
  assert.equal(next.resolved, null);
  assert.equal(next.taskText, "is level a palindrome");
  assert.equal(next.toolName, "palindrome-checker");
  // Nothing answered it: not the program, and not the model.
  assert.equal(asked.body.added.some((message) => message.role === "assistant" && message.kind === "text"), false);

  // And accepting that offer back on the first instance still runs locally,
  // even though the offer names the program the second instance compiled.
  const accepted = await call(first, `/api/chats/${sample.id}/offers/${next.id}/resolve`, {
    method: "POST",
    guest: FOURTH,
    body: { action: "use", tier: "default", chat: asked.body.chat },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const answer = accepted.body.added.find((message) => message.programRun);
  assert.ok(answer, "the compiled program answered");
  assert.equal(answer.text, 'Yes, "level" is a palindrome.');
  assert.equal(answer.viaTool, "palindrome-checker");
});

test("a new chat started on one instance keeps working on another", async () => {
  const created = await call(first, "/api/chats", { method: "POST", guest: FIFTH, body: { title: "mine" } });
  assert.equal(created.status, 200);

  const sent = await call(second, `/api/chats/${created.body.id}/messages`, {
    method: "POST",
    guest: FIFTH,
    body: { text: "is noon a palindrome", tier: "default", chat: created.body },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const offer = sent.body.added.at(-1);
  assert.equal(offer.offerType, "use");
  assert.equal(offer.toolName, "palindrome-checker");
  assert.equal(offer.resolved, null);

  const accepted = await call(second, `/api/chats/${created.body.id}/offers/${offer.id}/resolve`, {
    method: "POST",
    guest: FIFTH,
    body: { action: "use", tier: "default", chat: sent.body.chat },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.added.find((message) => message.programRun).text, 'Yes, "noon" is a palindrome.');
});

// A copy that is older than the store must not be able to delete anything. A tab
// left open while another answered is the ordinary way this happens, and the
// conversation the server recorded has to survive it.
test("a stale copy cannot truncate the conversation this store recorded", async () => {
  const list = await call(first, "/api/chats", { guest: SEVENTH });
  const sample = list.body.find((chat) => chat.sample);
  const offer = lastOffer(sample.messages, "use");
  const resolved = await call(second, `/api/chats/${sample.id}/offers/${offer.id}/resolve`, {
    method: "POST",
    guest: SEVENTH,
    body: { action: "use", tier: "default", chat: sample },
  });
  assert.equal(resolved.status, 200);

  // The copy the visitor had before the answer came back.
  const stale = sample;
  const sent = await call(second, `/api/chats/${sample.id}/messages`, {
    method: "POST",
    guest: SEVENTH,
    body: { text: "is madam a palindrome", tier: "default", chat: stale },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const texts = sent.body.chat.messages.map((message) => message.text);
  assert.ok(texts.includes('Yes, "kayak" is a palindrome.'), "the answer already recorded was kept");
  assert.equal(texts.at(-2), "is madam a palindrome");
  assert.equal(sent.body.added.at(-1).offerType, "use");
});

// Adoption is for guests only. An account's history belongs to the server, so a
// request must never be able to write it, and that has to stay true even when the
// instance answering has no copy of the account's chats.
test("a signed-in account's history is never taken from a request body", async () => {
  const registered = await fetch(`${first.base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "deployed@example.com", password: "correct-horse-battery" }),
  });
  assert.equal(registered.status, 200);
  const token = (registered.headers.get("set-cookie") || "").match(/token=([^;]+)/)?.[1];
  assert.ok(token, "registration sets a session cookie");

  const created = await fetch(`${first.base}/api/chats`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `token=${token}` },
    body: JSON.stringify({ title: "account chat" }),
  }).then((res) => res.json());

  const attempt = await call(second, `/api/chats/${created.id}/messages`, {
    method: "POST",
    headers: { cookie: `token=${token}` },
    body: { text: "is radar a palindrome", tier: "default", chat: { ...created, messages: [] } },
  });
  assert.equal(attempt.status, 404);
  assert.equal(attempt.body.error, "Chat not found.");
});
