// Phase 2c (card 202ac367): each night, copy that night's studio backups into this account's
// own locked bucket, verify every copy, and tell the dead-man check only when all of it worked.
// The Observatory never sees backup contents: the objects are age-encrypted before upload.
import { AwsClient } from "aws4fetch";

export interface Env {
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
// The c-box names each night's folder by its own local date (backup_engine.py).
const BACKUP_TIME_ZONE = "America/Chicago";

export function backupDate(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BACKUP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

const unescapeXml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

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

const hex = (buf: ArrayBuffer | undefined) => (buf ? [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("") : "");

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
  try {
    if (!(await env.COPY.head(CANARY_KEY))) await env.COPY.put(CANARY_KEY, "locked forever; deleting it must fail");
    await env.COPY.delete(CANARY_KEY).catch(() => undefined); // a refusal is the expected outcome
    if (!(await env.COPY.head(CANARY_KEY))) {
      canary = "DELETED";
      failures.push("the locked canary was deleted: the bucket lock is not working");
    }
  } catch (e) {
    canary = "error";
    failures.push(`canary check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let storedBytes = 0, cursor: string | undefined;
  do {
    const page = await env.COPY.list({ cursor });
    for (const obj of page.objects) storedBytes += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const report = { date, ok: failures.length === 0, objects: night.length, copied, skipped, bytes, storedBytes, canary, failures };
  console.log(JSON.stringify(report));
  // Only a fully verified night pings "up"; anything else reports a failure, so Ben gets the email.
  await deps.fetch(new Request(report.ok ? env.PING_URL : `${env.PING_URL}/fail`, { method: "POST", body: JSON.stringify(report) }));
  return report;
}
