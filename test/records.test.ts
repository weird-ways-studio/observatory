import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { FRESH_CRON } from "../src/fresh.ts";
import { checkOrder, checkRecord, DAY_CAP, MAX_RECORD_BYTES, MIN_LOCK_SECONDS, runRecords, shown, STATE_KEY, SWEEP_HOUR, type RecordsEnv, type Stored } from "../src/records.ts";

const NOW = new Date("2026-11-01T12:30:00Z");
const MIN = 60_000;
const at = (m: number) => new Date(NOW.getTime() + m * MIN);
const G = "grant-0001";
const key = (stage: string, grant = G, date = "2026-11-01") => `records/v1/${date}/${grant}/${stage}.json`;
const body = (stage: string, when: Date, over: object = {}, grant = G) => JSON.stringify({ v: 1, grant, stage, at: when.toISOString(), job: "test.echo", ...over });

// An R2 bucket in memory: list with prefix, delimiter and pages of `pageSize`; get; put.
function bucket(pageSize = 1000) {
  const store = new Map<string, { body: string; uploaded: Date; size?: number }>();
  const gets: string[] = [];
  let failList = false;
  return {
    store, gets,
    failList: () => { failList = true; },
    add(k: string, b: string, uploaded: Date, size?: number) { store.set(k, { body: b, uploaded, size }); },
    async list(o: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }) {
      if (failList) throw new Error("R2 down");
      const prefix = o.prefix ?? "", start = Number(o.cursor ?? 0);
      const objects: R2Object[] = [], prefixes = new Set<string>();
      for (const k of [...store.keys()].sort().filter((x) => x.startsWith(prefix))) {
        const rest = k.slice(prefix.length), cut = o.delimiter ? rest.indexOf(o.delimiter) : -1;
        if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
        else {
          const v = store.get(k)!;
          objects.push({ key: k, size: v.size ?? v.body.length, uploaded: v.uploaded } as R2Object);
        }
      }
      const page = objects.slice(start, start + pageSize), more = start + pageSize < objects.length;
      return { objects: page, delimitedPrefixes: [...prefixes], truncated: more, cursor: more ? String(start + pageSize) : undefined } as R2Objects;
    },
    async get(k: string) {
      gets.push(k);
      const v = store.get(k);
      return v ? ({ text: async () => v.body } as R2ObjectBody) : null;
    },
    async put(k: string, b: string) { store.set(k, { body: b, uploaded: NOW }); return {} as R2Object; },
  };
}

function wire(lockRules?: object[]) {
  const calls: { host: string; path: string; body: string }[] = [];
  const fetch = async (req: Request) => {
    const url = new URL(req.url);
    calls.push({ host: url.hostname, path: url.pathname, body: await req.text() });
    if (url.hostname === "api.cloudflare.com") return Response.json({ success: true, result: { rules: lockRules ?? [] } });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetch, pushes: () => calls.filter((c) => c.host === "api.pushover.net"), hc: () => calls.filter((c) => c.host === "hc-records.example").map((c) => c.path) };
}

const env = (records: ReturnType<typeof bucket> | undefined, over: Partial<RecordsEnv> = {}): RecordsEnv => ({
  RECORDS: records,
  COPY: bucket(),
  PING_URL: "https://hc-backup.example/night",
  PING_URL_RECORDS: "https://hc-records.example/rec",
  PUSHOVER_TOKEN: "a".repeat(30),
  PUSHOVER_USER: "b".repeat(30),
  ...over,
});

/** A grant written in order: request, verdict, approval, result, a minute apart. */
function wholeGrant(b: ReturnType<typeof bucket>, grant = G, start = -10) {
  ["request", "verdict", "approval", "result"].forEach((s, i) => b.add(key(s, grant), body(s, at(start + i), {}, grant), at(start + i)));
}

const stored = (k: string, uploaded = NOW, size = 100): Stored => ({ key: k, size, uploaded });

test("a grant recorded in order is healthy, and the run pings its own check", async () => {
  const b = bucket(), w = wire();
  wholeGrant(b);
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.equal(r.records, "healthy");
  assert.equal(r.checked, 4);
  assert.deepEqual(w.hc(), ["/rec"]);
  assert.equal(w.pushes().length, 0);
});

test("a result with no earlier request is 'ran unrecorded'", () => {
  const f = checkOrder([stored(key("approval"), at(-2)), stored(key("result"), at(-1))]);
  assert.match(f.map((x) => x.text).join(), /ran unrecorded/);
});

test("a request stored after the result does not count as earlier", () => {
  const f = checkOrder([stored(key("result"), at(-3)), stored(key("approval"), at(-4)), stored(key("request"), at(-2))]);
  assert.equal(f[0].id, `unrecorded:${G}`);
});

test("a result with a request but no approval is flagged", () => {
  const f = checkOrder([stored(key("request"), at(-3)), stored(key("result"), at(-1))]);
  assert.deepEqual(f.map((x) => x.id), [`unapproved:${G}`]);
});

test("an approval or verdict with no earlier request is flagged", () => {
  const f = checkOrder([stored(key("approval"), at(-3)), stored(key("verdict"), at(-2))]);
  assert.deepEqual(f.map((x) => x.id).sort(), [`approval-first:${G}`, `verdict-first:${G}`]);
});

test("a request with nothing after it yet is fine (Ben has not tapped)", () => {
  assert.deepEqual(checkOrder([stored(key("request"))]), []);
});

test("a record whose own time is far from when R2 stored it is backdated", () => {
  const f = checkRecord(stored(key("request"), NOW), body("request", at(-11)));
  assert.match(f[0].text, /more than 10 minutes/);
  assert.deepEqual(checkRecord(stored(key("request"), NOW), body("request", at(-9))), []);
});

test("a record filed under another day than its time is flagged", () => {
  const f = checkRecord(stored(key("request", G, "2026-10-31")), body("request", NOW));
  assert.match(f[0].text, /filed under 2026-10-31/);
});

test("each broken body is flagged with its reason", () => {
  const cases: [string, RegExp][] = [
    ["not json", /not JSON/],
    ["[]", /not a JSON object/],
    [JSON.stringify({ v: 2 }), /not version 1/],
    [body("approval", NOW), /different grant or stage/],
    [body("request", NOW, {}, "grant-9999"), /different grant or stage/],
    [body("request", NOW, { job: "Bad Job" }), /no valid job name/],
    [body("request", NOW, { at: "yesterday" }), /no valid `at`/],
    [body("request", NOW, { params: { api_token: "x" } }), /has 1 field named like a secret$/],
    [body("request", NOW, { at: "November 1, 2026 12:30" }), /no valid `at`/],
  ];
  for (const [b, why] of cases) assert.match(checkRecord(stored(key("request")), b)[0]?.text ?? "none", why, b);
});

test("an oversized record is flagged by size and never downloaded", async () => {
  const b = bucket(), w = wire();
  b.add(key("request"), body("request", NOW), NOW, MAX_RECORD_BYTES + 1);
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.equal(r.records, "findings");
  assert.match(r.reason, /over 8192/);
  assert.deepEqual(b.gets, []);
});

test("anything outside records/v1/ is a stray, files and folders alike", async () => {
  const b = bucket(), w = wire();
  b.add("notes.txt", "hi", NOW);
  b.add("records/v2/x.json", "{}", NOW);
  b.add("records/v1/2026-11-01/short/request.json", body("request", NOW), NOW);
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.match(r.reason, /object outside the record format: notes\.txt/);
  assert.match(r.reason, /folder outside the record format: records\/v2\//);
  assert.match(r.reason, /object outside the record format: records\/v1\/2026-11-01\/short/);
});

test("a day over the cap alerts, reads no more than the cap, and follows R2's pages", async () => {
  const b = bucket(100), w = wire();
  for (let i = 0; i <= DAY_CAP; i++) b.add(key("request", `grant-${String(i).padStart(4, "0")}`), body("request", NOW, {}, `grant-${String(i).padStart(4, "0")}`), NOW);
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.match(r.reason, new RegExp(`${DAY_CAP + 1} records on 2026-11-01, over the cap`));
  assert.equal(b.gets.length, DAY_CAP);
});

test("yesterday's folder is read too, so a grant across midnight stays in order", async () => {
  const b = bucket(), w = wire(), midnight = new Date("2026-11-01T00:00:30Z");
  b.add(key("request", G, "2026-10-31"), body("request", new Date("2026-10-31T23:59:00Z")), new Date("2026-10-31T23:59:00Z"));
  b.add(key("approval"), body("approval", midnight), midnight);
  b.add(key("result"), body("result", midnight), midnight);
  const r = await runRecords(env(b), w.fetch, new Date("2026-11-01T00:30:00Z"));
  assert.equal(r.records, "healthy", r.reason);
});

test("a finding alerts once, stays quiet while it lasts, and alerts again if it comes back", async () => {
  const b = bucket(), copy = bucket(), w = wire();
  b.add(key("result"), body("result", NOW), NOW);
  const e = env(b, { COPY: copy });
  await runRecords(e, w.fetch, NOW);
  await runRecords(e, w.fetch, NOW);
  assert.equal(w.pushes().length, 1);
  assert.deepEqual(w.hc(), ["/rec/fail", "/rec/fail"]); // bad every hour, told once
  b.store.clear();
  await runRecords(e, w.fetch, NOW);
  assert.deepEqual(JSON.parse(copy.store.get(STATE_KEY)!.body), { alerted: [] });
  b.add(key("result"), body("result", NOW), NOW);
  await runRecords(e, w.fetch, NOW);
  assert.equal(w.pushes().length, 2);
});

test("without its own check it only logs: no alert, nothing claims healthy", async () => {
  const b = bucket(), w = wire();
  b.add(key("result"), body("result", NOW), NOW);
  const r = await runRecords(env(b, { PING_URL_RECORDS: undefined }), w.fetch, NOW);
  assert.equal(r.setup, "PING_URL_RECORDS not set: log only");
  assert.equal(w.calls.length, 0);
});

test("no binding, or a list that fails, is unverified, never healthy", async () => {
  const w1 = wire();
  assert.equal((await runRecords(env(undefined), w1.fetch, NOW)).records, "unverified");
  assert.equal(w1.pushes().length, 1);
  const b = bucket(), w2 = wire();
  b.failList();
  const r = await runRecords(env(b), w2.fetch, NOW);
  assert.equal(r.records, "unverified");
  assert.equal(r.reason, "the records could not be listed");
  assert.equal(w2.pushes().length, 1);
});

test("the records lock is read and a short one is a finding; no key yet claims nothing", async () => {
  const b = bucket(), lockEnv = { LOCK_READ_TOKEN: "t".repeat(40), LOCK_ACCOUNT_ID: "f".repeat(32) };
  wholeGrant(b);
  const short = wire([{ enabled: true, prefix: "records/", condition: { type: "Age", maxAgeSeconds: 30 * 86_400 } }]);
  const r = await runRecords(env(b, lockEnv), short.fetch, NOW);
  assert.equal(r.lock, "short");
  assert.match(r.reason, /records lock: lock rule on "records\/" holds 30 days/);
  assert.ok(short.calls.some((c) => c.path.endsWith("/r2/buckets/observatory-records/lock")));
  const ok = wire([{ enabled: true, prefix: "records/", condition: { type: "Age", maxAgeSeconds: MIN_LOCK_SECONDS } }]);
  assert.equal((await runRecords(env(b, lockEnv), ok.fetch, NOW)).records, "healthy");
  assert.equal((await runRecords(env(b), wire().fetch, NOW)).lock, "not set up");
});

test("the hourly cron runs the records check as its own job", async () => {
  const b = bucket(), w = wire(), jobs: Promise<unknown>[] = [];
  wholeGrant(b);
  const origFetch = globalThis.fetch;
  globalThis.fetch = w.fetch as typeof fetch;
  try {
    await worker.scheduled({ cron: FRESH_CRON } as ScheduledController, { ...env(b), DEPLOYED_SHA: "a".repeat(40) } as never, { waitUntil: (p: Promise<unknown>) => jobs.push(p) } as unknown as ExecutionContext);
    await Promise.all(jobs);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(jobs.length, 2);
  assert.ok(w.calls.some((c) => c.host === "hc-records.example"));
});

test("what the writer chose is never echoed raw: secret names, its time, odd characters in names", () => {
  const f = checkRecord(stored(key("request")), body("request", NOW, { params: { "sk_live_ABC123token": "x" } }));
  assert.doesNotMatch(f[0].text, /sk_live/);
  const late = checkRecord(stored(key("request"), NOW), body("request", at(-30)));
  assert.match(late[0].text, /2026-11-01T12:00:00\.000Z/);
  assert.equal(shown("a b\nc<script>".repeat(10)).length, 60);
  assert.match(shown("x y\n"), /^x\?y\?$/);
});

test("folders that are not a real date, or are in the future, are flagged every hour", async () => {
  const b = bucket(), w = wire();
  b.add(key("request", G, "2099-01-01"), body("request", NOW), NOW);
  b.add("records/v1/2026-13-45/grant-0001/request.json", "{}", NOW);
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.match(r.reason, /future day: records\/v1\/2099-01-01\//);
  assert.match(r.reason, /folder outside the record format: records\/v1\/2026-13-45\//);
});

test("once a day every record is swept: one stored today into an old folder is caught", async () => {
  const b = bucket(), w = wire(), sweepTime = new Date(`2026-11-01T0${SWEEP_HOUR}:30:00Z`);
  b.add(key("result", G, "2026-10-20"), body("result", new Date("2026-10-20T12:00:00Z")), sweepTime);
  b.add(key("request", "grant-0002", "2026-10-20"), body("request", new Date("2026-10-20T12:00:00Z"), {}, "grant-0002"), new Date("2026-10-20T12:00:00Z"));
  const quiet = await runRecords(env(b), w.fetch, new Date("2026-11-01T12:30:00Z"));
  assert.equal(quiet.records, "healthy", "outside the sweep hour, old folders are not listed");
  const r = await runRecords(env(b), w.fetch, sweepTime);
  assert.match(r.reason, /grant-0001\/result was stored 2026-11-01 into the 2026-10-20 folder/);
  assert.doesNotMatch(r.reason, /grant-0002/);
});

test("an alert holds what fits, worst first; the rest are told next hour", async () => {
  const b = bucket(), copy = bucket(), w = wire();
  for (let i = 0; i < 30; i++) b.add(`stray-${String(i).padStart(2, "0")}-${"x".repeat(40)}`, "x", NOW);
  b.add(key("result"), body("result", NOW), NOW);
  const e = env(b, { COPY: copy });
  await runRecords(e, w.fetch, NOW);
  const first = new URLSearchParams(w.pushes()[0].body).get("message")!;
  assert.match(first.split("\n")[0], /ran unrecorded/);
  assert.match(first, /\(\+\d+ more, sent next hour\)/);
  const told1 = JSON.parse(copy.store.get(STATE_KEY)!.body).alerted.length;
  assert.ok(told1 < 31);
  for (let h = 0; h < 5; h++) await runRecords(e, w.fetch, NOW);
  assert.equal(JSON.parse(copy.store.get(STATE_KEY)!.body).alerted.length, 31);
  assert.doesNotMatch(new URLSearchParams(w.pushes().at(-1)!.body).get("message")!, /more, sent next hour/);
});
