import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY_CAP, keyFor, MAX_RECORD_BYTES, sha256, STAGE_SLOTS, validate, type Envelope, type Receipt } from "../src/contract.ts";
import { admit, resetCerts, type AccessEnv } from "../src/recorder/access.ts";
import { handle } from "../src/recorder/http.ts";
import { Ledger, type Storage } from "../src/recorder/ledger.ts";

const NOW = new Date("2026-11-01T12:30:00Z");
const MIN = 60_000;
const at = (m: number) => () => new Date(NOW.getTime() + m * MIN);
const G = "grant-0001";

// Durable Object storage in memory; `put` of several keys lands together, like the real one.
function storage() {
  const m = new Map<string, unknown>();
  const s: Storage & { m: typeof m } = {
    m,
    async get<T>(k: string) { return structuredClone(m.get(k)) as T | undefined; },
    async put(e: Record<string, unknown>) { for (const [k, v] of Object.entries(e)) m.set(k, structuredClone(v)); },
    async delete(k: string) { return m.delete(k); },
  };
  return s;
}
// The records bucket in memory: head and put, with a switch to make puts fail.
function bucket() {
  const store = new Map<string, { body: string; sha?: string }>();
  let failPuts = 0;
  return {
    store,
    failNext(n = 1) { failPuts = n; },
    async head(k: string) { const v = store.get(k); return v ? ({ key: k, customMetadata: { sha256: v.sha } } as unknown as R2Object) : null; },
    async put(k: string, body: string, o?: R2PutOptions) {
      if (failPuts > 0) { failPuts--; throw new Error("R2 down"); }
      store.set(k, { body, sha: o?.customMetadata?.sha256 });
      return {} as R2Object;
    },
  };
}
const rec = (stage: string, over: object = {}, grant = G) => JSON.stringify({ v: 1, grant, stage, job: "cf.token.canary", ...over });

/** A grant's request, then a later stage that names it by hash. */
async function setup() {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  const req = rec("request");
  const r1 = await l.accept(req, at(0));
  const h = await sha256(req);
  return { st, b, l, req, h, r1, later: (stage: string, over: object = {}) => rec(stage, { request: h, ...over }) };
}

test("contract: a good request passes; fixed reasons for each break, never the writer's text", () => {
  assert.equal(validate(rec("request")).ok, true);
  const why = (b: string) => { const v = validate(b); return v.ok ? "ok" : v.why; };
  assert.equal(why("{"), "not JSON");
  assert.equal(why("[1]"), "not a JSON object");
  assert.equal(why(rec("request", { v: 2 })), "not version 1");
  assert.equal(why(rec("request", {}, "short")), "no valid grant id");
  assert.equal(why(rec("request", {}, "__proto__")), "no valid grant id");
  assert.equal(why(rec("request", {}, "-leading-dash")), "no valid grant id");
  assert.equal(why(rec("launch")), "no valid stage");
  assert.equal(why(rec("request", { job: "Bad Job" })), "no valid job name");
  assert.equal(why(rec("approval")), "no valid request hash");
  assert.equal(why(rec("request", { request: "a".repeat(64) })), "a request must not name a request");
  assert.equal(why(rec("request", { params: { password_MARKER: 1 } })), "a field named like a secret, or nested too deep");
  let deep: object = {};
  for (let i = 0; i < 12; i++) deep = { x: deep };
  assert.equal(why(rec("request", { params: deep })), "a field named like a secret, or nested too deep");
  assert.equal(why(rec("request", { pad: "x".repeat(MAX_RECORD_BYTES) })), `over ${MAX_RECORD_BYTES} bytes`);
  assert.ok(!why(rec("request", { params: { password_MARKER: 1 } })).includes("MARKER"));
});

test("request, approval, verdict, result: stored in order with gap-free names and the recorder's own time", async () => {
  const { b, l, r1, later } = await setup();
  assert.equal(r1.status, 201);
  const out = [r1, await l.accept(later("approval"), at(1)), await l.accept(later("verdict"), at(2)), await l.accept(later("result"), at(3))];
  const receipts = out.map((o) => (assert.ok("receipt" in o), o.receipt));
  assert.deepEqual(receipts.map((r) => r.seq), [1, 2, 3, 4]);
  assert.deepEqual(receipts.map((r) => r.key), [keyFor(1, G, "request"), keyFor(2, G, "approval"), keyFor(3, G, "verdict"), keyFor(4, G, "result")]);
  assert.equal(receipts[0].key, "records/v1/000000000001.grant-0001.request.json");
  const env = JSON.parse(b.store.get(receipts[3].key)!.body) as Envelope;
  assert.equal(env.recorded_at, "2026-11-01T12:33:00.000Z");
  assert.equal(env.sha256, await sha256(env.body));
  assert.equal(JSON.parse(env.body).stage, "result");
  assert.equal(b.store.get(receipts[3].key)!.sha, await sha256(b.store.get(receipts[3].key)!.body));
});

test("out of order: approval, verdict or result with no request; result with no approval -- all refused, nothing stored", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  for (const s of ["approval", "verdict", "result"]) {
    const o = await l.accept(rec(s, { request: "a".repeat(64) }), at(0));
    assert.deepEqual([o.status, "why" in o && o.why], [409, "no request is recorded for this grant"]);
  }
  const { l: l2, b: b2, later } = await setup();
  const o = await l2.accept(later("result"), at(1));
  assert.deepEqual([o.status, "why" in o && o.why], [409, "no approval is recorded for this grant"]);
  assert.equal(b.store.size, 0);
  assert.equal(b2.store.size, 1);
});

test("later stages must name the recorded request's exact bytes and job", async () => {
  const { l, later } = await setup();
  const wrongHash = await l.accept(later("approval", { request: "b".repeat(64) }), at(1));
  assert.deepEqual([wrongHash.status, "why" in wrongHash && wrongHash.why], [409, "the request hash does not match the recorded request"]);
  const wrongJob = await l.accept(later("approval", { job: "dns.delete" }), at(1));
  assert.deepEqual([wrongJob.status, "why" in wrongJob && wrongJob.why], [409, "the job does not match the recorded request"]);
});

test("a grant spanning midnight is fine; one over 24 hours old is closed", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  const req = rec("request"), h = await sha256(req);
  const late = () => new Date("2026-11-01T23:59:00Z");
  await l.accept(req, late);
  const a = await l.accept(rec("approval", { request: h }), () => new Date("2026-11-02T00:01:00Z"));
  assert.equal(a.status, 201);
  const r = await l.accept(rec("result", { request: h }), () => new Date("2026-11-03T00:00:00Z"));
  assert.deepEqual([r.status, "why" in r && r.why], [410, "this grant's request is over 24 hours old"]);
});

test("retries: the same bytes get the same receipt; other bytes for a recorded stage are refused", async () => {
  const { l, b, req, r1, later } = await setup();
  const again = await l.accept(req, at(5));
  assert.equal(again.status, 200);
  assert.deepEqual("receipt" in again && again.receipt, "receipt" in r1 && r1.receipt);
  const other = await l.accept(rec("request", { params: { n: 2 } }), at(5));
  assert.deepEqual([other.status, "why" in other && other.why], [409, "this stage of this grant is already recorded with other content"]);
  await l.accept(later("approval"), at(6));
  const dup = await l.accept(later("approval", { note: "again" }), at(7));
  assert.equal(dup.status, 409);
  assert.equal(b.store.size, 2);
});

test("a write the bucket refused is not receipted; it is finished first on the next call, with no gap", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  const req = rec("request");
  b.failNext();
  const first = await l.accept(req, at(0));
  assert.deepEqual([first.status, "why" in first && first.why], [503, "the records bucket did not take the write; it will be retried"]);
  assert.equal(b.store.size, 0);
  // Another grant arrives: the pending record is stored first (seq 1), then the new one (seq 2).
  const other = await l.accept(rec("request", {}, "grant-0002"), at(1));
  assert.ok("receipt" in other && other.receipt.seq === 2);
  assert.deepEqual([...b.store.keys()], [keyFor(1, G, "request"), keyFor(2, "grant-0002", "request")]);
  // The front desk retries its unanswered write: same receipt as the stored one.
  const retry = await l.accept(req, at(2));
  assert.ok("receipt" in retry && retry.status === 200 && retry.receipt.seq === 1);
});

test("a crash after the bucket write but before clearing pending: finished without writing twice", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  await l.accept(rec("request"), at(0));
  const stored = b.store.get(keyFor(1, G, "request"))!;
  // Put the pending record back, as if the Durable Object stopped right after the bucket write.
  const receipt = (st.m.get(`g:${G}`) as { stages: { request: Receipt } }).stages.request;
  st.m.set("pending", { key: receipt.key, stored: stored.body, storedSha: stored.sha, receipt });
  const next = await l.accept(rec("request", {}, "grant-0002"), at(1));
  assert.ok("receipt" in next && next.receipt.seq === 2);
  assert.equal(st.m.has("pending"), false);
});

test("an object it did not write under its next name stops all writes until Ben looks", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  b.store.set(keyFor(1, G, "request"), { body: "planted", sha: "x" });
  const o = await l.accept(rec("request"), at(0));
  assert.equal(o.status, 503);
  const o2 = await l.accept(rec("request", {}, "grant-0002"), at(1));
  assert.deepEqual([o2.status, "why" in o2 && o2.why], [503, "the next record's name is taken by an object the recorder did not write: Ben must look"]);
  assert.equal(b.store.get(keyFor(1, G, "request"))!.body, "planted");
});

test("the day's cap: requests reserve their grant's slots, so admitted grants can always finish", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  const grants = DAY_CAP / STAGE_SLOTS;
  const reqs: string[] = [];
  for (let i = 0; i < grants; i++) {
    const r = rec("request", {}, `grant-${String(i).padStart(4, "0")}`);
    reqs.push(r);
    assert.equal((await l.accept(r, at(0))).status, 201);
  }
  const over = await l.accept(rec("request", {}, "grant-flood"), at(0));
  assert.deepEqual([over.status, "why" in over && over.why], [429, `today's ${DAY_CAP} record slots are taken`]);
  // Every admitted grant can still record its approval: its slot was reserved.
  const h = await sha256(reqs[7]);
  assert.equal((await l.accept(rec("approval", { request: h }, "grant-0007"), at(1))).status, 201);
  // Next UTC day, room again.
  assert.equal((await l.accept(rec("request", {}, "grant-tomorrow"), () => new Date("2026-11-02T00:00:01Z"))).status, 201);
  assert.deepEqual(await l.status(new Date("2026-11-02T01:00:00Z")), { seq: grants + 2, used_today: STAGE_SLOTS, cap: DAY_CAP, pending: false });
});

test("simultaneous writes are taken one at a time: no shared sequence number, no lost update", async () => {
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => l.accept(rec("request", {}, `grant-${String(i).padStart(4, "0")}`), at(0))));
  const seqs = outs.map((o) => ("receipt" in o ? o.receipt.seq : 0)).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await l.status(NOW)).used_today, 20 * STAGE_SLOTS);
  // Two copies of one grant's request at once: one stored, one answered with the same receipt.
  const pair = await Promise.all([l.accept(rec("request", {}, "grant-twins"), at(0)), l.accept(rec("request", {}, "grant-twins"), at(0))]);
  assert.deepEqual(pair.map((o) => o.status), [201, 200]);
});

// ---- the edge-login check and the address ----

const TEAM = "weirdways.cloudflareaccess.com", AUD = "aud-recorder", SERVICE = "client-id-frontdesk.access", BEN = "ben@example.com";
const ENV: AccessEnv = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ACCESS_SERVICE_ID: SERVICE, ACCESS_BEN_EMAIL: BEN };
const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  let certFetches = 0;
  const fetchFn = async (req: Request) => {
    assert.equal(req.url, `https://${TEAM}/cdn-cgi/access/certs`);
    certFetches++;
    return Response.json({ keys: [jwk] });
  };
  const sec = NOW.getTime() / 1000;
  const sign = async (claims: object, header: object = { alg: "RS256", kid: "k1" }, key = pair.privateKey) => {
    const data = `${enc(header)}.${enc(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString("base64url")}`;
  };
  const claims = (over: object = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: sec + 300, iat: sec, common_name: SERVICE, ...over });
  return { fetchFn, sign, claims, certs: () => certFetches, sec };
}
const withToken = (t?: string, init: RequestInit = {}, path = "/v1/records") => new Request(`https://observatory-recorder.example.workers.dev${path}`, { method: "POST", ...init, headers: { ...(t ? { "Cf-Access-Jwt-Assertion": t } : {}), ...(init.headers as object) } });

test("edge login: the front desk's service token and Ben get in; signature, issuer, audience, expiry and identity are each checked", async () => {
  resetCerts();
  const s = await signer();
  const ok = await admit(withToken(await s.sign(s.claims())), ENV, s.fetchFn, NOW);
  assert.deepEqual(ok, { ok: true, who: "service" });
  assert.deepEqual(await admit(withToken(await s.sign(s.claims({ common_name: undefined, email: "Ben@Example.com" }))), ENV, s.fetchFn, NOW), { ok: true, who: "ben" });
  const why = async (t?: string, env: AccessEnv = ENV) => { const a = await admit(withToken(t), env, s.fetchFn, NOW); return a.ok ? "ok" : `${a.status} ${a.why}`; };
  assert.equal(await why(undefined), "401 no edge-login token");
  assert.equal(await why("abc"), "401 malformed token");
  assert.equal(await why(await s.sign(s.claims({ iss: "https://other.cloudflareaccess.com" }))), "401 token from another issuer");
  assert.equal(await why(await s.sign(s.claims({ aud: ["another-app"] }))), "401 token for another app");
  assert.equal(await why(await s.sign(s.claims({ aud: AUD }))), "ok"); // a single-string audience is allowed
  assert.equal(await why(await s.sign(s.claims({ exp: s.sec - 1 }))), "401 token expired or without expiry");
  assert.equal(await why(await s.sign(s.claims({ exp: undefined }))), "401 token expired or without expiry");
  assert.equal(await why(await s.sign(s.claims({ nbf: s.sec + 3600 }))), "401 token not valid yet");
  assert.equal(await why(await s.sign(s.claims({ common_name: "someone-else.access" }))), "403 not the front desk and not Ben");
  assert.equal(await why(await s.sign(s.claims({ common_name: undefined, email: "mallory@example.com" }))), "403 not the front desk and not Ben");
  assert.equal(await why(await s.sign(s.claims(), { alg: "HS256", kid: "k1" })), "401 unexpected token algorithm");
  assert.equal(await why(await s.sign(s.claims(), { alg: "none", kid: "k1" })), "401 unexpected token algorithm");
  const tampered = (await s.sign(s.claims())).split(".");
  tampered[1] = enc(s.claims({ common_name: SERVICE, exp: s.sec + 99_999 }));
  assert.equal(await why(tampered.join(".")), "401 bad token signature");
  const other = await signer(); // a token signed by a key Access never published
  assert.equal(await why(await other.sign(s.claims())), "401 bad token signature");
  assert.equal(await why(await s.sign(s.claims(), { alg: "RS256", kid: "k-unknown" })), "401 token signed by an unknown key");
  for (const k of ["ACCESS_TEAM", "ACCESS_AUD", "ACCESS_SERVICE_ID", "ACCESS_BEN_EMAIL"] as const) {
    assert.equal(await why(await s.sign(s.claims()), { ...ENV, [k]: undefined }), "503 the recorder's edge-login settings are not set", k);
  }
  assert.equal(s.certs(), 1); // keys cached; an unknown key id does not refetch within 5 minutes
});

test("edge login: Access's keys unreadable means refused, not let through", async () => {
  resetCerts();
  const s = await signer();
  const a = await admit(withToken(await s.sign(s.claims())), ENV, async () => new Response("down", { status: 502 }), NOW);
  assert.deepEqual(a, { ok: false, status: 503, why: "Access's signing keys could not be read" });
});

test("the address: two paths only; the login check runs before the body is read; only the front desk writes", async () => {
  resetCerts();
  const s = await signer();
  const st = storage(), b = bucket(), l = new Ledger(st, b);
  const stub = { accept: (body: string) => l.accept(body, at(0)), status: () => l.status(NOW) };
  let bodyRead = false;
  const tracked = new ReadableStream({ pull(c) { bodyRead = true; c.enqueue(new TextEncoder().encode(rec("request"))); c.close(); } }, { highWaterMark: 0 });
  const go = (req: Request) => handle(req, ENV, () => stub, s.fetchFn, NOW);
  const svc = await s.sign(s.claims()), ben = await s.sign(s.claims({ common_name: undefined, email: BEN }));

  const anon = await go(withToken(undefined, { body: tracked, duplex: "half" } as RequestInit));
  assert.equal(anon.status, 401);
  assert.equal(bodyRead, false);
  for (const [method, path] of [["GET", "/"], ["GET", "/v1/records"], ["PUT", "/v1/records"], ["POST", "/v1/status"], ["POST", "/v1/records/"], ["GET", "/admin"]]) {
    const r = await go(new Request(`https://x.workers.dev${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": svc } }));
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  const benWrite = await go(withToken(ben, { body: rec("request") }));
  assert.deepEqual([benWrite.status, await benWrite.json()], [403, { error: "only the front desk writes records" }]);

  const okWrite = await go(withToken(svc, { body: rec("request") }));
  assert.equal(okWrite.status, 201);
  assert.equal(okWrite.headers.get("X-Robots-Tag"), "noindex");
  const { receipt } = (await okWrite.json()) as { receipt: Receipt };
  assert.equal(receipt.key, keyFor(1, G, "request"));

  const bad = await go(withToken(svc, { body: "{not json" }));
  assert.deepEqual([bad.status, await bad.json()], [400, { error: "not JSON" }]);
  const declaredBig = await go(withToken(svc, { body: "x", headers: { "Content-Length": String(MAX_RECORD_BYTES + 1) } }));
  assert.equal(declaredBig.status, 413);
  // No Content-Length (streamed): the actual bytes are counted and reading stops at the limit.
  let pulled = 0;
  // 80 KiB, ten times the limit: without the limit this would be read whole and answered 400, not 413.
  const endless = new ReadableStream({ pull(c) { if (++pulled > 20) return c.close(); c.enqueue(new Uint8Array(4096)); } }, { highWaterMark: 0 });
  const streamed = await go(withToken(svc, { body: endless, duplex: "half" } as RequestInit));
  assert.equal(streamed.status, 413);
  assert.ok(pulled <= 4, `read ${pulled} chunks`);
  const notUtf8 = await go(withToken(svc, { body: new Uint8Array([0xff, 0xfe, 0x7b]) }));
  assert.equal(notUtf8.status, 400);

  const status = await go(withToken(ben, { method: "GET" }, "/v1/status"));
  assert.deepEqual(await status.json(), { seq: 1, used_today: STAGE_SLOTS, cap: DAY_CAP, pending: false });
});
