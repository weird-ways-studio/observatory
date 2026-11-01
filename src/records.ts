// Phase 2a (card feea07eb, route A; PLAN.md phase 2a): the hourly second line behind the recorder.
// The recorder Worker (src/recorder/) is the only intended writer of the observatory-records
// bucket: it refuses bad records before storing them and names each one with a gap-free sequence
// number. This job re-reads every record the recorder stored since its last run, in that order,
// against the same contract (src/contract.ts), and alerts on anything the recorder should have
// refused or that something else wrote. It only tells; it never acts on the front desk.
import { alert, redact, type AlertEnv } from "./alert.ts";
import { DAY_CAP, GRANT_TTL_MS, KEY, MAX_STORED_BYTES, ROOT, sha256, SKEW_MS, validate, type Envelope, type Stage } from "./contract.ts";
import { readLockLength, type LockEnv } from "./lock.ts";

export interface RecordsEnv extends AlertEnv, LockEnv {
  RECORDS?: Pick<R2Bucket, "list" | "get">; // read and list only: this job never writes there
  COPY: Pick<R2Bucket, "get" | "put">; // state/records.json lives in the copy bucket's unlocked state/
  PING_URL_RECORDS?: string; // this job's own healthchecks check; Ben creates it at the end of the build
}

export const RECORDS_BUCKET = "observatory-records"; // the RECORDS binding's bucket (wrangler.jsonc)
export const LOCKED = "records/";
export const MIN_LOCK_SECONDS = 400 * 86_400; // over a year of history, then lifecycle may delete
export const STATE_KEY = "state/records.json";
export const PAGE = 500; // records read an hour: more than the recorder can take in a day's cap
export const SWEEP_HOUR = 4; // UTC: once a day every name in the bucket is counted
export const SWEEP_PAGES = 200; // up to 200,000 records counted; beyond that the sweep says so
export const MAX_OPEN = 2_000; // grants remembered for the order check
export const MAX_SWEPT = 50;
export const MAX_QUEUED = 200; // findings not yet delivered, carried hour to hour, worst first

/** One finding: `id` is stable across hours so Ben hears about it once. Text never holds writer-chosen words. */
export interface Finding { id: string; text: string }
interface Open { job: string; req: string; at: number; stages: Stage[] }
interface State { cursor?: string; seq?: number; open?: Record<string, Open>; days?: Record<string, number>; alerted?: string[]; swept?: Finding[]; queued?: Finding[] }

const day = (d: Date) => d.toISOString().slice(0, 10);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A short fingerprint for a name we must not repeat: enough for Ben (or an agent) to find it. */
const tag = async (name: string) => (await sha256(name)).slice(0, 12);
// Worst first: what ran unrecorded or unchecked before what is merely malformed.
const RANK = ["unrecorded", "unapproved", "approval-first", "mismatch", "duplicate", "foreign", "gap", "lock", "cap", "backlog", "verdict-first", "bad", "stray", "sweep"];
const rank = (f: Finding) => { const i = RANK.indexOf(f.id.split(":")[0]); return i < 0 ? RANK.length : i; };
const isFinding = (f: unknown): f is Finding => typeof (f as Finding)?.id === "string" && typeof (f as Finding)?.text === "string";

/** Checks one stored record on its own: its envelope against its name and R2's upload time, then the writer's body. */
export async function checkStored(seq: number, grant: string, stage: Stage, uploaded: Date, stored: string): Promise<{ finding?: Finding; env?: Envelope; job?: string; request?: string }> {
  const bad = (why: string) => ({ finding: { id: `bad:${seq}`, text: `record ${seq} (${grant}/${stage}): ${why}` } });
  let e: Envelope;
        try {
      e = JSON.parse(stored);
        } catch {
    return bad("not JSON");
  }
  if (!e || e.v !== 1 || e.seq !== seq || e.grant !== grant || e.stage !== stage) return bad("its envelope does not match its name");
  if (typeof e.recorded_at !== "string" || !ISO.test(e.recorded_at) || Math.abs(Date.parse(e.recorded_at) - uploaded.getTime()) > SKEW_MS) return bad("its recorded time is missing or far from when it was stored");
  if (typeof e.body !== "string" || e.sha256 !== (await sha256(e.body))) return bad("its body does not match its hash");
  const v = validate(e.body);
  if (!v.ok) return bad(v.why);
  if (v.record.grant !== grant || v.record.stage !== stage) return bad("its body names a different grant or stage than its name");
  return { env: e, job: v.record.job, request: v.record.request };
}

/** The order check for one record, against the grants seen so far. Updates `open`. */
export function checkOrder(open: Record<string, Open>, grant: string, stage: Stage, job: string, request: string | undefined, sha: string, at: number): Finding | undefined {
  const g = Object.hasOwn(open, grant) ? open[grant] : undefined;
  if (stage === "request") {
    if (g) return { id: `duplicate:${grant}:request`, text: `grant ${grant} has a second request record` };
    open[grant] = { job, req: sha, at, stages: ["request"] };
    return undefined;
  }
  if (!g) {
    if (stage === "result") return { id: `unrecorded:${grant}`, text: `grant ${grant} has a result with no request record before it: something ran unrecorded` };
    return { id: `${stage === "approval" ? "approval-first" : "verdict-first"}:${grant}`, text: `grant ${grant} has a${stage === "approval" ? "n approval" : " verdict"} with no request record before it` };
  }
  if (g.stages.includes(stage)) return { id: `duplicate:${grant}:${stage}`, text: `grant ${grant} has a second ${stage} record` };
  g.stages.push(stage);
  if (request !== g.req || job !== g.job) return { id: `mismatch:${grant}`, text: `grant ${grant}: a later record names a different request or job than its request record` };
  if (stage === "result" && !g.stages.includes("approval")) return { id: `unapproved:${grant}`, text: `grant ${grant} has a result with no approval record before it` };
  return undefined;
}

/** Names outside records/v1/: the bucket's top level and records/ itself, one bounded page each. */
async function strays(bucket: Pick<R2Bucket, "list">): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [prefix, allowed] of [["", "records/"], ["records/", ROOT]] as const) {
    const page = await bucket.list({ prefix, delimiter: "/", limit: 1000 });
    for (const name of [...page.delimitedPrefixes.filter((p) => p !== allowed), ...page.objects.map((o) => o.key)]) {
      const t = await tag(name);
      out.push({ id: `stray:${t}`, text: `something outside the record format, fingerprint ${t}` });
    }
    if (page.truncated) out.push({ id: `stray:more:${prefix}`, text: "more than a page of names outside the record format" });
  }
  return out;
}

/** Every name under records/v1/, counted up to SWEEP_PAGES pages: it must equal what the recorder numbered. */
async function sweep(bucket: Pick<R2Bucket, "list">, seq: number): Promise<Finding[]> {
  let count = 0, cursor: string | undefined;
  for (let pages = 0; pages < SWEEP_PAGES; pages++) {
    const page = await bucket.list({ prefix: ROOT, cursor, limit: 1000 });
    count += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
    if (!cursor) {
      if (count === seq) return [];
      return [{ id: `foreign:${count}`, text: `the bucket holds ${count} records but the recorder numbered ${seq}: something wrote around the recorder` }];
    }
  }
  return [{ id: "sweep:incomplete", text: `over ${SWEEP_PAGES * 1000} records: the daily count could not finish` }];
}

export type RecordsVerdict = "healthy" | "findings" | "unverified";

/** One hour's run: read what is new, judge, alert once per new finding that is delivered, keep state, ping. */
export async function runRecords(env: RecordsEnv, fetchFn: (req: Request) => Promise<Response>, now: Date) {
  let prev: State = {};
  try {
    const saved = await env.COPY.get(STATE_KEY);
    if (saved) prev = JSON.parse(await saved.text());
  } catch { /* an unreadable state re-reads from the start and re-alerts at worst: safer than silence */ }
  // No prototype: a grant id can never reach a built-in object property.
  const open: Record<string, Open> = Object.assign(Object.create(null), prev.open && typeof prev.open === "object" ? prev.open : {});
  const days: Record<string, number> = Object.assign(Object.create(null), prev.days && typeof prev.days === "object" ? prev.days : {});
  let cursor = typeof prev.cursor === "string" ? prev.cursor : undefined, seq = Number.isInteger(prev.seq) ? prev.seq! : 0;
  let swept = Array.isArray(prev.swept) ? prev.swept.filter(isFinding).slice(0, MAX_SWEPT) : [];
  // A record is read once, so a finding not yet delivered is carried until it is.
  const findings: Finding[] = Array.isArray(prev.queued) ? prev.queued.filter(isFinding).slice(0, MAX_QUEUED) : [];
  let verdict: RecordsVerdict = "healthy", reason = "", checked = 0;

  if (!env.RECORDS) {
    verdict = "unverified";
    reason = "no RECORDS binding";
  } else {
    try {
      const page = await env.RECORDS.list({ prefix: ROOT, startAfter: cursor, limit: PAGE });
      for (const o of page.objects) {
        const m = KEY.exec(o.key);
        // The bookmark moves only to the next expected number, so no planted name can park it
        // past the records still to come: a stray is reported every hour it stays in view, and a
        // jump in the numbers stops the read there until it is resolved.
        if (!m) {
          const t = await tag(o.key);
          findings.push({ id: `stray:${t}`, text: `something outside the record format, fingerprint ${t}` });
          continue;
        }
        const n = Number(m[1]), grant = m[2], stage = m[3] as Stage;
        if (n <= seq) {
          findings.push({ id: `gap:${n}:repeat`, text: `record number ${n} appeared after ${seq}: a name the recorder already used` });
          continue;
        }
        if (n > seq + 1) {
          findings.push({ id: `gap:${n}`, text: `record numbers jumped from ${seq} to ${n}: reading stops there until it is resolved` });
          break;
        }
        try {
        if (o.size > MAX_STORED_BYTES) {
          findings.push({ id: `bad:${n}`, text: `record ${n} (${grant}/${stage}): ${o.size} bytes, over ${MAX_STORED_BYTES}` });
        } else {
          const body = await env.RECORDS.get(o.key).then((b) => (b ? b.text() : null), () => null);
          if (body === null) {
            // Stop here and read it again next hour: the bookmark never passes a record not checked.
            verdict = "unverified";
            reason = `record ${n} could not be read`;
            break;
          }
          const r = await checkStored(n, grant, stage, o.uploaded, body);
          if (r.finding) findings.push(r.finding);
          else {
            const f = checkOrder(open, grant, stage, r.job!, r.request, r.env!.sha256, o.uploaded.getTime());
            if (f) findings.push(f);
          }
        }
        } catch {
          findings.push({ id: `bad:${n}`, text: `record ${n} (${grant}/${stage}): could not be checked` });
        }
        seq = n;
        const d = day(o.uploaded);
        days[d] = (days[d] ?? 0) + 1;
        cursor = o.key;
        checked++;
      }
      if (page.truncated && verdict === "healthy") findings.push({ id: `backlog:${day(now)}`, text: `more than ${PAGE} new records in an hour, over what the recorder can take: the rest are read next hour` });
      findings.push(...(await strays(env.RECORDS)));
      if (now.getUTCHours() === SWEEP_HOUR) swept = await sweep(env.RECORDS, seq);
    } catch {
      verdict = "unverified";
      reason = "the records could not be listed";
    }
  }
  for (const [d, n] of Object.entries(days)) if (n > DAY_CAP) findings.push({ id: `cap:${d}`, text: `${n} records stored on ${d}, over the cap of ${DAY_CAP}` });
  findings.push(...swept);
  // Forget grants past their life, keeping at most MAX_OPEN, and day counts older than three days.
  for (const [g, o] of Object.entries(open)) if (now.getTime() - o.at > GRANT_TTL_MS + 86_400_000) delete open[g];
  for (const g of Object.keys(open).sort((a, b) => open[a].at - open[b].at).slice(0, Math.max(0, Object.keys(open).length - MAX_OPEN))) delete open[g];
  for (const d of Object.keys(days)) if (d < day(new Date(now.getTime() - 3 * 86_400_000))) delete days[d];

  const lock = await readLockLength(env, fetchFn, now, RECORDS_BUCKET, LOCKED, MIN_LOCK_SECONDS);
  if (lock.verdict === "short" || lock.verdict === "unverified") findings.push({ id: `lock:${lock.verdict}`, text: `records lock: ${lock.reason}` });
  if (findings.length && verdict === "healthy") verdict = "findings";
  if (verdict === "healthy") reason = `${checked} new records checked, all in order`;
  else if (verdict === "findings") reason = `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${findings.map((f) => f.text).join("; ")}`;

  const told = new Set(prev.alerted ?? []);
  // A finding found twice is one finding.
  const unique = [...new Map(findings.map((f) => [f.id, f])).values()].sort((x, y) => rank(x) - rank(y));
  const fresh = unique.filter((f) => !told.has(f.id));
  const ping = env.PING_URL_RECORDS;

  // Until Ben creates this job's check, it only logs (like fresh.ts): no alert, nothing that claims healthy.
  let via: string | undefined;
  if (ping && (fresh.length || (verdict === "unverified" && !told.has("unverified")))) {
    // An alert holds 1024 characters: only the findings that fit, worst first, can count as told.
    const sent: Finding[] = [];
    let text = "";
    for (const f of fresh) {
      const line = `${f.text.slice(0, 300)}\n`;
      if (text.length + line.length > 900) break;
      text += line;
      sent.push(f);
    }
    if (sent.length < fresh.length) text += `(+${fresh.length - sent.length} more, sent next hour)`;
    via = await alert({ ...env, PING_URL: ping }, fetchFn, "Observatory: the records need you", fresh.length ? text : reason);
    // Told only if a channel took it; otherwise every finding is tried again next hour.
    if (via !== "none") {
      for (const f of sent) told.add(f.id);
      if (verdict === "unverified") told.add("unverified");
    }
  }
  if (verdict !== "unverified") told.delete("unverified");
  const queued = unique.filter((f) => !told.has(f.id));
  if (queued.length > MAX_QUEUED) queued.splice(MAX_QUEUED - 1, Infinity, { id: "queued:more", text: `${queued.length - MAX_QUEUED + 1} more findings could not be kept: read the records` });
  // Keep only what is still found, so a finding that comes back is told again.
  const still = new Set([...findings.map((f) => f.id), ...(verdict === "unverified" ? ["unverified"] : [])]);
  try {
    await env.COPY.put(STATE_KEY, JSON.stringify({ cursor, seq, open, days, alerted: [...told].filter((id) => still.has(id)), swept, queued } satisfies State));
  } catch {
    reason = `records state could not be saved; ${reason}`;
    verdict = "unverified";
  }

  const report = { records: verdict, checked, seq, lock: lock.verdict, reason: redact(reason, env).slice(0, 2000), setup: ping ? "complete" : "PING_URL_RECORDS not set: log only" };
  console.log(JSON.stringify(report));
  if (ping && via !== "healthchecks") {
    await fetchFn(new Request(verdict === "healthy" ? ping : `${ping}/fail`, { method: "POST", body: JSON.stringify(report) })).catch(() => undefined);
  }
  return report;
}
