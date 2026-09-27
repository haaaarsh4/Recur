// Starting an OAuth sign in, over HTTP, with an origin that has a trailing
// slash. Providers compare redirect_uri character for character, so a stray
// slash used to build ".../app//api/auth/google/callback" and every deployed
// sign in died with redirect_uri_mismatch. These requests carry a real session
// cookie jar only in the sense that the browser would: the test just reads the
// redirect and the cookies the server hands back.
//
// Run with: npm --prefix server test

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEPLOYED_ORIGIN = "https://neural-recurr.vercel.app";
const TYPED_ORIGIN = `${DEPLOYED_ORIGIN}/`;

process.env.RECUR_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recur-oauth-")), "db.json");
process.env.CLIENT_ORIGIN = TYPED_ORIGIN;
process.env.SERVER_ORIGIN = "";
process.env.GOOGLE_CLIENT_ID = "google-client-id-for-tests";
process.env.GOOGLE_CLIENT_SECRET = "google-client-secret-for-tests";
process.env.GITHUB_CLIENT_ID = "github-client-id-for-tests";
process.env.GITHUB_CLIENT_SECRET = "github-client-secret-for-tests";

const { app } = await import("../src/app.js");
const { cleanOrigin, CLIENT_ORIGIN } = await import("../src/oauth.js");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const PROVIDERS = [
  { provider: "google", authorize: "https://accounts.google.com/o/oauth2/v2/auth" },
  { provider: "github", authorize: "https://github.com/login/oauth/authorize" },
];

function setCookies(res) {
  const header = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  return header.join("\n");
}

async function begin(provider) {
  const res = await fetch(`${base}/api/auth/${provider}`, { redirect: "manual" });
  return { res, location: res.headers.get("location") || "", cookies: setCookies(res) };
}

test("an origin typed with a trailing slash is normalised to the bare origin", () => {
  assert.equal(CLIENT_ORIGIN, DEPLOYED_ORIGIN);
  assert.equal(cleanOrigin(TYPED_ORIGIN), DEPLOYED_ORIGIN);
  assert.equal(cleanOrigin("  https://app.example.com///  "), "https://app.example.com");
  assert.equal(cleanOrigin(undefined), "");
  assert.equal(cleanOrigin(""), "");
});

for (const { provider, authorize } of PROVIDERS) {
  test(`${provider} sign in redirects to the provider with an exact callback`, async () => {
    const { res, location } = await begin(provider);
    assert.equal(res.status, 302);
    assert.ok(location.startsWith(authorize), `expected a redirect to ${authorize}, got ${location}`);

    const redirect = new URL(location);
    const expected = `${DEPLOYED_ORIGIN}/api/auth/${provider}/callback`;
    assert.equal(redirect.searchParams.get("redirect_uri"), expected);
    assert.ok(redirect.searchParams.get("state"), "a state value is sent to the provider");
  });

  test(`${provider} sign in returns the user to the clean origin`, async () => {
    const { cookies } = await begin(provider);
    const returnTo = cookies.split("\n").find((line) => line.startsWith("oauth_return_to="));
    assert.ok(returnTo, `expected an oauth_return_to cookie, got:\n${cookies}`);
    assert.equal(decodeURIComponent(returnTo.split(";")[0].slice("oauth_return_to=".length)), DEPLOYED_ORIGIN);
  });
}

test("the CORS header names the same clean origin", async () => {
  const res = await fetch(`${base}/api/health`, { headers: { origin: TYPED_ORIGIN } });
  assert.equal(res.headers.get("access-control-allow-origin"), DEPLOYED_ORIGIN);
});
