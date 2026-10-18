// A deployed Recur reaches the model through a Cloudflare tunnel. When that
// tunnel is not running, the edge answers with an HTML error page, and the
// server used to read any 404 as a missing Ollama model. That told people to
// run ollama pull while the real fault was the tunnel, so these tests pin each
// response shape to the message it should produce.
//
// Run with: npm --prefix server test

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.OLLAMA_BASE_URL = "https://recur-model.trycloudflare.com";

const { callLLM, testKey } = await import("../src/llm.js");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function html(status) {
  return new Response("<!doctype html><html><body>Cloudflare error 1033</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a tunnel error page is reported as an offline backend, not a missing model", async () => {
  globalThis.fetch = async () => html(404);
  await assert.rejects(callLLM("hello", "quick"), (err) => {
    assert.equal(err.code, "ollama_offline");
    assert.match(err.message, /Cloudflare tunnel/);
    assert.doesNotMatch(err.message, /ollama pull/);
    return true;
  });
});

test("a 200 that is an HTML error page is still an offline backend", async () => {
  globalThis.fetch = async () => html(200);
  await assert.rejects(callLLM("hello", "quick"), (err) => {
    assert.equal(err.code, "ollama_offline");
    assert.match(err.message, /Cloudflare tunnel/);
    return true;
  });
});

test("a tunnel edge 530 is an offline backend", async () => {
  globalThis.fetch = async () => html(530);
  await assert.rejects(callLLM("hello", "quick"), (err) => {
    assert.equal(err.code, "ollama_offline");
    return true;
  });
});

test("Ollama's own JSON 404 still asks for the model to be pulled", async () => {
  globalThis.fetch = async () =>
    json(404, { error: "model 'smollm2:135m-instruct-q8_0' not found, try pulling it first" });
  await assert.rejects(callLLM("hello", "quick"), (err) => {
    assert.equal(err.code, "model_not_found");
    assert.match(err.message, /ollama pull smollm2/);
    assert.doesNotMatch(err.message, /Cloudflare tunnel/);
    return true;
  });
});

test("a refused connection names the tunnel", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(callLLM("hello", "quick"), (err) => {
    assert.equal(err.code, "ollama_offline");
    assert.match(err.message, /Cloudflare tunnel/);
    return true;
  });
});

test("testing the Ollama connection points at the tunnel when the host is remote", async () => {
  globalThis.fetch = async () => html(503);
  const result = await testKey("ollama");
  assert.equal(result.ok, false);
  assert.match(result.error, /Cloudflare tunnel/);
});
