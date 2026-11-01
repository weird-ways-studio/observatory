// The recorder's core (card feea07eb, route A). One instance runs inside one Durable Object
// (src/recorder/index.ts), so every write in the Observatory goes through this queue in turn.
// It decides, before anything is stored: is the record in the contract, is its stage in order for
// its grant, is there room today. Then it saves the record as pending, writes it to the locked
// bucket, and only then answers with a receipt. A crash between those steps leaves the pending
// record, which the next call finishes first -- so sequence numbers never have gaps.
import { DAY_CAP, GRANT_TTL_MS, keyFor, sha256, STAGE_SLOTS, validate, type Envelope, type Receipt, type Stage } from "../contract.ts";

/** The slice of Durable Object storage used here; each put of several keys is one atomic write. */
export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export type Bucket = Pick<R2Bucket, "head" | "put">;

interface Meta { seq: number; day: string; used: number } // `used`: today's records plus reserved slots
interface Grant { job: string; request: string; opened: number; stages: Partial<Record<Stage, Receipt>> }
interface Pending { key: string; stored: string; storedSha: string; receipt: Receipt }

export type Outcome =
  | { status: 200 | 201; receipt: Receipt }
  | { status: 400 | 409 | 410 | 429 | 503; why: string };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Admits, orders and stores records one at a time; see the file comment. */
export class Ledger {
  #queue: Promise<unknown> = Promise.resolve();
  private storage: Storage;
  private bucket: Bucket;
  constructor(storage: Storage, bucket: Bucket) {
    this.storage = storage;
    this.bucket = bucket;
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

  /** Today's slot use and whether a write is pending; nothing writer-chosen. */
  async status(now: Date) {
    const meta = await this.storage.get<Meta>("meta");
    const pending = await this.storage.get<Pending>("pending");
    const today = meta?.day === day(now.getTime());
    return { seq: meta?.seq ?? 0, used_today: today ? meta!.used : 0, cap: DAY_CAP, pending: Boolean(pending) };
  }

  /** One record's turn: finish any pending write, check, reserve, queue, store, receipt. */
  async #accept(body: string, now: Date): Promise<Outcome> {
    // An unfinished write always goes first; until it is stored nothing new is taken.
    const stuck = await this.#finishPending();
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
    let meta = (await this.storage.get<Meta>("meta")) ?? { seq: 0, day: day(t), used: 0 };
    if (meta.day !== day(t)) meta = { ...meta, day: day(t), used: 0 };

    let next: Grant;
    if (r.stage === "request") {
      if (meta.used + STAGE_SLOTS > DAY_CAP) return { status: 429, why: `today's ${DAY_CAP} record slots are taken` };
      meta = { ...meta, used: meta.used + STAGE_SLOTS };
      next = { job: r.job, request: sha, opened: t, stages: {} };
    } else {
      if (!grant) return { status: 409, why: "no request is recorded for this grant" };
      if (t - grant.opened > GRANT_TTL_MS) return { status: 410, why: "this grant's request is over 24 hours old" };
      if (r.request !== grant.request) return { status: 409, why: "the request hash does not match the recorded request" };
      if (r.job !== grant.job) return { status: 409, why: "the job does not match the recorded request" };
      if (r.stage === "result" && !grant.stages.approval) return { status: 409, why: "no approval is recorded for this grant" };
      next = grant; // its slots were reserved when the request was taken
    }

    const seq = meta.seq + 1, key = keyFor(seq, r.grant, r.stage);
    const receipt: Receipt = { v: 1, seq, key, grant: r.grant, stage: r.stage, sha256: sha, recorded_at: now.toISOString() };
    const envelope: Envelope = { v: 1, seq, grant: r.grant, stage: r.stage, recorded_at: receipt.recorded_at, sha256: sha, body };
    const stored = JSON.stringify(envelope);
    const pending: Pending = { key, stored, storedSha: await sha256(stored), receipt };
    // Counted, ordered and queued in one atomic step, before the bucket is touched.
    await this.storage.put({
      meta: { ...meta, seq },
      [`g:${r.grant}`]: { ...next, stages: { ...next.stages, [r.stage]: receipt } },
      pending,
    });
    const stuckNow = await this.#finishPending();
    if (stuckNow) return { status: 503, why: stuckNow };
    return { status: 201, receipt };
  }

  /** Stores the pending record, if any. Returns why it could not, or undefined once it is stored. */
  async #finishPending(): Promise<string | undefined> {
    const p = await this.storage.get<Pending>("pending");
    if (!p) return undefined;
    try {
      const there = await this.bucket.head(p.key);
      if (there) {
        // Stored before a crash: fine if it is ours, byte for byte. Anything else means someone
        // else wrote under the recorder's next name -- stop taking records until Ben looks.
        if (there.customMetadata?.sha256 !== p.storedSha) return "the next record's name is taken by an object the recorder did not write: Ben must look";
      } else {
        await this.bucket.put(p.key, p.stored, { customMetadata: { sha256: p.storedSha }, httpMetadata: { contentType: "application/json" } });
      }
    } catch {
      return "the records bucket did not take the write; it will be retried";
    }
    await this.storage.delete("pending");
    return undefined;
  }
}
