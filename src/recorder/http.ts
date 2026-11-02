// The recorder's address, request by request (card feea07eb, route A). Two paths, nothing else:
//   POST /v1/records  the front desk's service token only: one record in, one receipt out
//   GET  /v1/status   the front desk or Ben: today's count, whether a write is pending, and the public key the checker pins
// Every request passes the edge-login check (access.ts) before anything else runs, including
// reading the body; the body is read only up to the size limit.
import { MAX_RECORD_BYTES } from "../contract.ts";
import { admit, type AccessEnv } from "./access.ts";
import type { Outcome } from "./ledger.ts";

/** What the HTTP layer needs from the ledger, which lives in the Durable Object. */
export interface LedgerStub {
  accept(body: string): Promise<Outcome>; // the ledger reads its own clock when the record's turn comes
  status(): Promise<object>;
}

const answer = (status: number, body: object) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

/** The body as text, or undefined if it is over the limit; stops reading at the limit. */
async function bounded(req: Request): Promise<string | undefined> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_RECORD_BYTES) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RECORD_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try {
    // ignoreBOM keeps a leading byte-order mark, so the text hashed is the bytes sent (and such a
    // body then fails the JSON check instead of being silently changed).
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(all);
  } catch {
    return "\u0000not utf-8"; // fails the contract's JSON check with a fixed reason
  }
}

/** Answers one request: route, edge-login check, then status or one record write. */
export async function handle(req: Request, env: AccessEnv, ledger: () => LedgerStub, fetchFn: (req: Request) => Promise<Response>, now: Date): Promise<Response> {
  const path = new URL(req.url).pathname;
  const route = req.method === "POST" && path === "/v1/records" ? "write" : req.method === "GET" && path === "/v1/status" ? "status" : undefined;
  if (!route) return answer(404, { error: "not found" });
  const who = await admit(req, env, fetchFn, now);
  if (!who.ok) return answer(who.status, { error: who.why });
  if (route === "status") return answer(200, await ledger().status());
  if (who.who !== "service") return answer(403, { error: "only the front desk writes records" });
  const body = await bounded(req);
  if (body === undefined) return answer(413, { error: `over ${MAX_RECORD_BYTES} bytes` });
  const out = await ledger().accept(body);
  return "receipt" in out ? answer(out.status, { receipt: out.receipt }) : answer(out.status, { error: out.why });
}
