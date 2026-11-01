// The recorder's core (card feea07eb, route A). One instance runs inside one Durable Object
// (src/recorder/index.ts), so every write in the Observatory goes through this queue in turn.
// It decides, before anything is stored: is the record in the contract, is its stage in order for
// its grant, is there room today and in the storage budget. Then it saves the record as pending,
// writes it to the locked bucket, and only then answers with a receipt. A crash between those
// steps leaves the pending record, which the next call finishes first -- so sequence numbers never
// have gaps.
import { DAY_CAP, GRANT_TTL_MS, keyFor, MAX_STORED_BYTES, sha256, SKEW_MS, STAGE_SLOTS, STORE_BUDGET_BYTES, validate, type Envelope, type Receipt, type Stage } from "../contract.ts";

/** The slice of Durable Object storage used here; each put of several keys is one atomic write. */
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export type Bucket = Pick<R2Bucket, "get" | "put" | "list">;

// An open grant still holds `left` reserved slots for its later stages, whatever day they land on.
interface Open { grant: string; opened: number; left: number }
// `used`: today's slots (records written plus reserved, including reservations carried over from
// grants opened yesterday). `bytes`: every stored envelope's size, for the lifetime budget.
interface Meta { seq: number; day: string; used: number; bytes: number; open: Open[] }
interface Grant { job: string; request: string; opened: number; stages: Partial<Record<Stage, Receipt>> }
interface Pending { key: string; stored: string; storedSha: string; receipt: Receipt; day: string } // `day`: the UTC day its slot was charged to

export type Outcome =
  | { status: 200 | 201; receipt: Receipt }
  | { status: 400 | 409 | 410 | 429 | 503; why: string };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const reservedBytes = (m: Meta) => m.open.reduce((n, o) => n + o.left, 0) * MAX_STORED_BYTES;

/** A new UTC day starts with the slots still reserved by open grants, never at zero. */
function rollover(m: Meta, t: number): Meta {
  if (m.day === day(t)) return m;
  const open = m.open.filter((o) => t - o.opened <= GRANT_TTL_MS && o.left > 0);
  return { ...m, day: day(t), open, used: open.reduce((n, o) => n + o.left, 0) };
}

/** Admits, orders and stores records one at a time; see the file comment. */
export class Ledger {
  #queue: Promise<unknown> = Promise.resolve();
  private storage: Storage;
  private bucket: Bucket;
  private budget: number;
  constructor(storage: Storage, bucket: Bucket, budget = STORE_BUDGET_BYTES) {
    this.storage = storage;
    this.bucket = bucket;
    this.budget = budget;
  }

  /**
   * One write at a time, in arrival order: a later call waits for the one before to finish. The
   * time is read when its turn comes, so recorded times rise with sequence numbers.
   */
  accept(body: string, clock: () => Date = () => new Date()): Promise<Outcome> {
    const run = this.#queue.then(() => this.#accept(body, clock()));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Today's slot use, the storage budget, and whether a write is pending; nothing writer-chosen. */
  async status(now: Date) {
    const stored = await this.storage.get<Meta>("meta");
    const meta = stored ? rollover(stored, now.getTime()) : undefined;
    const pending = await this.storage.get<Pending>("pending");
    return { seq: meta?.seq ?? 0, used_today: meta?.used ?? 0, cap: DAY_CAP, stored_bytes: meta?.bytes ?? 0, budget_bytes: this.budget, pending: Boolean(pending) };
  }

  /** One record's turn: finish any pending write, check, reserve, queue, store, receipt. */
  async #accept(body: string, now: Date): Promise<Outcome> {
    // An unfinished write always goes first; until it is stored nothing new is taken.
    const stuck = await this.#finishPending(now);
    if (stuck) return { status: 503, why: stuck };

    const checked = validate(body);
    if (!checked.ok) return { status: 400, why: checked.why };
    const r = checked.record, sha = await sha256(body), t = now.getTime();
    const grant = await this.storage.get<Grant>(`g:${r.grant}`);

    const done = grant?.stages[r.stage];
    if (done) {
      // The same bytes again (a lost answer, retried) get the same receipt; anything else is refused.
      return done.sha256 === sha ? { status: 200, receipt: done } : { status: 409, why: "this stage of this grant is already recorded with other content" };
    }
    let meta = rollover((await this.storage.get<Meta>("meta")) ?? { seq: 0, day: day(t), used: 0, bytes: 0, open: [] }, t);

    let next: Grant;
    if (r.stage === "request") {
      if (meta.used + STAGE_SLOTS > DAY_CAP) return { status: 429, why: `today's ${DAY_CAP} record slots are taken` };
      if (meta.bytes + reservedBytes(meta) + STAGE_SLOTS * MAX_STORED_BYTES > this.budget) return { status: 429, why: "the recorder's storage budget is full: Ben must decide" };
      meta = { ...meta, used: meta.used + STAGE_SLOTS, open: [...meta.open, { grant: r.grant, opened: t, left: STAGE_SLOTS - 1 }] };
      next = { job: r.job, request: sha, opened: t, stages: {} };
    } else {
      if (!grant) return { status: 409, why: "no request is recorded for this grant" };
      if (t - grant.opened > GRANT_TTL_MS) return { status: 410, why: "this grant's request is over 24 hours old" };
      if (r.request !== grant.request) return { status: 409, why: "the request hash does not match the recorded request" };
      if (r.job !== grant.job) return { status: 409, why: "the job does not match the recorded request" };
      if (r.stage === "result" && !grant.stages.approval) return { status: 409, why: "no approval is recorded for this grant" };
      // Its slot was reserved when the request was taken (and carried into today if need be).
      meta = { ...meta, open: meta.open.map((o) => (o.grant === r.grant ? { ...o, left: Math.max(0, o.left - 1) } : o)) };
      next = grant;
    }

    const seq = meta.seq + 1, key = keyFor(seq, r.grant, r.stage);
    const receipt: Receipt = { v: 1, seq, key, grant: r.grant, stage: r.stage, sha256: sha, recorded_at: now.toISOString() };
    const envelope: Envelope = { v: 1, seq, grant: r.grant, stage: r.stage, recorded_at: receipt.recorded_at, sha256: sha, body };
    const stored = JSON.stringify(envelope);
    const pending: Pending = { key, stored, storedSha: await sha256(stored), receipt, day: meta.day };
    // Counted, ordered and queued in one atomic step, before the bucket is touched.
    await this.storage.put({
      meta: { ...meta, seq, bytes: meta.bytes + new TextEncoder().encode(stored).length },
      [`g:${r.grant}`]: { ...next, stages: { ...next.stages, [r.stage]: receipt } },
      pending,
    });
    const stuckNow = await this.#finishPending(now);
    if (stuckNow) return { status: 503, why: stuckNow };
    const final = (await this.storage.get<Grant>(`g:${r.grant}`))!.stages[r.stage]!;
    return { status: 201, receipt: final };
  }

  /** Stores the pending record, if any. Returns why it could not, or undefined once it is stored. */
  async #finishPending(now: Date): Promise<string | undefined> {
    let p = await this.storage.get<Pending>("pending");
    if (!p) return undefined;
    try {
      // Nothing but this record may sit under its number. Something else there (planted ahead of
      // the recorder) would let a checker read it as this number's record: stop until Ben looks.
      const prefix = p.key.slice(0, p.key.indexOf(".") + 1);
      const here = (await this.bucket.list({ prefix, limit: 10 })).objects.map((o) => o.key);
      if (here.some((k) => k !== p!.key)) return "the next record's number is taken by an object the recorder did not write: Ben must look";
      const there = here.includes(p.key) ? await this.bucket.get(p.key) : null;
      if (there) {
        // Stored before a crash: fine only if its raw bytes are ours.
        if ((await sha256(new Uint8Array(await there.arrayBuffer()))) !== p.storedSha) return "the next record's name is taken by an object the recorder did not write: Ben must look";
      } else {
        if (now.getTime() - Date.parse(p.receipt.recorded_at) > SKEW_MS / 2 || day(now.getTime()) !== p.day) {
          // Stored late (the bucket was down), or on a later UTC day however briefly: no receipt has
          // gone out, so it takes the time it is actually stored, and its receipt says the same.
          const receipt = { ...p.receipt, recorded_at: now.toISOString() };
          const stored = JSON.stringify({ ...(JSON.parse(p.stored) as Envelope), recorded_at: receipt.recorded_at });
          const g = (await this.storage.get<Grant>(`g:${receipt.grant}`))!;
          const writes: Record<string, unknown> = { [`g:${receipt.grant}`]: { ...g, stages: { ...g.stages, [receipt.stage]: receipt } } };
          let charged = p.day;
          if (day(now.getTime()) !== p.day) {
            // Stored on a later UTC day: it is charged to that day. Nothing else is taken while a
            // record is pending, so this is the day's first write, after the carried reservations.
            const m = rollover((await this.storage.get<Meta>("meta"))!, now.getTime());
            if (m.used + 1 > DAY_CAP) return `today's ${DAY_CAP} record slots are taken; the pending record waits`;
            writes.meta = { ...m, used: m.used + 1 };
            charged = m.day;
          }
          p = { ...p, stored, storedSha: await sha256(stored), receipt, day: charged };
          writes.pending = p;
          await this.storage.put(writes);
        }
        await this.bucket.put(p.key, p.stored, { customMetadata: { sha256: p.storedSha }, httpMetadata: { contentType: "application/json" } });
      }
    } catch {
      return "the records bucket did not take the write; it will be retried";
    }
    await this.storage.delete("pending");
    return undefined;
  }
}
