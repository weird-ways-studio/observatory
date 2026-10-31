import { test } from "node:test";
import assert from "node:assert/strict";
import { alert, deliveryTest, redact, TEST_MARKER } from "../src/alert.ts";

const KEYS = { PUSHOVER_TOKEN: "a".repeat(30), PUSHOVER_USER: "u".repeat(30) };
const ENV = { PING_URL: "https://hc.example/check", ...KEYS };

// Records every call; Pushover answers `pushover` (a status, or "throw" for a network error).
function wire(pushover: number | "throw" = 200) {
  const calls: { host: string; path: string; body: string }[] = [];
  const fetch = async (req: Request) => {
    const url = new URL(req.url);
    calls.push({ host: url.hostname, path: url.pathname, body: await req.text() });
    if (url.hostname === "api.pushover.net") {
      if (pushover === "throw") throw new Error(`connect failed with token ${KEYS.PUSHOVER_TOKEN}`);
      return new Response('{"status":1}', { status: pushover });
    }
    return new Response("OK");
  };
  return { calls, fetch };
}

test("an alert goes to Pushover with Ben's keys, title and text, and nowhere else", async () => {
  const w = wire();
  assert.equal(await alert(ENV, w.fetch, "Observatory: x", "two problems"), "pushover");
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].path, "/1/messages.json");
  const form = new URLSearchParams(w.calls[0].body);
  assert.deepEqual(Object.fromEntries(form), { token: KEYS.PUSHOVER_TOKEN, user: KEYS.PUSHOVER_USER, title: "Observatory: x", message: "two problems" });
});

for (const [why, answer] of [["refused (wrong token)", 400], ["over quota", 429], ["unreachable", "throw"]] as const) {
  test(`Pushover ${why}: the same text falls back to healthchecks /fail, without the error's words`, async () => {
    const w = wire(answer);
    assert.equal(await alert(ENV, w.fetch, "Observatory: x", "two problems"), "healthchecks");
    const hc = w.calls.filter((c) => c.host === "hc.example");
    assert.equal(hc.length, 1);
    assert.equal(hc[0].path, "/check/fail");
    assert.match(hc[0].body, /Observatory: x\ntwo problems/);
    assert.ok(!hc[0].body.includes(KEYS.PUSHOVER_TOKEN));
  });
}

test("no Pushover keys, or malformed ones: straight to healthchecks, Pushover never called", async () => {
  for (const env of [{ PING_URL: ENV.PING_URL }, { ...ENV, PUSHOVER_TOKEN: "short" }]) {
    const w = wire();
    assert.equal(await alert(env, w.fetch, "t", "x"), "healthchecks");
    assert.deepEqual(w.calls.map((c) => c.host), ["hc.example"]);
  }
});

test("alert text never carries a secret value or a secret URL's host (T1)", async () => {
  const env = { ...ENV, SOURCE_SECRET_ACCESS_KEY: "s3cr3t-value", SOURCE_ENDPOINT: "https://acct123.r2.example" };
  const w = wire();
  await alert(env, w.fetch, "t", "fetch https://acct123.r2.example/b failed; key s3cr3t-value; host acct123.r2.example; ping https://hc.example/check");
  const message = new URLSearchParams(w.calls[0].body).get("message") ?? "";
  for (const secret of ["s3cr3t-value", "acct123", "hc.example"]) assert.ok(!message.includes(secret), secret);
  assert.equal(redact("plain words", env), "plain words");
});

test("Pushover's limits: message cut to 1024 characters, title to 250", async () => {
  const w = wire();
  await alert(ENV, w.fetch, "t".repeat(400), "m".repeat(5000));
  const form = new URLSearchParams(w.calls[0].body);
  assert.equal(form.get("message")?.length, 1024);
  assert.equal(form.get("title")?.length, 250);
});

class Marker {
  store = new Map<string, string>();
  async head(key: string) { return this.store.has(key) ? ({} as R2Object) : null; }
  async put(key: string, v: string) { this.store.set(key, v); return {} as R2Object; }
}
const NOW = new Date("2026-11-01T11:00:00Z");

test("day-one delivery test: fallback email once, then the Pushover test, then never again", async () => {
  const w = wire(), bucket = new Marker();
  assert.deepEqual(await deliveryTest(ENV, w.fetch, bucket as never, NOW), { fallback: "healthchecks", pushover: "pushover" });
  assert.deepEqual(w.calls.map((c) => `${c.host}${c.path}`), ["hc.example/check/fail", "api.pushover.net/1/messages.json"]);
  assert.equal(new URLSearchParams(w.calls[1].body).get("title"), "Observatory test");
  assert.equal(bucket.store.get(TEST_MARKER), NOW.toISOString());
  assert.equal(await deliveryTest(ENV, w.fetch, bucket as never, NOW), undefined);
  assert.equal(w.calls.length, 2);
});

test("delivery test: not run before the Pushover secrets exist; retried if Pushover did not deliver", async () => {
  const w = wire(400), bucket = new Marker();
  assert.equal(await deliveryTest({ PING_URL: ENV.PING_URL }, w.fetch, bucket as never, NOW), undefined);
  assert.equal(w.calls.length, 0);
  assert.equal((await deliveryTest(ENV, w.fetch, bucket as never, NOW))?.pushover, "healthchecks");
  assert.equal(bucket.store.has(TEST_MARKER), false);
});
