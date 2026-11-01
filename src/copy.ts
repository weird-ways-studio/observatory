// Phase 2c (card 202ac367): each night, copy that night's studio backups into this account's
// own locked bucket, verify every copy, and tell the dead-man check only when all of it worked.
// The Observatory never sees backup contents: the objects are age-encrypted before upload.
import { AwsClient } from "aws4fetch";
import { alert, redact, type AlertEnv } from "./alert.ts";
import { readLockLength, type LockEnv } from "./lock.ts";

export interface Env extends AlertEnv, LockEnv {
  COPY: R2Bucket;
  SOURCE_ACCESS_KEY_ID: string; // read-only key, scoped to the source bucket
  SOURCE_SECRET_ACCESS_KEY: string;
  SOURCE_ENDPOINT: string; // the source account's R2 S3 endpoint (a secret: account ids stay out of this public repo)
  SOURCE_BUCKET: string;
  PING_URL: string; // healthchecks.io check; Ben pasted it, no agent has seen it
}

export interface Deps {
  fetch: (req: Request) => Promise<Response>;
  // R2 needs a stream of known length; production wraps the body in a FixedLengthStream.
  sized: (body: ReadableStream, size: number) => ReadableStream;
}

export interface Listed {
  key: string;
  size: number;
  etag: string;
}

// A permanently locked object. Each night the Worker tries to delete it; if it is ever gone,
// the lock is gone too, and the night fails.
export const CANARY_KEY = "canary/do-not-delete";
// R2's own answer when a bucket lock refuses a delete, as the live night logged it (canaryDelete,
// 2026-11-01 03:15 UTC). Only this answer proves the lock; any other error proves nothing (card f0d4e2fc).
export const LOCK_REFUSAL = /: The object is locked by the bucket policy\. \(10069\)$/;
// The c-box names each night's folder by its own local date (backup_engine.py).
const BACKUP_TIME_ZONE = "America/Chicago";

/** The YYYY-MM-DD folder name the c-box gives the backup made on the night of `now`. */
export function backupDate(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BACKUP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

const unescapeXml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** One page of an S3 ListObjectsV2 reply: its objects, and the token for the next page if any. */
export function parseListing(xml: string): { objects: Listed[]; next?: string } {
  const objects: Listed[] = [];
  for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const field = (name: string) => unescapeXml(body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
    objects.push({ key: field("Key"), size: Number(field("Size")), etag: field("ETag") });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
  return { objects, next: truncated && next ? unescapeXml(next) : undefined };
}

// A plain ETag is the object's MD5. A multipart ETag ("...-N") is not, so the copy could not be
// checked byte for byte: refuse it rather than claim a verification that did not happen.
export function md5FromEtag(etag: string): string {
  const md5 = etag.replace(/"/g, "");
  if (!/^[0-9a-f]{32}$/.test(md5)) throw new Error(`source ETag is not a plain MD5 (${md5})`);
  return md5;
}

/** An R2 checksum as lowercase hex ("" when R2 has none), comparable with an ETag MD5. */
const hex = (buf: ArrayBuffer | undefined) => (buf ? [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("") : "");

/** One night's run: copy and verify, check the canary, log one line, then ping up or /fail. */
export async function runNight(env: Env, deps: Deps, now: Date) {
  const date = backupDate(now);
  const failures: string[] = [];
  let copied = 0, skipped = 0, bytes = 0;
  const aws = new AwsClient({ accessKeyId: env.SOURCE_ACCESS_KEY_ID, secretAccessKey: env.SOURCE_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const base = `${env.SOURCE_ENDPOINT}/${env.SOURCE_BUCKET}`;
  const source = async (url: string) => deps.fetch(await aws.sign(url));

  const listed: Listed[] = [];
  try {
    let token: string | undefined;
    do {
      const url = `${base}?list-type=2&prefix=daily/${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
      const res = await source(url);
      if (!res.ok) throw new Error(`listing the source failed: HTTP ${res.status}`);
      const page = parseListing(await res.text());
      listed.push(...page.objects);
      token = page.next;
    } while (token);
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
  }

  const night = listed.filter((o) => new RegExp(`^daily/[^/]+/${date}/[^/]+$`).test(o.key));
  if (failures.length === 0 && night.length === 0) failures.push(`no source objects for ${date}`);

  for (const o of night) {
    try {
      const md5 = md5FromEtag(o.etag);
      const have = await env.COPY.head(o.key);
      if (have && have.size === o.size && hex(have.checksums.md5) === md5) {
        skipped++;
        continue;
      }
      const res = await source(`${base}/${o.key.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok || !res.body) throw new Error(`source read failed: HTTP ${res.status}`);
      // R2 refuses the put if the bytes it receives do not hash to md5.
      const put = await env.COPY.put(o.key, deps.sized(res.body, o.size), { md5 });
      if (put.size !== o.size || hex(put.checksums.md5) !== md5) throw new Error("copy does not match the source");
      copied++;
      bytes += o.size;
    } catch (e) {
      failures.push(`${o.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let canary = "refused";
  // What the delete answered, word for word, logged so a change in R2's answer is visible.
  let canaryDelete = "not tried";
  try {
    if (!(await env.COPY.head(CANARY_KEY))) await env.COPY.put(CANARY_KEY, "locked forever; deleting it must fail");
    canaryDelete = await env.COPY.delete(CANARY_KEY).then(() => "resolved", (e: unknown) =>
      `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`.slice(0, 300)); // a refusal is the expected outcome
    if (!(await env.COPY.head(CANARY_KEY))) {
      canary = "DELETED";
      failures.push("the locked canary was deleted: the bucket lock is not working");
    } else if (!LOCK_REFUSAL.test(canaryDelete)) {
      // Still there, but not because the lock said no (an outage, or a delete that lands later).
      canary = "unverified";
      failures.push("the canary delete was not refused by the lock, so the lock is unproven tonight");
    }
  } catch (e) {
    canary = "error";
    failures.push(`canary check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A refused delete proves a lock exists, not how long it holds (src/lock.ts).
  const lock = await readLockLength(env, deps.fetch, now);
  if ("reason" in lock) failures.push(`lock length ${lock.verdict}: ${lock.reason}`);

  let storedBytes = 0, cursor: string | undefined;
  do {
    const page = await env.COPY.list({ cursor });
    for (const obj of page.objects) storedBytes += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Error text can quote a URL or key; nothing secret goes on to the log, the phone or healthchecks.
  const report = { date, ok: failures.length === 0, objects: night.length, copied, skipped, bytes, storedBytes, canary, canaryDelete: redact(canaryDelete, env), lockLength: lock.verdict, failures: failures.map((f) => redact(f, env)) };
  console.log(JSON.stringify(report));
  // Only a fully verified night pings "up". A failed night sends one alert (phone, else healthchecks
  // /fail), and healthchecks hears /fail either way so the dead-man check stays true.
  const via = report.ok ? undefined : await alert(env, deps.fetch, `Observatory: backup copy failed (${date})`,
    `${report.failures.length} problem(s), ${copied} copied, ${skipped} already there, canary ${canary}.\n${report.failures.join("\n")}`);
  if (via !== "healthchecks") await deps.fetch(new Request(report.ok ? env.PING_URL : `${env.PING_URL}/fail`, { method: "POST", body: JSON.stringify(report) }));
  return report;
}
