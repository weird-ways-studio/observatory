import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { backupDate, md5FromEtag, parseListing, runNight, CANARY_KEY, type Env } from "../src/copy.ts";

const md5 = (data: string) => createHash("md5").update(data).digest("hex");
const buf = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex")).buffer;
const NOW = new Date("2026-10-31T11:00:00Z");
const DATE = "2026-10-31";
// R2's real refusal text, as the live night logged it (2026-11-01 03:15 UTC).
const REFUSAL = "delete: The object is locked by the bucket policy. (10069)";

// A stand-in for an R2 bucket with the copy bucket's lock rules: nothing under daily/ or canary/
// can be overwritten, and a canary delete is refused unless the test removes the lock.
class FakeBucket {
  store = new Map<string, string>();
  lockDeletes = true;
  deleteError = new Error(REFUSAL);
  async head(key: string) {
    const v = this.store.get(key);
    return v === undefined ? null : { size: v.length, checksums: { md5: buf(md5(v)) } };
  }
  async put(key: string, body: ReadableStream | string, opts?: { md5?: string }) {
    const text = typeof body === "string" ? body : await new Response(body).text();
    if (opts?.md5 && md5(text) !== opts.md5) throw new Error("put: The Content-MD5 you specified did not match");
    if (this.store.has(key)) throw new Error("put: object is locked");
    this.store.set(key, text);
    return { size: text.length, checksums: { md5: buf(md5(text)) } };
  }
  async delete(key: string) {
    if (this.lockDeletes) throw this.deleteError;
    this.store.delete(key);
  }
  async list() {
    return { objects: [...this.store].map(([, v]) => ({ size: v.length })), truncated: false };
  }
}

type Obj = { key: string; data: string; etag?: string };
function night(objects: Obj[], opts: { pageSize?: number; status?: number; pushover?: boolean; throwWith?: string; lockSeconds?: number } = {}) {
  const bucket = new FakeBucket();
  const pings: string[] = [];
  const alerts: string[] = [];
  const pageSize = opts.pageSize ?? 1000;
  const fetch = async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname === "hc.example") {
      pings.push(url.pathname);
      return new Response("OK");
    }
    if (url.hostname === "api.pushover.net") {
      alerts.push(new URLSearchParams(await req.text()).get("message") ?? "");
      return new Response('{"status":1}');
    }
    if (url.hostname === "api.cloudflare.com") {
      const rules = [{ enabled: true, prefix: "daily/", condition: { type: "Age", maxAgeSeconds: opts.lockSeconds } }];
      return Response.json({ success: true, result: { rules } });
    }
    if (opts.throwWith) throw new Error(opts.throwWith);
    assert.match(req.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /); // every source call is signed
    if (opts.status) return new Response("denied", { status: opts.status });
    if (url.searchParams.get("list-type") === "2") {
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = objects.slice(start, start + pageSize);
      const more = start + pageSize < objects.length;
      const contents = page.map((o) => `<Contents><Key>${o.key}</Key><Size>${o.data.length}</Size><ETag>&quot;${o.etag ?? md5(o.data)}&quot;</ETag></Contents>`);
      return new Response(`<ListBucketResult>${contents.join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/src-bucket\//, ""));
    const o = objects.find((x) => x.key === key);
    return o ? new Response(o.data) : new Response("missing", { status: 404 });
  };
  const env = {
    COPY: bucket as unknown as R2Bucket,
    SOURCE_ACCESS_KEY_ID: "AKID", SOURCE_SECRET_ACCESS_KEY: "secret",
    SOURCE_ENDPOINT: "https://source.example", SOURCE_BUCKET: "src-bucket", PING_URL: "https://hc.example/check",
    ...(opts.pushover ? { PUSHOVER_TOKEN: "t".repeat(30), PUSHOVER_USER: "u".repeat(30) } : {}),
    ...(opts.lockSeconds !== undefined ? { LOCK_READ_TOKEN: "lock-token", LOCK_ACCOUNT_ID: "acct" } : {}),
  } satisfies Env;
  const run = () => runNight(env, { fetch, sized: (body) => body }, NOW);
  return { bucket, pings, alerts, run };
}

const tonight = [
  { key: `daily/open-brain/${DATE}/open-brain.sql.gz.age`, data: "brain bytes" },
  { key: `daily/occam-db/${DATE}/occam.db.gz.age`, data: "occam bytes" },
  { key: "daily/open-brain/2026-10-30/open-brain.sql.gz.age", data: "last night" },
];

test("backup date is the c-box's local date in both daylight and standard time", () => {
  assert.equal(backupDate(new Date("2026-10-31T11:00:00Z")), "2026-10-31");
  assert.equal(backupDate(new Date("2026-11-02T11:00:00Z")), "2026-11-02");
  assert.equal(backupDate(new Date("2026-11-02T04:00:00Z")), "2026-11-01");
});

test("a multipart ETag is refused: it is not an MD5, so no byte check would happen", () => {
  assert.equal(md5FromEtag('"41156a5f88af160c3be0731f2a7a618f"'), "41156a5f88af160c3be0731f2a7a618f");
  assert.throws(() => md5FromEtag('"41156a5f88af160c3be0731f2a7a618f-15"'), /not a plain MD5/);
});

test("listing XML: keys, sizes, ETags and the continuation token", () => {
  const page = parseListing("<Contents><Key>daily/a&amp;b</Key><Size>3</Size><ETag>&quot;x&quot;</ETag></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>");
  assert.deepEqual(page, { objects: [{ key: "daily/a&b", size: 3, etag: '"x"' }], next: "t1" });
});

test("a good night copies only tonight's objects, verifies them, and pings up", async () => {
  const n = night(tonight);
  const report = await n.run();
  assert.equal(report.ok, true, report.failures.join("; "));
  assert.equal(report.copied, 2);
  assert.equal(n.bucket.store.get(tonight[0].key), "brain bytes");
  assert.equal(n.bucket.store.has(tonight[2].key), false);
  assert.equal(report.canary, "refused");
  assert.equal(report.canaryDelete, `threw Error: ${REFUSAL}`);
  assert.deepEqual(n.pings, ["/check"]);
});

test("a rerun the same night skips verified copies instead of failing on the lock", async () => {
  const n = night(tonight);
  await n.run();
  const report = await n.run();
  assert.equal(report.ok, true, report.failures.join("; "));
  assert.equal(report.skipped, 2);
  assert.deepEqual(n.pings, ["/check", "/check"]);
});

test("listing pages are all read", async () => {
  const n = night(tonight, { pageSize: 1 });
  const report = await n.run();
  assert.equal(report.copied, 2);
});

test("bytes that do not match the source MD5 fail the night", async () => {
  const n = night([{ ...tonight[0], etag: md5("something else") }]);
  const report = await n.run();
  assert.equal(report.ok, false);
  assert.match(report.failures[0], /did not match/);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("a multipart source object fails the night", async () => {
  const n = night([{ ...tonight[0], etag: `${md5("x")}-2` }]);
  const report = await n.run();
  assert.equal(report.ok, false);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("no objects for tonight fails the night", async () => {
  const n = night([tonight[2]]);
  const report = await n.run();
  assert.match(report.failures.join(), /no source objects for 2026-10-31/);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("a refused source read fails the night", async () => {
  const n = night(tonight, { status: 403 });
  const report = await n.run();
  assert.match(report.failures.join(), /HTTP 403/);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("if the locked canary can be deleted, the night fails", async () => {
  const n = night(tonight);
  n.bucket.lockDeletes = false;
  const report = await n.run();
  assert.equal(report.canary, "DELETED");
  assert.equal(report.canaryDelete, "resolved");
  assert.equal(n.bucket.store.has(CANARY_KEY), false);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("a canary delete that fails for any other reason leaves the lock unproven and fails the night", async () => {
  const n = night(tonight);
  n.bucket.deleteError = new Error("internal error; please retry");
  const report = await n.run();
  assert.equal(report.canary, "unverified");
  assert.equal(n.bucket.store.has(CANARY_KEY), true);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("a canary delete that resolves without removing it leaves the lock unproven", async () => {
  const n = night(tonight);
  n.bucket.delete = async () => {};
  const report = await n.run();
  assert.equal(report.canary, "unverified");
  assert.equal(report.canaryDelete, "resolved");
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("before the lock-read key exists, the night claims nothing about lock length and still pings up", async () => {
  const report = await night(tonight).run();
  assert.equal(report.lockLength, "not set up");
  assert.equal(report.ok, true, report.failures.join("; "));
});

test("with the lock-read key: 30 days passes; a shortened lock fails the night and alerts", async () => {
  const good = await night(tonight, { lockSeconds: 30 * 86_400 }).run();
  assert.equal(good.lockLength, "ok");
  assert.equal(good.ok, true, good.failures.join("; "));
  const n = night(tonight, { lockSeconds: 3 * 86_400, pushover: true });
  const report = await n.run();
  assert.equal(report.lockLength, "short");
  assert.match(report.failures.join(), /holds 3 days, under 30 days/);
  assert.equal(n.alerts.length, 1);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("with Pushover set up: a good night sends no alert and pings up", async () => {
  const n = night(tonight, { pushover: true });
  await n.run();
  assert.deepEqual(n.alerts, []);
  assert.deepEqual(n.pings, ["/check"]);
});

test("with Pushover set up: a failing night sends exactly one alert, and healthchecks still hears /fail", async () => {
  const n = night([tonight[2]], { pushover: true });
  await n.run();
  assert.equal(n.alerts.length, 1);
  assert.match(n.alerts[0], /no source objects for 2026-10-31/);
  assert.deepEqual(n.pings, ["/check/fail"]);
});

test("a failure quoting the source endpoint or a key is redacted before the log, phone and healthchecks", async () => {
  const n = night(tonight, { pushover: true, throwWith: "connect to https://source.example/src-bucket failed (AKID)" });
  const report = await n.run();
  const all = [JSON.stringify(report), ...n.alerts].join(" ");
  for (const secret of ["source.example", "src-bucket", "AKID"]) assert.ok(!all.includes(secret), secret);
});
