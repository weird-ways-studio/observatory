import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeRules, readLockLength, MIN_LOCK_SECONDS } from "../src/lock.ts";

const NOW = new Date("2026-11-01T11:00:00Z");
const DAY = 86_400;
const canary = { enabled: true, prefix: "canary/", condition: { type: "Indefinite" as const } };
const daily = (seconds: number, enabled = true) => ({ enabled, prefix: "daily/", condition: { type: "Age" as const, maxAgeSeconds: seconds } });

test("the live rules today (canary forever, daily/ 30 days) are OK", () => {
  assert.equal(MIN_LOCK_SECONDS, 30 * DAY);
  assert.deepEqual(judgeRules([canary, daily(2_592_000)], NOW), { verdict: "ok" });
});

test("a still-positive but shorter lock on daily/ is caught (the design's proof case)", () => {
  assert.deepEqual(judgeRules([canary, daily(29 * DAY)], NOW), { verdict: "short", reason: 'lock rule on "daily/" holds 29 days, under 30 days' });
  assert.equal(judgeRules([daily(3600)], NOW).verdict, "short");
});

test("no rule over daily/, or only a disabled one, is caught", () => {
  assert.deepEqual(judgeRules([canary], NOW), { verdict: "short", reason: "no enabled lock rule covers daily/" });
  assert.equal(judgeRules([canary, daily(30 * DAY, false)], NOW).verdict, "short");
  assert.equal(judgeRules([], NOW).verdict, "short");
});

test("a rule over only part of daily/ never counts as cover, and a shorter one there is caught", () => {
  const part = (seconds: number) => ({ enabled: true, prefix: "daily/open-brain/", condition: { type: "Age" as const, maxAgeSeconds: seconds } });
  assert.equal(judgeRules([part(60 * DAY)], NOW).verdict, "short");
  assert.equal(judgeRules([daily(30 * DAY), part(DAY)], NOW).verdict, "short");
});

test("a bucket-wide rule counts; Indefinite and far-enough dates hold, near dates do not", () => {
  assert.equal(judgeRules([{ enabled: true, condition: { type: "Indefinite" } }], NOW).verdict, "ok");
  assert.equal(judgeRules([{ enabled: true, prefix: "", condition: { type: "Date", date: "2026-12-15T00:00:00Z" } }], NOW).verdict, "ok");
  assert.equal(judgeRules([{ enabled: true, prefix: "", condition: { type: "Date", date: "2026-11-10T00:00:00Z" } }], NOW).verdict, "short");
});

test("a condition it does not understand is unverified, never OK", () => {
  const odd = { enabled: true, prefix: "daily/", condition: { type: "Retention", days: 90 } };
  assert.equal(judgeRules([odd as never], NOW).verdict, "unverified");
});

function reader(answer: () => Promise<Response>) {
  const seen: Request[] = [];
  const fetchFn = async (req: Request) => (seen.push(req), answer());
  return { seen, fetchFn };
}
const env = { LOCK_READ_TOKEN: "lock-read-token", LOCK_ACCOUNT_ID: "acct123" };
const ok = (rules: unknown) => async () => Response.json({ success: true, errors: [], result: { rules } });

test("without the read-only key it claims nothing and calls nothing", async () => {
  const r = reader(ok([]));
  assert.deepEqual(await readLockLength({}, r.fetchFn, NOW), { verdict: "not set up" });
  assert.deepEqual(await readLockLength({ LOCK_READ_TOKEN: "x" }, r.fetchFn, NOW), { verdict: "not set up" });
  assert.equal(r.seen.length, 0);
});

test("it reads this account's copy bucket with the key, and judges the answer", async () => {
  const r = reader(ok([canary, daily(30 * DAY)]));
  assert.deepEqual(await readLockLength(env, r.fetchFn, NOW), { verdict: "ok" });
  assert.equal(r.seen[0].method, "GET");
  assert.equal(r.seen[0].url, "https://api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/observatory-backups/lock");
  assert.equal(r.seen[0].headers.get("authorization"), "Bearer lock-read-token");
  assert.equal((await readLockLength(env, reader(ok([daily(DAY)])).fetchFn, NOW)).verdict, "short");
});

test("a refused, garbled or failed read is unverified, never OK, and quotes no URL", async () => {
  const answers = [
    async () => new Response("denied", { status: 403 }),
    async () => Response.json({ success: false, errors: [{ code: 10000 }] }),
    async () => Response.json({ success: true, result: {} }),
    async () => new Response("not json"),
    async () => { throw new Error("fetch to https://api.cloudflare.com/client/v4/accounts/acct123 failed"); },
  ];
  for (const a of answers) {
    const got = await readLockLength(env, reader(a).fetchFn, NOW);
    assert.equal(got.verdict, "unverified");
    assert.doesNotMatch(JSON.stringify(got), /acct123|lock-read-token/);
  }
  const refused = await readLockLength(env, reader(answers[0]).fetchFn, NOW);
  assert.deepEqual(refused, { verdict: "unverified", reason: "reading the lock rules answered 403" });
});
