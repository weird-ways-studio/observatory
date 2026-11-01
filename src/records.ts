// Phase 2a (card feea07eb; PLAN.md phase 2a): the recorder. The front desk (the broker) writes one
// small JSON record per stage of each grant into the observatory-records bucket, whose lock rule
// makes it add-only: Cloudflare refuses overwrites and deletes, and allows new objects. Every hour
// this job reads today's and yesterday's records and alerts on anything outside the v1 contract
// (RECORDS.md). It only tells; it never acts on the broker. The bucket has no address: the broker
// reaches it with a bucket-scoped key Ben makes, so nothing here adds a door.
import { alert, redact, type AlertEnv } from "./alert.ts";
import { readLockLength, type LockEnv } from "./lock.ts";

export interface RecordsEnv extends AlertEnv, LockEnv {
  RECORDS?: Pick<R2Bucket, "list" | "get">; // read and list only: this job never writes there
  COPY: Pick<R2Bucket, "get" | "put">; // state/records.json lives in the copy bucket's unlocked state/
  PING_URL_RECORDS?: string; // this job's own healthchecks check; Ben creates it at the end of the build
}

export const RECORDS_BUCKET = "observatory-records"; // the RECORDS binding's bucket (wrangler.jsonc)
export const ROOT = "records/v1/";
export const LOCKED = "records/";
export const MIN_LOCK_SECONDS = 400 * 86_400; // over a year of history, then lifecycle may delete
export const STATE_KEY = "state/records.json";
export const MAX_RECORD_BYTES = 8_192;
export const DAY_CAP = 400; // records a day; ~4 per grant, so ~100 grants
export const SKEW_MS = 10 * 60_000; // a record's own `at` vs the time R2 stored it
export const STAGES = ["request", "approval", "verdict", "result"] as const;
type Stage = (typeof STAGES)[number];

const KEY = /^records\/v1\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_-]{8,64})\/(request|approval|verdict|result)\.json$/;
const JOB = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const SECRETISH = /secret|password|token|private|credential/i;

/** What R2 tells us about one object: set by Cloudflare, not by the writer. */
export interface Stored { key: string; size: number; uploaded: Date }
/** One finding: `id` is stable across hours so Ben hears about it once. */
export interface Finding { id: string; text: string }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const day = (d: Date) => d.toISOString().slice(0, 10);
/** A writer-chosen name made safe to show Ben: safe characters only, and short. */
export const shown = (name: string) => name.replace(/[^A-Za-z0-9/._-]/g, "?").slice(0, 60);
// Worst first: what ran unrecorded or unchecked before what is merely malformed.
const RANK = ["unrecorded", "unapproved", "approval-first", "lock", "cap", "late", "verdict-first", "bad", "stray"];
const rank = (f: Finding) => { const i = RANK.indexOf(f.id.split(":")[0]); return i < 0 ? RANK.length : i; };

/** Property names anywhere in `v` that look like they hold a secret. */
function secretNames(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (SECRETISH.test(k)) out.push(k);
      secretNames(x, out);
    }
  }
  return out;
}

/** Checks one record on its own: its key, its size and its body against the R2 upload time. */
export function checkRecord(obj: Stored, body: string | null): Finding[] {
  const m = KEY.exec(obj.key);
  if (!m) return [{ id: `stray:${obj.key}`, text: `an object outside the record format: ${shown(obj.key)}` }];
  const [, date, grant, stage] = m;
  const bad = (why: string): Finding[] => [{ id: `bad:${obj.key}`, text: `record ${grant}/${stage}: ${why}` }];
  if (obj.size > MAX_RECORD_BYTES) return bad(`${obj.size} bytes, over ${MAX_RECORD_BYTES}`);
  if (body === null) return bad("could not be read");
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(body);
  } catch {
    return bad("not JSON");
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return bad("not a JSON object");
  if (r.v !== 1) return bad("not version 1");
  if (r.grant !== grant || r.stage !== stage) return bad("its body names a different grant or stage than its key");
  if (typeof r.job !== "string" || !JOB.test(r.job)) return bad("no valid job name");
  const at = typeof r.at === "string" && ISO.test(r.at) ? Date.parse(r.at) : NaN;
  if (Number.isNaN(at)) return bad("no valid `at` time (UTC ISO, e.g. 2026-11-01T12:30:00Z)");
  // Ordering and dating rest on R2's upload time, which the writer cannot set.
  if (Math.abs(at - obj.uploaded.getTime()) > SKEW_MS) return bad(`its time ${new Date(at).toISOString()} is more than 10 minutes from when it was stored`);
  if (date !== day(new Date(at))) return bad(`filed under ${date} but dated ${day(new Date(at))}`);
  const names = secretNames(r);
  if (names.length) return bad(`has ${names.length} field${names.length === 1 ? "" : "s"} named like a secret`);
  return [];
}

/** Checks the records of each grant against each other: nothing approved or run before it was asked. */
export function checkOrder(objs: Stored[]): Finding[] {
  const grants = new Map<string, Partial<Record<Stage, Date>>>();
  for (const o of objs) {
    const m = KEY.exec(o.key);
    if (!m) continue;
    const g = grants.get(m[2]) ?? {};
    g[m[3] as Stage] = o.uploaded;
    grants.set(m[2], g);
  }
  const out: Finding[] = [];
  for (const [grant, s] of grants) {
    const before = (a: Stage, b: Stage) => s[a] !== undefined && s[a]! <= s[b]!;
    if (s.result && !before("request", "result")) out.push({ id: `unrecorded:${grant}`, text: `grant ${grant} has a result with no earlier request record: something ran unrecorded` });
    else if (s.result && !before("approval", "result")) out.push({ id: `unapproved:${grant}`, text: `grant ${grant} has a result with no earlier approval record` });
    if (s.approval && !before("request", "approval")) out.push({ id: `approval-first:${grant}`, text: `grant ${grant} was approved with no earlier request record` });
    if (s.verdict && !before("request", "verdict")) out.push({ id: `verdict-first:${grant}`, text: `grant ${grant} has a verdict with no earlier request record` });
  }
  return out;
}

/** Every object under `prefix`, following R2's pages. */
async function listAll(bucket: Pick<R2Bucket, "list">, prefix: string): Promise<Stored[]> {
  const out: Stored[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Top-level names in the bucket outside records/v1/: anything there is outside the contract. */
async function strays(bucket: Pick<R2Bucket, "list">): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [prefix, allowed] of [["", "records/"], ["records/", ROOT]] as const) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });
      for (const p of page.delimitedPrefixes) if (p !== allowed) out.push({ id: `stray:${p}`, text: `a folder outside the record format: ${shown(p)}` });
      for (const o of page.objects) out.push({ id: `stray:${o.key}`, text: `an object outside the record format: ${shown(o.key)}` });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return out;
}

/** Day folders under records/v1/: each must be a real date, and none may be in the future. */
async function dayFolders(bucket: Pick<R2Bucket, "list">, now: Date): Promise<Finding[]> {
  const out: Finding[] = [], tomorrow = day(new Date(now.getTime() + SKEW_MS));
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: ROOT, delimiter: "/", cursor, limit: 1000 });
    for (const p of page.delimitedPrefixes) {
      const d = p.slice(ROOT.length, -1);
      const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN;
      const real = !Number.isNaN(t) && day(new Date(t)) === d; // 2026-02-30 parses, but to March
      if (!real) out.push({ id: `stray:${p}`, text: `a folder outside the record format: ${shown(p)}` });
      else if (d > tomorrow) out.push({ id: `late:${p}`, text: `records filed under a future day: ${shown(p)}` });
    }
    for (const o of page.objects) out.push({ id: `stray:${o.key}`, text: `an object outside the record format: ${shown(o.key)}` });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export const SWEEP_HOUR = 4; // UTC: once a day every record is checked, not only the last two days
/** Every record anywhere: one stored on a day other than its folder's was filed there after the fact. */
async function sweep(bucket: Pick<R2Bucket, "list">): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const o of await listAll(bucket, ROOT)) {
    const m = KEY.exec(o.key);
    if (!m) continue; // strays are reported by checkRecord and dayFolders
    const t = o.uploaded.getTime(), ok = [day(new Date(t - SKEW_MS)), day(new Date(t + SKEW_MS))];
    if (!ok.includes(m[1])) out.push({ id: `late:${o.key}`, text: `record ${m[2]}/${m[3]} was stored ${day(o.uploaded)} into the ${m[1]} folder` });
  }
  return out;
}

/** One day's folder: each record on its own, then the day's volume. */
async function checkDay(bucket: Pick<R2Bucket, "list" | "get">, date: string): Promise<{ objs: Stored[]; findings: Finding[] }> {
  const objs = await listAll(bucket, `${ROOT}${date}/`);
  const findings: Finding[] = [];
  if (objs.length > DAY_CAP) findings.push({ id: `cap:${date}`, text: `${objs.length} records on ${date}, over the cap of ${DAY_CAP}: the broker must stop taking jobs` });
  for (const o of objs.slice(0, DAY_CAP)) {
    // An oversized object is judged by its size alone and never downloaded.
    const body = o.size > MAX_RECORD_BYTES ? null : await bucket.get(o.key).then((b) => (b ? b.text() : null), () => null);
    findings.push(...checkRecord(o, body));
  }
  return { objs, findings };
}

export type RecordsVerdict = "healthy" | "findings" | "unverified";
// `swept` carries the daily sweep's findings through every hour until the next sweep, so a finding
// that did not fit in the 04:30 alert is still found, and told, in the hours after.
interface State { alerted?: string[]; swept?: Finding[] }
export const MAX_SWEPT = 200;
const isFinding = (f: unknown): f is Finding => typeof (f as Finding)?.id === "string" && typeof (f as Finding)?.text === "string";

/** One hour's run: read, judge, alert once per new finding, keep state, then ping this job's own check. */
export async function runRecords(env: RecordsEnv, fetchFn: (req: Request) => Promise<Response>, now: Date) {
  let prev: State = {};
  try {
    const saved = await env.COPY.get(STATE_KEY);
    if (saved) prev = JSON.parse(await saved.text());
  } catch { /* an unreadable state re-alerts at worst: safer than silence */ }
  let swept = Array.isArray(prev.swept) ? prev.swept.filter(isFinding).slice(0, MAX_SWEPT + 1) : [];
  const findings: Finding[] = [];
  let verdict: RecordsVerdict = "healthy", reason = "";
  let checked = 0;
  if (!env.RECORDS) {
    verdict = "unverified";
    reason = "no RECORDS binding";
  } else {
    try {
      const today = day(now), yesterday = day(new Date(now.getTime() - 86_400_000));
      const days = await Promise.all([yesterday, today].map((d) => checkDay(env.RECORDS!, d)));
      for (const d of days) findings.push(...d.findings);
      const all = days.flatMap((d) => d.objs);
      checked = all.length;
      findings.push(...checkOrder(all), ...(await strays(env.RECORDS)), ...(await dayFolders(env.RECORDS, now)));
      if (now.getUTCHours() === SWEEP_HOUR) {
        const all = await sweep(env.RECORDS);
        swept = all.slice(0, MAX_SWEPT);
        if (all.length > MAX_SWEPT) swept.push({ id: "late:more", text: `${all.length - MAX_SWEPT} more records filed into other days` });
      }
    } catch {
      verdict = "unverified";
      reason = "the records could not be listed";
    }
  }
  findings.push(...swept);
  const lock = await readLockLength(env, fetchFn, now, RECORDS_BUCKET, LOCKED, MIN_LOCK_SECONDS);
  if (lock.verdict === "short" || lock.verdict === "unverified") findings.push({ id: `lock:${lock.verdict}`, text: `records lock: ${lock.reason}` });
  if (findings.length && verdict === "healthy") verdict = "findings";
  if (verdict === "healthy") reason = `${checked} records checked, all in order`;
  else if (verdict === "findings") reason = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${findings.map((f) => f.text).join("; ")}`;

  const told = new Set(prev.alerted ?? []);
  // A finding found twice (e.g. by the day and the folder checks) is one finding.
  const unique = [...new Map(findings.map((f) => [f.id, f])).values()].sort((x, y) => rank(x) - rank(y));
  const fresh = unique.filter((f) => !told.has(f.id));
  const ping = env.PING_URL_RECORDS;

  // Until Ben creates this job's check, it only logs (like fresh.ts): no alert, nothing that claims healthy.
  let via: string | undefined;
  if (ping && (fresh.length || (verdict === "unverified" && !told.has("unverified")))) {
    // An alert holds 1024 characters: only the findings that fit count as told; the rest go next hour.
    const sent: Finding[] = [];
    let text = "";
    for (const f of fresh) {
      const line = `${f.text}\n`;
      if (text.length + line.length > 900 && sent.length) break;
      text += line.slice(0, 900);
      sent.push(f);
    }
    if (sent.length < fresh.length) text += `(+${fresh.length - sent.length} more, sent next hour)`;
    via = await alert({ ...env, PING_URL: ping }, fetchFn, "Observatory: the records need you", fresh.length ? text : reason);
    for (const f of sent) told.add(f.id);
    if (verdict === "unverified") told.add("unverified");
  }
  if (verdict !== "unverified") told.delete("unverified");
  // Keep only what is still found, so a finding that comes back is told again.
  const still = new Set([...findings.map((f) => f.id), ...(verdict === "unverified" ? ["unverified"] : [])]);
  try {
    await env.COPY.put(STATE_KEY, JSON.stringify({ alerted: [...told].filter((id) => still.has(id)), swept }));
  } catch {
    reason = `records state could not be saved; ${reason}`;
    verdict = "unverified";
  }

  const report = { records: verdict, checked, lock: lock.verdict, reason: redact(reason, env).slice(0, 2000), setup: ping ? "complete" : "PING_URL_RECORDS not set: log only" };
  console.log(JSON.stringify(report));
  if (ping && via !== "healthchecks") {
    await fetchFn(new Request(verdict === "healthy" ? ping : `${ping}/fail`, { method: "POST", body: JSON.stringify(report) })).catch(() => undefined);
  }
  return report;
}
