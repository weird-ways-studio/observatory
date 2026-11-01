// The recorder's own check of the edge login (card feea07eb, route A; door 2 of
// instruction.app-exposure-doors). Cloudflare Access stands in front of the recorder's address and
// adds a signed token to every request it lets through. This file checks that token again here, so
// a wrong Access setting alone never opens the recorder: the signature (Access's published keys),
// the issuer (our team), the audience (this one Access app), the expiry, and who it is -- the front
// desk's service token, or Ben. Anything missing, including this Worker's own settings, is refused.
// Built on WebCrypto, which the Workers runtime provides; no library.

export interface AccessEnv {
  ACCESS_TEAM?: string; // the team's Access host, e.g. "<team>.cloudflareaccess.com"
  ACCESS_AUD?: string; // the Access app's audience tag
  ACCESS_SERVICE_ID?: string; // the front desk's service token Client ID (not its secret)
  ACCESS_BEN_EMAIL?: string; // Ben's login email at the edge
}
export type Who = "service" | "ben";
export type Admission = { ok: true; who: Who } | { ok: false; status: 401 | 403 | 503; why: string };

const CERTS_TTL_MS = 3_600_000;
let certs: { team: string; at: number; keys: Map<string, CryptoKey> } | undefined;
/** For tests: forget cached keys. */
export const resetCerts = () => { certs = undefined; };

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

/** Access's public signing keys for the team, cached for an hour; refetched once for an unknown key id. */
async function keyFor(team: string, kid: string, fetchFn: (req: Request) => Promise<Response>, now: number): Promise<CryptoKey | undefined> {
  const fresh = certs && certs.team === team && now - certs.at < CERTS_TTL_MS;
  if (fresh && certs!.keys.has(kid)) return certs!.keys.get(kid);
  if (fresh && now - certs!.at < 300_000) return undefined; // just fetched: an unknown key stays unknown for 5 minutes
  const res = await fetchFn(new Request(`https://${team}/cdn-cgi/access/certs`));
  if (!res.ok) throw new Error("certs unavailable");
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  certs = { team, at: now, keys };
  return keys.get(kid);
}

/** Who sent this request (the front desk or Ben), or why it is refused. */
export async function admit(req: Request, env: AccessEnv, fetchFn: (req: Request) => Promise<Response>, now: Date): Promise<Admission> {
  const team = env.ACCESS_TEAM?.trim(), aud = env.ACCESS_AUD?.trim(), service = env.ACCESS_SERVICE_ID?.trim(), ben = env.ACCESS_BEN_EMAIL?.trim().toLowerCase();
  if (!team || !aud || !service || !ben) return { ok: false, status: 503, why: "the recorder's edge-login settings are not set" };
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, why: "no edge-login token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, why: "malformed token" };
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    header = json(parts[0]);
    claims = json(parts[1]);
  } catch {
    return { ok: false, status: 401, why: "malformed token" };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, status: 401, why: "unexpected token algorithm" };
  let key: CryptoKey | undefined;
  try {
    key = await keyFor(team, header.kid, fetchFn, now.getTime());
  } catch {
    return { ok: false, status: 503, why: "Access's signing keys could not be read" };
  }
  if (!key) return { ok: false, status: 401, why: "token signed by an unknown key" };
  let good = false;
  try {
    good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { /* a malformed signature is a bad signature */ }
  if (!good) return { ok: false, status: 401, why: "bad token signature" };

  const sec = now.getTime() / 1000;
  if (claims.iss !== `https://${team}`) return { ok: false, status: 401, why: "token from another issuer" };
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return { ok: false, status: 401, why: "token for another app" };
  if (typeof claims.exp !== "number" || claims.exp <= sec) return { ok: false, status: 401, why: "token expired or without expiry" };
  if (typeof claims.nbf === "number" && claims.nbf > sec + 60) return { ok: false, status: 401, why: "token not valid yet" };
  // A service token's identity is its Client ID (common_name); a person's is their email.
  if (claims.common_name === service) return { ok: true, who: "service" };
  if (typeof claims.email === "string" && claims.email.toLowerCase() === ben) return { ok: true, who: "ben" };
  return { ok: false, status: 403, why: "not the front desk and not Ben" };
}
