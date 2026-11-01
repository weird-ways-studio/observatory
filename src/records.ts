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
  RECORDS_HELD_ACK?: string; // for each held number, the copy Ben trusts, e.g. "42:grant-0001.request,97:grant-0002.result" (a setting only he sets)
}

export const RECORDS_BUCKET = "observatory-records"; // the RECORDS binding's bucket (wrangler.jsonc)
export const LOCKED = "records/";
export const MIN_LOCK_SECONDS = 400 * 86_400; // over a year of history, then lifecycle may delete
export const STATE_KEY = "state/records.json";
export const PAGE = 500; // records read an hour (one list and one read each): more than the recorder can take in a day
export const SWEEP_HOUR = 4; // UTC: once a day every name in the bucket is counted
export const SWEEP_PAGES = 200; // up to 200,000 records counted; beyond that the sweep says so
export const MAX_OPEN = 2_000; // grants remembered for the order check
export const MAX_SWEPT = 50;
export const MAX_NAMES_AT = 1_000; // names listed under one record number before the hour gives up as unverified
export const MAX_HELD = 20; // shared record numbers re-checked every hour until Ben clears them
export const MAX_QUEUED = 200; // findings not yet delivered, carried hour to hour, worst first

/** One finding: `id` is stable across hours so Ben hears about it once. Text never holds writer-chosen words. */
export interface Finding { id: string; text: string }
interface Open { job: string; req: string; at: number; stages: Stage[] }
interface Snap { seq: number; open: Record<string, Open>; days: Record<string, number> }
interface State { snap?: Snap; replayTo?: number; held?: number[]; seq?: number; open?: Record<string, Open>; days?: Record<string, number>; alerted?: string[]; swept?: Finding[]; queued?: Finding[] }

const day = (d: Date) => d.toISOString().slice(0, 10);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A short fingerprint for a name we must not repeat: enough for Ben (or an agent) to find it. */
const tag = async (name: string) => (await sha256(name)).slice(0, 12);
const stray = async (name: string): Promise<Finding> => { const t = await tag(name); return { id: `stray:${t}`, text: `something outside the record format, fingerprint ${t}` }; };
const pad = (n: number) => String(n).padStart(12, "0");
/**
 * How a grant id appears in alerts: the first 16 hex of its SHA-256, never the id itself, so a
 * writer cannot put words into Ben's alerts, and cannot make one grant's fingerprint look like
 * another's. Grant findings also name the record number, which settles any doubt.
 */
export const fp = async (grant: string) => `#${(await sha256(grant)).slice(0, 16)}`;
// Worst first: what ran unrecorded or unchecked before what is merely malformed.
const RANK = ["unrecorded", "unapproved", "approval-first", "mismatch", "duplicate", "duplicate-number", "foreign", "gap", "lock", "cap", "backlog", "verdict-first", "bad", "stray", "sweep"];
const rank = (f: Finding) => { const i = RANK.indexOf(f.id.split(":")[0]); return i < 0 ? RANK.length : i; };
const isFinding = (f: unknown): f is Finding => typeof (f as Finding)?.id === "string" && typeof (f as Finding)?.text === "string";

/** Checks one stored record on its own: its envelope against its name and R2's upload time, then the writer's body. */
export async function checkStored(seq: number, grant: string, stage: Stage, uploaded: Date, stored: string): Promise<{ finding?: Finding; env?: Envelope; job?: string; request?: string }> {
  const shown = await fp(grant);
  const bad = (why: string) => ({ finding: { id: `bad:${seq}`, text: `record ${seq} (${shown}/${stage}): ${why}` } });
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
export function checkOrder(open: Record<string, Open>, grant: string, stage: Stage, job: string, request: string | undefined, sha: string, at: number, n: number, shown: string): Finding | undefined {
  const g = Object.hasOwn(open, grant) ? open[grant] : undefined;
  if (stage === "request") {
    if (g) return { id: `duplicate:${grant}:request`, text: `grant ${shown} (record ${n}) has a second request record` };
    open[grant] = { job, req: sha, at, stages: ["request"] };
    return undefined;
  }
  if (!g) {
    if (stage === "result") return { id: `unrecorded:${grant}`, text: `grant ${shown} (record ${n}) has a result with no request record before it: something ran unrecorded` };
    return { id: `${stage === "approval" ? "approval-first" : "verdict-first"}:${grant}`, text: `grant ${shown} (record ${n}) has a${stage === "approval" ? "n approval" : " verdict"} with no request record before it` };
  }
  if (g.stages.includes(stage)) return { id: `duplicate:${grant}:${stage}`, text: `grant ${shown} (record ${n}) has a second ${stage} record` };
  g.stages.push(stage);
  if (request !== g.req || job !== g.job) return { id: `mismatch:${grant}`, text: `grant ${shown} (record ${n}): a later record names a different request or job than its request record` };
  if (stage === "result" && !g.stages.includes("approval")) return { id: `unapproved:${grant}`, text: `grant ${shown} (record ${n}) has a result with no approval record before it` };
  return undefined;
}

/** Every name under one record number's prefix, paged, up to MAX_NAMES_AT: record names and anything else. */
async function namesAt(bucket: Pick<R2Bucket, "list">, prefix: string): Promise<{ cands: R2Object[]; junk: string[]; capped: boolean }> {
  const cands: R2Object[] = [], junk: string[] = [];
  let cursor: string | undefined, seen = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) (KEY.test(o.key) ? cands.push(o) : junk.push(o.key));
    seen += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && seen < MAX_NAMES_AT);
  return { cands, junk: junk.slice(0, 20), capped: Boolean(cursor) };
}

/** Each copy at a shared number checked on its own (findings only; none counts toward a grant or a day). */
async function checkCopies(bucket: Pick<R2Bucket, "get">, n: number, copies: R2Object[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const o of copies) {
    const m = KEY.exec(o.key)!, grant = m[2], stage = m[3] as Stage;
    const body = o.size > MAX_STORED_BYTES ? null : await bucket.get(o.key).then((b) => (b ? b.text() : null), () => null);
    const r = body === null ? undefined : await checkStored(n, grant, stage, o.uploaded, body).catch(() => undefined);
    if (!r) out.push({ id: `bad:${n}:${grant}.${stage}`, text: `record ${n} (${await fp(grant)}/${stage}): too large or could not be read` });
    else if (r.finding) out.push({ ...r.finding, id: `${r.finding.id}:${grant}.${stage}` });
  }
  return out;
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
  const bare = <T>(o: unknown): Record<string, T> => Object.assign(Object.create(null), o && typeof o === "object" ? o : {});
  let open = bare<Open>(prev.open);
  let days = bare<number>(prev.days);
  let seq = Number.isInteger(prev.seq) ? prev.seq! : 0; // the last record number checked: the bookmark
  const held = new Set((Array.isArray(prev.held) ? prev.held : []).filter((n) => Number.isInteger(n)));
  // Taken just before the first held number: the bookkeeping to rewind to once Ben names a copy.
  let snap: Snap | undefined = prev.snap && Number.isInteger(prev.snap.seq) ? prev.snap : undefined;
  // While a rewind is being re-read, nothing is tidied away until the bookmark is back where it was.
  let replayTo = Number.isInteger(prev.replayTo) ? prev.replayTo! : 0;
  // For each held number, the copy Ben trusts ("42:<grant>.<stage>"), from a setting only he sets.
  const trusted = new Map<number, string>();
  for (const part of (env.RECORDS_HELD_ACK ?? "").split(",")) {
    const m = /^\s*(\d{1,12}):([A-Za-z0-9][A-Za-z0-9_-]{7,63}\.(?:request|approval|verdict|result))\s*$/.exec(part);
    if (m) trusted.set(Number(m[1]), m[2]);
  }
  if (held.size && snap && trusted.has(Math.min(...held))) {
    // Ben named the copy at the earliest held number: rewind to just before it and read on from
    // there in order, his copy standing as that number's record, so order and day counts come out
    // exactly as if it had been the only one. Later shared numbers are met again on the way.
    replayTo = Math.max(replayTo, seq);
    ({ seq } = snap);
    open = bare<Open>(snap.open);
    days = bare<number>(snap.days);
    held.clear();
    snap = undefined;
  }
  let swept = Array.isArray(prev.swept) ? prev.swept.filter(isFinding).slice(0, MAX_SWEPT) : [];
  // A record is read once, so a finding not yet delivered is carried until it is.
  const findings: Finding[] = Array.isArray(prev.queued) ? prev.queued.filter(isFinding).slice(0, MAX_QUEUED) : [];
  let verdict: RecordsVerdict = "healthy", reason = "", checked = 0;

  if (!env.RECORDS) {
    verdict = "unverified";
    reason = "no RECORDS binding";
  } else {
    try {
      // Each step asks for the next expected number by name, so names elsewhere in the bucket
      // (strays, planted high numbers) cost nothing and can never hide the records still to come.
      while (checked < PAGE) {
        const next = seq + 1, at = `${ROOT}${pad(next)}.`;
        const here = await namesAt(env.RECORDS, at);
        for (const k of here.junk) findings.push(await stray(k));
        if (here.capped) {
          verdict = "unverified";
          reason = `over ${MAX_NAMES_AT} names at record number ${next}: it could not be read`;
          break;
        }
        const cands = here.cands;
        if (!cands.length) {
          // Nothing at the next number: the recorder has not written it yet. Anything right after
          // it is either a gap (a higher number without this one) or something outside the format.
          const after = (await env.RECORDS.list({ prefix: ROOT, startAfter: at, limit: 1 })).objects[0];
          const am = after && KEY.exec(after.key);
          if (after && !am) findings.push(await stray(after.key));
          else if (am) findings.push({ id: `gap:${Number(am[1])}`, text: `record numbers jumped from ${seq} to ${Number(am[1])}: number ${next} is missing` });
          break;
        }
        let o = cands[0];
        if (cands.length > 1) {
          // Objects share a number: the recorder wrote at most one, and the checker cannot tell which
          // (it cannot read the recorder's ledger, by design). Every copy is checked; unless Ben has
          // named the one he trusts, the number is held (re-checked every hour, counted toward
          // nothing) and reading goes on past it.
          findings.push({ id: `duplicate-number:${next}`, text: `${cands.length} objects share record number ${next}: none is trusted; something wrote around the recorder` });
          const pick = trusted.get(next);
          const chosen = cands.find((c) => { const k = KEY.exec(c.key)!; return pick === `${k[2]}.${k[3]}`; });
          findings.push(...(await checkCopies(env.RECORDS, next, cands.filter((c) => c !== chosen))));
          if (chosen) o = chosen;
          else {
            if (held.size >= MAX_HELD) {
              verdict = "unverified";
              reason = `${MAX_HELD} record numbers are already held: reading stopped at ${next} until Ben clears some`;
              break;
            }
            if (!held.size) snap = { seq, open: JSON.parse(JSON.stringify(open)), days: { ...days } };
            held.add(next);
            seq = next;
            checked++;
            continue;
          }
        }
        const m = KEY.exec(o.key)!;
        const grant = m[2], stage = m[3] as Stage;
        const shown = await fp(grant);
        try {
          if (o.size > MAX_STORED_BYTES) {
            findings.push({ id: `bad:${next}`, text: `record ${next} (${shown}/${stage}): ${o.size} bytes, over ${MAX_STORED_BYTES}` });
          } else {
            const body = await env.RECORDS.get(o.key).then((b) => (b ? b.text() : null), () => null);
            if (body === null) {
              // Stop here and read it again next hour: the bookmark never passes a record not checked.
              verdict = "unverified";
              reason = `record ${next} could not be read`;
              break;
            }
            const r = await checkStored(next, grant, stage, o.uploaded, body);
            if (r.finding) findings.push(r.finding);
            else {
              const f = checkOrder(open, grant, stage, r.job!, r.request, r.env!.sha256, o.uploaded.getTime(), next, shown);
              if (f) findings.push(f);
            }
          }
        } catch {
          findings.push({ id: `bad:${next}`, text: `record ${next} (${shown}/${stage}): could not be checked` });
        }
        seq = next;
        const d = day(o.uploaded);
        days[d] = (days[d] ?? 0) + 1;
        checked++;
      }
      if (checked === PAGE && verdict === "healthy") findings.push({ id: `backlog:${day(now)}`, text: `${PAGE} new records in an hour, over what the recorder can take: the rest are read next hour` });
      // Held numbers: every copy re-checked each hour, so the recorder's own is checked whenever it lands.
      for (const n of [...held].sort((a, b) => a - b)) {
        const here = await namesAt(env.RECORDS, `${ROOT}${pad(n)}.`);
        for (const k of here.junk) findings.push(await stray(k));
        if (here.capped) {
          verdict = "unverified";
          reason = `over ${MAX_NAMES_AT} names at held record number ${n}: it could not be read`;
          continue;
        }
        findings.push({ id: `duplicate-number:${n}`, text: `${here.cands.length} objects share record number ${n}: none is trusted; something wrote around the recorder` });
        findings.push(...(await checkCopies(env.RECORDS, n, here.cands)));
      }
      if (held.size) {
        verdict = "unverified";
        const heldWhy = `record number${held.size === 1 ? "" : "s"} ${[...held].sort((a, b) => a - b).slice(0, MAX_HELD).join(", ")}${held.size > MAX_HELD ? " and more" : ""} held (shared by several objects): reading goes on, but the run stays unverified until Ben names the copy he trusts in RECORDS_HELD_ACK, earliest number first`;
        reason = reason ? `${reason}; ${heldWhy}` : heldWhy;
      }
      findings.push(...(await strays(env.RECORDS)));
      if (now.getUTCHours() === SWEEP_HOUR) swept = await sweep(env.RECORDS, seq);
    } catch {
      verdict = "unverified";
      reason = "the records could not be listed";
    }
  }
  for (const [d, n] of Object.entries(days)) if (n > DAY_CAP) findings.push({ id: `cap:${d}`, text: `${n} records stored on ${d}, over the cap of ${DAY_CAP}` });
  findings.push(...swept);
  // Forget grants past their life, keeping at most MAX_OPEN, and day counts older than three days --
  // but not while a rewind is still being re-read: that bookkeeping is what the replay checks against.
  if (replayTo && seq >= replayTo) replayTo = 0;
  if (!replayTo) {
    for (const [g, o] of Object.entries(open)) if (now.getTime() - o.at > GRANT_TTL_MS + 86_400_000) delete open[g];
    for (const g of Object.keys(open).sort((a, b) => open[a].at - open[b].at).slice(0, Math.max(0, Object.keys(open).length - MAX_OPEN))) delete open[g];
    for (const d of Object.keys(days)) if (d < day(new Date(now.getTime() - 3 * 86_400_000))) delete days[d];
  }

  const lock = await readLockLength(env, fetchFn, now, RECORDS_BUCKET, LOCKED, MIN_LOCK_SECONDS);
  // No lock evidence is never healthy: until LOCK_READ_TOKEN is set, that is a standing finding.
  if (lock.verdict !== "ok") findings.push({ id: `lock:${lock.verdict}`, text: "reason" in lock ? `records lock: ${lock.reason}` : "records lock not checked: LOCK_READ_TOKEN is not set yet" });
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
    await env.COPY.put(STATE_KEY, JSON.stringify({ snap, replayTo, held: [...held], seq, open, days, alerted: [...told].filter((id) => still.has(id)), swept, queued } satisfies State));
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
