// Phase 2b (card 9a6ed286): the Watch's voice. One alert goes to Ben's phone through Pushover;
// if Pushover does not take it, the same text goes to the healthchecks check as a failure, which
// emails him. It only tells; it never acts.

export interface AlertEnv {
  PING_URL: string;
  PUSHOVER_TOKEN?: string; // the Observatory's own Pushover application; Ben pasted it, no agent has seen it
  PUSHOVER_USER?: string; // Ben's Pushover user key
}

const PUSHOVER_API = "https://api.pushover.net/1/messages.json";
const KEY = /^[A-Za-z0-9]{30}$/; // Pushover tokens and user keys: 30 letters and digits

/** The text with every secret value (and the host of any URL-valued one) replaced by [redacted]. */
export function redact(text: string, env: object): string {
  const values = new Set<string>();
  for (const v of Object.values(env)) {
    if (typeof v !== "string" || v.length < 4) continue;
    values.add(v);
    try { values.add(new URL(v).hostname); } catch { /* not a URL */ }
  }
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join("[redacted]");
  return out;
}

/** Sends one alert: Pushover first, else healthchecks /fail. Returns the channel that took it. */
export async function alert(env: AlertEnv, fetchFn: (req: Request) => Promise<Response>, title: string, text: string): Promise<"pushover" | "healthchecks" | "none"> {
  const message = redact(text, env).slice(0, 1024) || "(no detail)";
  const token = env.PUSHOVER_TOKEN?.trim(), user = env.PUSHOVER_USER?.trim();
  let pushover = "not configured";
  if (token && user && KEY.test(token) && KEY.test(user)) {
    // A thrown fetch error is reduced to fixed words: its message could carry a key.
    const status = await fetchFn(new Request(PUSHOVER_API, { method: "POST", body: new URLSearchParams({ token, user, title: title.slice(0, 250), message }) }))
      .then((r) => r.status, () => 0);
    pushover = status ? `answered ${status}` : "unreachable";
    if (status === 200) {
      console.log(JSON.stringify({ alert: title, via: "pushover", status }));
      return "pushover";
    }
  }
  const fallback = await fetchFn(new Request(`${env.PING_URL}/fail`, { method: "POST", body: `${title}\n${message}\n(Pushover ${pushover})` }))
    .then((r) => r.status, () => 0);
  console.log(JSON.stringify({ alert: title, via: "healthchecks", pushover, status: fallback }));
  return fallback >= 200 && fallback < 300 ? "healthchecks" : "none";
}

// Written once Pushover has delivered the test, so the delivery test runs on the first night with
// the Pushover secrets in place and again only if it did not get through. Not under a locked prefix.
export const TEST_MARKER = "state/alert-delivery-tested";

/** The day-one delivery test: the fallback path once, then Pushover; skipped when not configured or already proven. */
export async function deliveryTest(env: AlertEnv, fetchFn: (req: Request) => Promise<Response>, bucket: Pick<R2Bucket, "head" | "put">, now: Date) {
  if (!env.PUSHOVER_TOKEN || !env.PUSHOVER_USER || (await bucket.head(TEST_MARKER))) return undefined;
  const fallback = await alert({ PING_URL: env.PING_URL }, fetchFn, "Observatory test (fallback)", "Pushover deliberately skipped: this email proves the fallback. Tonight's run sends the real status next.");
  const pushover = await alert(env, fetchFn, "Observatory test", "Alerts reach your phone. You will hear from the Observatory again only when something fails.");
  if (pushover === "pushover") await bucket.put(TEST_MARKER, now.toISOString());
  return { fallback, pushover };
}
