// Card f0d4e2fc (design DESIGN-watch-home 3f): a refused delete cannot tell a 1-hour lock from a
// 30-day one. So each night the copy job also reads this account's own lock rules for the copy
// bucket and fails the night if `daily/` is held for less than 30 days (D2, Ben 2026-10-31).

export interface LockEnv {
  LOCK_READ_TOKEN?: string; // read-only key for this account's R2 settings; Ben creates it at cutover
  LOCK_ACCOUNT_ID?: string; // a secret too: account ids stay out of this public repo
}

export const COPY_BUCKET = "observatory-backups"; // the COPY binding's bucket (wrangler.jsonc)
export const LOCKED_PREFIX = "daily/";
export const MIN_LOCK_SECONDS = 30 * 86_400; // D2

// The lock-rule shape Cloudflare returns (read live 2026-10-31 on this bucket).
type Condition = { type: "Age"; maxAgeSeconds: number } | { type: "Date"; date: string } | { type: "Indefinite" };
interface Rule { enabled: boolean; prefix?: string; condition: Condition }

// "not set up": no key yet, so nothing is claimed and the night is not failed (like fresh.ts).
export type LockLength = { verdict: "ok" | "not set up" } | { verdict: "short" | "unverified"; reason: string };

/** Seconds a rule holds an object written at `now`; NaN when the condition is not understood. */
function holds(c: Condition, now: Date): number {
  if (c?.type === "Indefinite") return Infinity;
  if (c?.type === "Age") return typeof c.maxAgeSeconds === "number" ? c.maxAgeSeconds : NaN;
  if (c?.type === "Date") return (Date.parse(c.date) - now.getTime()) / 1000;
  return NaN;
}

/** OK only if an enabled rule covers all of `daily/` for 30 days and no enabled rule there is shorter. */
export function judgeRules(rules: Rule[], now: Date): LockLength {
  const days = (s: number) => `${Math.floor(s / 86_400)} days`;
  let covered = false;
  for (const r of rules.filter((x) => x.enabled)) {
    const prefix = r.prefix ?? "";
    const coversAll = LOCKED_PREFIX.startsWith(prefix);
    if (!coversAll && !prefix.startsWith(LOCKED_PREFIX)) continue; // another prefix, e.g. canary/
    const s = holds(r.condition, now);
    if (Number.isNaN(s)) return { verdict: "unverified", reason: `lock rule on "${prefix}" has an unknown condition` };
    if (s < MIN_LOCK_SECONDS) return { verdict: "short", reason: `lock rule on "${prefix}" holds ${days(s)}, under ${days(MIN_LOCK_SECONDS)}` };
    if (coversAll) covered = true;
  }
  return covered ? { verdict: "ok" } : { verdict: "short", reason: `no enabled lock rule covers ${LOCKED_PREFIX}` };
}

/** Reads the copy bucket's lock rules with the read-only key and judges them. */
export async function readLockLength(env: LockEnv, fetchFn: (req: Request) => Promise<Response>, now: Date): Promise<LockLength> {
  const token = env.LOCK_READ_TOKEN?.trim(), account = env.LOCK_ACCOUNT_ID?.trim();
  if (!token || !account) return { verdict: "not set up" };
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${COPY_BUCKET}/lock`;
  try {
    const res = await fetchFn(new Request(url, { headers: { Authorization: `Bearer ${token}` } }));
    if (!res.ok) return { verdict: "unverified", reason: `reading the lock rules answered ${res.status}` };
    const body = (await res.json()) as { success?: boolean; result?: { rules?: unknown } };
    const rules = body?.result?.rules;
    if (body?.success !== true || !Array.isArray(rules)) return { verdict: "unverified", reason: "the lock rules answer was not understood" };
    return judgeRules(rules as Rule[], now);
  } catch {
    // Fixed words: a thrown fetch error could quote the URL, which holds the account id.
    return { verdict: "unverified", reason: "the lock rules could not be read" };
  }
}
