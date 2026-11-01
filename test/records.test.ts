import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { FRESH_CRON } from "../src/fresh.ts";
import { DAY_CAP, keyFor, MAX_STORED_BYTES, sha256, type Stage } from "../src/contract.ts";
import { Ledger, type Storage } from "../src/recorder/ledger.ts";
import { MAX_QUEUED, MIN_LOCK_SECONDS, PAGE, runRecords, STATE_KEY, SWEEP_HOUR, type RecordsEnv } from "../src/records.ts";

const NOW = new Date("2026-11-01T12:30:00Z");
const MIN = 60_000;
const at = (m: number) => new Date(NOW.getTime() + m * MIN);
const G = "grant-0001";

// An R2 bucket in memory: list with prefix, delimiter, startAfter and pages; get; head; put.
function bucket(pageSize = 1000) {
  const store = new Map<string, { body: string; uploaded: Date; size?: number; sha?: string }>();
  let failList = false, clock = NOW;
  const unreadable = new Set<string>();
  return {
    store, unreadable,
    failList: () => { failList = true; },
    setClock(d: Date) { clock = d; },
    add(k: string, b: string, uploaded: Date, size?: number) { store.set(k, { body: b, uploaded, size }); },
    async list(o: { prefix?: string; delimiter?: string; cursor?: string; startAfter?: string; limit?: number }) {
      if (failList) throw new Error("R2 down");
      const prefix = o.prefix ?? "", start = Number(o.cursor ?? 0), limit = Math.min(o.limit ?? 1000, pageSize);
      const objects: R2Object[] = [], prefixes = new Set<string>();
      for (const k of [...store.keys()].sort().filter((x) => x.startsWith(prefix) && (!o.startAfter || x > o.startAfter))) {
        const rest = k.slice(prefix.length), cut = o.delimiter ? rest.indexOf(o.delimiter) : -1;
        if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
        else {
          const v = store.get(k)!;
          objects.push({ key: k, size: v.size ?? v.body.length, uploaded: v.uploaded } as R2Object);
        }
      }
      const page = objects.slice(start, start + limit), more = start + limit < objects.length;
      return { objects: page, delimitedPrefixes: [...prefixes], truncated: more, cursor: more ? String(start + limit) : undefined } as R2Objects;
    },
    async get(k: string) {
      const v = store.get(k);
      if (unreadable.has(k)) throw new Error("read failed");
      return v ? ({ text: async () => v.body } as R2ObjectBody) : null;
    },
    async head(k: string) { const v = store.get(k); return v ? ({ key: k, customMetadata: { sha256: v.sha } } as unknown as R2Object) : null; },
    async put(k: string, b: string, o?: R2PutOptions) { store.set(k, { body: b, uploaded: clock, sha: o?.customMetadata?.sha256 }); return {} as R2Object; },
  };
}
type B = ReturnType<typeof bucket>;

function memory(): Storage {
  const m = new Map<string, unknown>();
  return { async get<T>(k: string) { return structuredClone(m.get(k)) as T | undefined; }, async put(e) { for (const [k, v] of Object.entries(e)) m.set(k, structuredClone(v)); }, async delete(k) { return m.delete(k); } };
}
const rec = (stage: string, over: object = {}, grant = G) => JSON.stringify({ v: 1, grant, stage, job: "cf.token.canary", ...over });

/** Records written the real way, through the recorder's ledger, each stored at its own minute. */
async function viaRecorder(b: B, grants = [G], start = -10, stages: Stage[] = ["request", "verdict", "approval", "result"]) {
  const l = new Ledger(memory(), b);
  let m = start;
  for (const g of grants) {
    const req = rec("request", {}, g), h = await sha256(req);
    for (const s of stages) {
      const when = at(m++);
      b.setClock(when);
      await l.accept(s === "request" ? req : rec(s, { request: h }, g), () => when);
    }
  }
  return l;
}
/** A record placed straight into the bucket, as something around the recorder would. */
async function planted(b: B, seq: number, grant: string, stage: Stage, uploaded: Date, over: { body?: string; envelope?: object; request?: string } = {}) {
  const body = over.body ?? rec(stage, stage === "request" ? {} : { request: over.request ?? "a".repeat(64) }, grant);
  const env = { v: 1, seq, grant, stage, recorded_at: uploaded.toISOString(), sha256: await sha256(body), body, ...over.envelope };
  b.add(keyFor(seq, grant, stage), JSON.stringify(env), uploaded);
}

function wire(lockRules?: object[], pushover = 200, hc = 200) {
  const calls: { host: string; path: string; body: string }[] = [];
  const fetch = async (req: Request) => {
    const url = new URL(req.url);
    calls.push({ host: url.hostname, path: url.pathname, body: await req.text() });
    if (url.hostname === "api.cloudflare.com") return Response.json({ success: true, result: { rules: lockRules ?? [] } });
    if (url.hostname === "api.pushover.net") return new Response("{}", { status: pushover });
    return new Response("{}", { status: hc });
  };
  return { calls, fetch, pushes: () => calls.filter((c) => c.host === "api.pushover.net"), hc: () => calls.filter((c) => c.host === "hc-records.example").map((c) => c.path) };
}
const env = (records: B | undefined, over: Partial<Omit<RecordsEnv, "COPY">> = {}): RecordsEnv & { COPY: B } => ({
  RECORDS: records,
  COPY: bucket(),
  PING_URL: "https://hc-backup.example/night",
  PING_URL_RECORDS: "https://hc-records.example/rec",
  PUSHOVER_TOKEN: "a".repeat(30),
  PUSHOVER_USER: "b".repeat(30),
  ...over,
});
const ids = async (e: RecordsEnv & { COPY: B }) => JSON.parse(e.COPY.store.get(STATE_KEY)!.body).alerted as string[];
const reasonOf = async (b: B, now = NOW) => (await runRecords(env(b), wire().fetch, now)).reason;

test("grants recorded through the recorder are healthy, and the run pings its own check", async () => {
  const b = bucket(), w = wire();
  await viaRecorder(b, [G, "grant-0002"]);
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.deepEqual([r.records, r.checked, r.seq], ["healthy", 8, 8]);
  assert.deepEqual(w.hc(), ["/rec"]);
  assert.equal(w.pushes().length, 0);
});

test("the bookmark: each hour reads only what is new, and a grant across midnight stays in order", async () => {
  const b = bucket(), e = env(b), l = new Ledger(memory(), b);
  const req = rec("request"), h = await sha256(req);
  const t1 = new Date("2026-11-01T23:59:00Z");
  b.setClock(t1);
  await l.accept(req, () => t1);
  assert.equal((await runRecords(e, wire().fetch, new Date("2026-11-02T00:30:00Z"))).checked, 1);
  for (const [s, t] of [["approval", "2026-11-02T00:31:00Z"], ["result", "2026-11-02T00:32:00Z"]] as const) {
    b.setClock(new Date(t));
    await l.accept(rec(s, { request: h }), () => new Date(t));
  }
  const two = await runRecords(e, wire().fetch, new Date("2026-11-03T01:30:00Z"));
  assert.deepEqual([two.records, two.checked, two.seq], ["healthy", 2, 3]);
  assert.equal((await runRecords(e, wire().fetch, new Date("2026-11-03T02:30:00Z"))).checked, 0);
});

test("order: result with no request is 'ran unrecorded'; no approval; approval or verdict first", async () => {
  const b = bucket();
  await planted(b, 1, "grant-aaaa", "result", at(-5));
  await planted(b, 2, "grant-bbbb", "request", at(-4));
  const h = await sha256(rec("request", {}, "grant-bbbb"));
  await planted(b, 3, "grant-bbbb", "result", at(-3), { request: h });
  await planted(b, 4, "grant-cccc", "approval", at(-2));
  await planted(b, 5, "grant-dddd", "verdict", at(-1));
  const why = await reasonOf(b);
  assert.match(why, /grant grant-aaaa has a result with no request record before it: something ran unrecorded/);
  assert.match(why, /grant grant-bbbb has a result with no approval record before it/);
  assert.match(why, /grant grant-cccc has an approval with no request record before it/);
  assert.match(why, /grant grant-dddd has a verdict with no request record before it/);
});

test("r1 #3: a second stage for a grant is flagged, so a later duplicate cannot hide an earlier bad result", async () => {
  const b = bucket(), h = await sha256(rec("request"));
  await planted(b, 1, G, "request", at(-5));
  await planted(b, 2, G, "result", at(-4), { request: h }); // result before approval
  await planted(b, 3, G, "approval", at(-3), { request: h });
  await planted(b, 4, G, "result", at(-2), { request: h });
  const why = await reasonOf(b);
  assert.match(why, /grant grant-0001 has a result with no approval record before it/);
  assert.match(why, /grant grant-0001 has a second result record/);
});

test("a later record naming another request or job is a mismatch", async () => {
  const b = bucket();
  await planted(b, 1, G, "request", at(-5));
  await planted(b, 2, G, "approval", at(-4), { request: "f".repeat(64) });
  assert.match(await reasonOf(b), /grant grant-0001: a later record names a different request or job than its request record/);
});

test("r1 #1 and r1 #8: names out of sequence are gaps; ties are impossible because order is the recorder's number", async () => {
  const b = bucket();
  await viaRecorder(b, [G], -10, ["request"]);
  await planted(b, 7, "grant-late", "request", at(-1));
  assert.match(await reasonOf(b), /record numbers jumped from 1 to 7/);
});

test("security review: a planted name past every record never parks the bookmark; later real records are still read", async () => {
  const b = bucket(), e = env(b), l = new Ledger(memory(), b);
  b.add("records/v1/zzz-planted", "{}", at(-30));
  await planted(b, 999_999_999_999, "grant-planted", "request", at(-30));
  const req = rec("request"), h = await sha256(req);
  b.setClock(at(-20));
  await l.accept(req, () => at(-20));
  const first = await runRecords(e, wire().fetch, NOW);
  assert.equal(first.checked, 1);
  // The stray sorts after the jump, so this hour stops before it; the jump alerts and the daily count covers both.
  assert.match(first.reason, /record numbers jumped from 1 to 999999999999: reading stops there/);
  // The next real records, numbered 2 and 3, are read on the next hour despite the planted names.
  for (const [s, m] of [["approval", 1], ["result", 2]] as const) { b.setClock(at(m)); await l.accept(rec(s, { request: h }), () => at(m)); }
  const second = await runRecords(e, wire().fetch, at(60));
  assert.deepEqual([second.checked, second.seq], [2, 3]);
  assert.match(second.reason, /reading stops there/); // still reported while it stays
});

test("security review: a stray name that sorts after every record is reported each hour and never hides new records", async () => {
  const b = bucket(), e = env(b), l = new Ledger(memory(), b);
  b.add("records/v1/zzz-planted", "{}", at(-30));
  const req = rec("request"), h = await sha256(req);
  b.setClock(at(-20));
  await l.accept(req, () => at(-20));
  const first = await runRecords(e, wire().fetch, NOW);
  assert.equal(first.checked, 1);
  assert.match(first.reason, /something outside the record format/);
  b.setClock(at(1));
  await l.accept(rec("approval", { request: h }), () => at(1));
  const second = await runRecords(e, wire().fetch, at(60));
  assert.deepEqual([second.checked, second.seq], [1, 2]);
  assert.match(second.reason, /something outside the record format/);
});

test("security review: grant ids that are built-in object names cannot crash or corrupt the checker", async () => {
  const b = bucket();
  await viaRecorder(b, ["constructor", "hasOwnProperty"]);
  const r = await runRecords(env(b), wire().fetch, NOW);
  assert.deepEqual([r.records, r.checked], ["healthy", 8]);
});

test("anything not named by the recorder is a stray, anywhere in the bucket, and its name is never repeated", async () => {
  const b = bucket();
  await viaRecorder(b);
  b.add("records/v1/2026-10-29/grant-0001/result.json", "{}", at(-1));
  b.add("records/v1/zzz-password_MARKER", "{}", at(-1));
  b.add("records/other/x", "{}", at(-1));
  b.add("loose_SECRET_NAME", "{}", at(-1));
  const why = await reasonOf(b);
  assert.equal((why.match(/something outside the record format, fingerprint [0-9a-f]{12}/g) ?? []).length, 4);
  assert.ok(!/MARKER|SECRET_NAME|2026-10-29|other/.test(why), why);
});

test("each broken stored record is flagged with a fixed reason", async () => {
  const b = bucket(), cases: [object, RegExp][] = [
    [{ envelope: { seq: 99 } }, /its envelope does not match its name/],
    [{ envelope: { recorded_at: at(-60).toISOString() } }, /its recorded time is missing or far from when it was stored/],
    [{ envelope: { sha256: "0".repeat(64) } }, /its body does not match its hash/],
    [{ body: rec("request", { params: { password_MARKER: 1 } }) }, /a field named like a secret, or nested too deep/],
    [{ body: rec("request", {}, "grant-other") }, /its body names a different grant or stage than its name/],
  ];
  let seq = 0;
  for (const [over] of cases) { seq++; await planted(b, seq, `grant-${String(seq).padStart(4, "0")}`, "request", at(-5 + seq), over); }
  b.add(keyFor(++seq, "grant-json", "request"), "not json", at(0));
  const why = await reasonOf(b);
  for (const [, re] of cases) assert.match(why, re);
  assert.match(why, /record 6 \(grant-json\/request\): not JSON/);
  assert.ok(!why.includes("MARKER"));
});

test("an oversized object is flagged by size and never downloaded", async () => {
  const b = bucket();
  let gets = 0;
  const get = b.get.bind(b);
  b.get = async (k: string) => { gets++; return get(k); };
  b.add(keyFor(1, G, "request"), "x", at(-1), MAX_STORED_BYTES + 1);
  assert.match(await reasonOf(b), new RegExp(`record 1 \\(grant-0001/request\\): ${MAX_STORED_BYTES + 1} bytes`));
  assert.equal(gets, 0);
});

test("r1 #6: work per hour is bounded; a flood beyond a page is flagged and read on later hours", async () => {
  const b = bucket(), e = env(b);
  for (let i = 1; i <= PAGE + 3; i++) await planted(b, i, `grant-${String(i).padStart(5, "0")}`, "request", at(-1));
  const first = await runRecords(e, wire().fetch, NOW);
  assert.equal(first.checked, PAGE);
  assert.match(first.reason, new RegExp(`more than ${PAGE} new records in an hour`));
  assert.match(first.reason, new RegExp(`${PAGE} records stored on 2026-11-01, over the cap of ${DAY_CAP}`));
  assert.equal((await runRecords(e, wire().fetch, at(60))).checked, 3);
});

test("a record that cannot be read stops the run there, unverified, and is read again next hour", async () => {
  const b = bucket(), e = env(b);
  await viaRecorder(b);
  b.unreadable.add(keyFor(3, G, "approval"));
  const r = await runRecords(e, wire().fetch, NOW);
  assert.deepEqual([r.records, r.checked], ["unverified", 2]);
  b.unreadable.clear();
  const again = await runRecords(e, wire().fetch, at(60));
  assert.deepEqual([again.records, again.checked], ["healthy", 2]);
});

test("a finding alerts once, stays quiet while it lasts, and alerts again if it comes back", async () => {
  const b = bucket(), e = env(b);
  b.add("stray", "{}", at(-1));
  const w1 = wire();
  await runRecords(e, w1.fetch, NOW);
  assert.equal(w1.pushes().length, 1);
  const w2 = wire();
  await runRecords(e, w2.fetch, at(60));
  assert.equal(w2.pushes().length, 0);
  assert.deepEqual(w2.hc(), ["/rec/fail"]);
  b.store.delete("stray");
  await runRecords(e, wire().fetch, at(120));
  b.add("stray", "{}", at(121));
  const w4 = wire();
  await runRecords(e, w4.fetch, at(180));
  assert.equal(w4.pushes().length, 1);
});

test("r1 #4: an alert holds what fits, worst first; only what was sent counts as told; the rest follow next hour", async () => {
  const b = bucket(), e = env(b);
  for (let i = 1; i <= 30; i++) await planted(b, i, `grant-${String(i).padStart(4, "0")}`, "result", at(-1));
  b.add("stray", "{}", at(-1));
  const w = wire();
  await runRecords(e, w.fetch, NOW);
  const msg = new URLSearchParams(w.pushes()[0].body).get("message")!;
  assert.ok(msg.length <= 1024);
  assert.match(msg.split("\n")[0], /ran unrecorded/); // worst first; the stray waits
  const told = await ids(e);
  assert.ok(told.length > 0 && told.length < 31);
  // The bookmark has passed those records, yet the untold ones still arrive in the next hours.
  const heard = new Set(told);
  for (let h = 1; h <= 10 && heard.size < 31; h++) {
    await runRecords(e, wire().fetch, at(60 * h));
    for (const id of await ids(e)) heard.add(id);
  }
  assert.equal(heard.size, 31);
});

test("r1 #5: an alert no channel took is not told; it is tried again next hour", async () => {
  const b = bucket(), e = env(b);
  await planted(b, 1, G, "result", at(-1));
  const down = wire(undefined, 503, 503);
  await runRecords(e, down.fetch, NOW);
  assert.equal(down.pushes().length, 1);
  assert.deepEqual(await ids(e), []);
  const up = wire();
  await runRecords(e, up.fetch, at(60));
  assert.equal(up.pushes().length, 1);
  assert.match(new URLSearchParams(up.pushes()[0].body).get("message")!, /ran unrecorded/);
});

test("undelivered findings carried hour to hour are bounded, with a line saying more were dropped", async () => {
  const b = bucket(), e = env(b, { PING_URL_RECORDS: undefined });
  for (let i = 1; i <= MAX_QUEUED + 20; i++) await planted(b, i, `grant-${String(i).padStart(4, "0")}`, "result", at(-1));
  await runRecords(e, wire().fetch, NOW);
  const queued = JSON.parse(e.COPY.store.get(STATE_KEY)!.body).queued as { id: string }[];
  assert.equal(queued.length, MAX_QUEUED);
  assert.equal(queued.at(-1)!.id, "queued:more");
});

test("without its own check it only logs: no alert, nothing claims healthy", async () => {
  const b = bucket(), w = wire();
  b.add("stray", "{}", at(-1));
  const r = await runRecords(env(b, { PING_URL_RECORDS: undefined }), w.fetch, NOW);
  assert.equal(r.setup, "PING_URL_RECORDS not set: log only");
  assert.equal(w.calls.filter((c) => c.host !== "api.cloudflare.com").length, 0);
});

test("no binding, or a list that fails, is unverified, never healthy", async () => {
  assert.equal((await runRecords(env(undefined), wire().fetch, NOW)).records, "unverified");
  const b = bucket();
  b.failList();
  const w = wire();
  const r = await runRecords(env(b), w.fetch, NOW);
  assert.deepEqual([r.records, r.reason], ["unverified", "the records could not be listed"]);
  assert.equal(w.pushes().length, 1);
});

test("the records lock is read and a short one is a finding; no key yet claims nothing", async () => {
  const b = bucket();
  const lockEnv = { LOCK_READ_TOKEN: "t".repeat(40), LOCK_ACCOUNT_ID: "f".repeat(32) };
  const short = await runRecords(env(b, lockEnv), wire([{ id: "r", enabled: true, prefix: "records/", condition: { type: "Age", maxAgeSeconds: 86_400 } }]).fetch, NOW);
  assert.equal(short.lock, "short");
  const good = await runRecords(env(b, lockEnv), wire([{ id: "r", enabled: true, prefix: "records/", condition: { type: "Age", maxAgeSeconds: MIN_LOCK_SECONDS } }]).fetch, NOW);
  assert.equal(good.lock, "ok");
  assert.equal((await runRecords(env(b), wire().fetch, NOW)).lock, "not set up");
});

test("once a day the bucket is counted: an object written around the recorder below the bookmark is caught", async () => {
  const b = bucket(), e = env(b);
  await viaRecorder(b);
  await runRecords(e, wire().fetch, NOW);
  // Inserted under a name that sorts before the bookmark: the hourly read never sees it.
  await planted(b, 2, "grant-aaaa", "request", at(5));
  assert.equal((await runRecords(e, wire().fetch, at(60))).records, "healthy");
  const sweep = new Date("2026-11-02T04:30:00Z");
  assert.equal(sweep.getUTCHours(), SWEEP_HOUR);
  assert.match((await runRecords(e, wire().fetch, sweep)).reason, /the bucket holds 5 records but the recorder numbered 4: something wrote around the recorder/);
  // Carried through the following hours until the next sweep.
  assert.match((await runRecords(e, wire().fetch, new Date("2026-11-02T05:30:00Z"))).reason, /something wrote around the recorder/);
});

test("the hourly cron runs the records check as its own job", async () => {
  const b = bucket(), w = wire(), jobs: Promise<unknown>[] = [];
  await viaRecorder(b);
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
