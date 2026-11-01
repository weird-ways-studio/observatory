// Records contract v1 (RECORDS.md; card feea07eb, route A). One place for the record format, used by
// both sides: the recorder (src/recorder/) refuses a record that breaks it before storing anything,
// and the hourly checker (src/records.ts) re-reads every stored record against it as a second line.

export const ROOT = "records/v1/";
export const MAX_RECORD_BYTES = 8_192; // the writer's body, in bytes as sent
export const MAX_STORED_BYTES = MAX_RECORD_BYTES * 2 + 1_024; // the stored envelope: body as a JSON string, escapes included
// Records a UTC day, counted when the recorder accepts them. A request reserves room for its grant's
// other three stages, so a flood of new requests cannot use up the room already-admitted grants need
// to finish: at most 100 grants a day. Bytes are bounded by this cap times MAX_RECORD_BYTES (3.2 MB).
export const DAY_CAP = 400;
export const STAGE_SLOTS = 4;
export const GRANT_TTL_MS = 24 * 3_600_000; // later stages of a grant are refused after this
export const SKEW_MS = 10 * 60_000; // the recorder's own time vs the time R2 stored the object
export const STAGES = ["request", "approval", "verdict", "result"] as const;
export type Stage = (typeof STAGES)[number];

export const GRANT = /^[A-Za-z0-9_-]{8,64}$/;
const JOB = /^[a-z0-9][a-z0-9.-]{0,39}$/;
const SHA = /^[0-9a-f]{64}$/;
const SECRETISH = /secret|password|token|private|credential/i;
const MAX_DEPTH = 8;
// The recorder picks every name: a sequence number with no gaps, then the grant and the stage.
// Sorting by name is sorting by the order the recorder accepted them.
export const KEY = /^records\/v1\/(\d{12})\.([A-Za-z0-9_-]{8,64})\.(request|approval|verdict|result)\.json$/;
/** The stored name for a record: sequence number first, so names sort in the order the recorder took them. */
export const keyFor = (seq: number, grant: string, stage: Stage) => `${ROOT}${String(seq).padStart(12, "0")}.${grant}.${stage}.json`;

/** What the writer sends: checked before anything is stored, and again by the hourly checker. */
export interface WriterRecord { v: 1; grant: string; stage: Stage; job: string; request?: string; [k: string]: unknown }
/** What is stored: the writer's bytes untouched, wrapped with what only the recorder decides. */
export interface Envelope { v: 1; seq: number; grant: string; stage: Stage; recorded_at: string; sha256: string; body: string }
export interface Receipt { v: 1; seq: number; key: string; grant: string; stage: Stage; sha256: string; recorded_at: string }

/** Hex SHA-256 of text (as UTF-8) or bytes, with WebCrypto. */
export async function sha256(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True if any property name, at any depth, looks like it holds a secret; deeper than MAX_DEPTH counts too. */
function secretish(v: unknown, depth = 0): boolean {
  if (!v || typeof v !== "object") return false;
  if (depth > MAX_DEPTH) return true;
  return Object.entries(v).some(([k, x]) => SECRETISH.test(k) || secretish(x, depth + 1));
}

/**
 * Checks the writer's body. Reasons are fixed words: nothing the writer chose is repeated back,
 * so a record can never smuggle text into an alert or a log.
 */
export function validate(body: string): { ok: true; record: WriterRecord } | { ok: false; why: string } {
  if (new TextEncoder().encode(body).length > MAX_RECORD_BYTES) return { ok: false, why: `over ${MAX_RECORD_BYTES} bytes` };
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(body);
  } catch {
    return { ok: false, why: "not JSON" };
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, why: "not a JSON object" };
  if (r.v !== 1) return { ok: false, why: "not version 1" };
  if (typeof r.grant !== "string" || !GRANT.test(r.grant)) return { ok: false, why: "no valid grant id" };
  if (!STAGES.includes(r.stage as Stage)) return { ok: false, why: "no valid stage" };
  if (typeof r.job !== "string" || !JOB.test(r.job)) return { ok: false, why: "no valid job name" };
  // Every later stage names the exact request it belongs to, by the hash of its bytes.
  if (r.stage === "request" ? r.request !== undefined : typeof r.request !== "string" || !SHA.test(r.request)) {
    return { ok: false, why: r.stage === "request" ? "a request must not name a request" : "no valid request hash" };
  }
  if (secretish(r)) return { ok: false, why: "a field named like a secret, or nested too deep" };
  return { ok: true, record: r as WriterRecord };
}
