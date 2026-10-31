// Card f0d4e2fc (design DESIGN-watch-home 3e): every hour, check that what runs here is what is on
// main. A merge that never went live is caught within about 7 hours. This job has its own cron,
// its own state file and its own healthchecks check, so the nightly backup can never clear it.
import { alert, redact, type AlertEnv } from "./alert.ts";

export interface FreshEnv extends AlertEnv {
  COPY: Pick<R2Bucket, "get" | "put">;
  DEPLOYED_SHA?: string; // set by the deploy command: --var DEPLOYED_SHA:$WORKERS_CI_COMMIT_SHA
  PING_URL_FRESH?: string; // this job's own healthchecks check; Ben creates it after cutover
}

export const FRESH_CRON = "30 * * * *";
// Public repo, read without a credential. After the move to its own org GitHub redirects this path.
export const REPO = "weird-ways-studio/observatory";
export const STATE_KEY = "state/freshness.json"; // state/ has no lock
const HOUR = 3_600_000;
export const NOT_LIVE_AFTER = 6 * HOUR;
export const UNREADABLE_AFTER = 3 * HOUR;
const SHA = /^[0-9a-f]{40}$/;

export interface State {
  mismatchSince?: string; // first hour main was seen ahead of DEPLOYED_SHA
  unreadableSince?: string; // first hour GitHub could not be read
  alerted?: Verdict; // the bad verdict Ben has already been told about
}
// waiting = something is off but still inside its grace window.
export type Verdict = "healthy" | "waiting" | "not-live" | "unverified";
export type Main = { sha: string } | { error: string };

/** main's head commit from the public GitHub API. Any failure, a rate limit included, is an error. */
export async function readMain(fetchFn: (req: Request) => Promise<Response>): Promise<Main> {
  const req = new Request(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { Accept: "application/vnd.github.sha", "User-Agent": "observatory-freshness" },
  });
  try {
    const res = await fetchFn(req);
    if (!res.ok) {
      const limited = res.headers.get("x-ratelimit-remaining") === "0" ? ", rate limited" : "";
      return { error: `GitHub answered ${res.status}${limited}` };
    }
    const sha = (await res.text()).trim();
    return SHA.test(sha) ? { sha } : { error: "GitHub did not return a commit" };
  } catch {
    return { error: "GitHub unreachable" };
  }
}

/** Whole hours from `iso` to `now`, as "3h". */
const since = (iso: string, now: Date) => `${Math.floor((now.getTime() - Date.parse(iso)) / HOUR)}h`;

/** The verdict for this hour and the state to keep. Only a matching read is ever healthy. */
export function judge(prev: State, deployed: string | undefined, main: Main, now: Date): { verdict: Verdict; state: State; reason: string } {
  const state: State = { ...prev };
  if (!deployed || !SHA.test(deployed)) {
    return { verdict: "unverified", state, reason: "DEPLOYED_SHA is not set, so nothing records which commit went live" };
  }
  if ("error" in main) {
    state.unreadableSince ??= now.toISOString();
    const over = now.getTime() - Date.parse(state.unreadableSince) >= UNREADABLE_AFTER;
    return { verdict: over ? "unverified" : "waiting", state, reason: `${main.error} (unreadable for ${since(state.unreadableSince, now)})` };
  }
  delete state.unreadableSince;
  if (main.sha === deployed) {
    delete state.mismatchSince;
    return { verdict: "healthy", state, reason: `live is main (${deployed.slice(0, 7)})` };
  }
  state.mismatchSince ??= now.toISOString();
  const over = now.getTime() - Date.parse(state.mismatchSince) >= NOT_LIVE_AFTER;
  return { verdict: over ? "not-live" : "waiting", state, reason: `main is ${main.sha.slice(0, 7)}, live is ${deployed.slice(0, 7)}, for ${since(state.mismatchSince, now)}` };
}

/** The verdicts that alert and send /fail. */
const isBad = (v: Verdict): v is "not-live" | "unverified" => v === "not-live" || v === "unverified";
const TITLES = { "not-live": "Observatory: a merge did not go live", unverified: "Observatory: cannot verify what is live" } as const;

/** One hour's run: read, judge, alert once per bad state, keep state, then ping this job's own check. */
export async function runFresh(env: FreshEnv, fetchFn: (req: Request) => Promise<Response>, now: Date) {
  let prev: State = {}, stateError = "";
  try {
    const saved = await env.COPY.get(STATE_KEY);
    if (saved) prev = JSON.parse(await saved.text());
  } catch {
    stateError = "freshness state could not be read";
  }
  const main = await readMain(fetchFn);
  let { verdict, state, reason } = judge(prev, env.DEPLOYED_SHA, main, now);
  if (stateError) [verdict, reason] = ["unverified", `${stateError}; ${reason}`];
  const ping = env.PING_URL_FRESH;

  // Until Ben creates this job's check, it only logs: no alert, and nothing that claims healthy.
  let via: string | undefined;
  if (ping && isBad(verdict) && state.alerted !== verdict) {
    // The fallback goes to this job's own check, never the backup check (PING_URL).
    via = await alert({ ...env, PING_URL: ping }, fetchFn, TITLES[verdict], reason);
    state.alerted = verdict;
  }
  if (!isBad(verdict)) delete state.alerted;
  try {
    await env.COPY.put(STATE_KEY, JSON.stringify(state));
  } catch {
    if (!stateError) reason = `freshness state could not be saved; ${reason}`;
    verdict = "unverified";
  }

  const report = { fresh: verdict, reason: redact(reason, env), setup: ping ? "complete" : "PING_URL_FRESH not set: log only" };
  console.log(JSON.stringify(report));
  // "Up" means the hourly job ran and nothing is overdue; a bad verdict is /fail every hour.
  // An alert that fell back to healthchecks has already sent /fail.
  if (ping && via !== "healthchecks") {
    await fetchFn(new Request(isBad(verdict) ? `${ping}/fail` : ping, { method: "POST", body: JSON.stringify(report) })).catch(() => undefined);
  }
  return report;
}
