// The Observatory Worker. Cloudflare calls the default export (`main` in wrangler.jsonc):
// `scheduled` on each cron in wrangler.jsonc, routed here by `controller.cron` and nowhere else:
// the nightly one runs the phase 2c backup copy (src/copy.ts) after the one-time alert delivery
// test of phase 2b (src/alert.ts); the hourly one runs only the freshness check (src/fresh.ts); and
// `fetch` only if an address is ever added by mistake -- it has none.
import { runNight, type Env } from "./copy.ts";
import { deliveryTest } from "./alert.ts";
import { FRESH_CRON, runFresh, type FreshEnv } from "./fresh.ts";

export const NIGHT_CRON = "50 3 * * *";

/** Wraps a body of known size so R2 accepts it as a stream (R2 needs the length up front). */
function sized(body: ReadableStream, size: number): ReadableStream {
  const { readable, writable } = new FixedLengthStream(size);
  body.pipeTo(writable).catch(() => undefined); // a broken pipe surfaces as the put's error
  return readable;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller, env, ctx): Promise<void> {
    const send = (req: Request) => fetch(req);
    const now = new Date();
    // Separate jobs: a failure in one never skips or clears the other.
    if (controller.cron === FRESH_CRON) return ctx.waitUntil(runFresh(env, send, now));
    if (controller.cron !== NIGHT_CRON) return console.log(JSON.stringify({ unknownCron: controller.cron }));
    ctx.waitUntil((async () => {
      // A broken test must never stop the night's copy.
      const tested = await deliveryTest(env, send, env.COPY, now).catch(() => ({ error: "delivery test threw" }));
      if (tested) console.log(JSON.stringify({ deliveryTest: tested }));
      await runNight(env, { fetch: send, sized }, now);
    })());
  },
} satisfies ExportedHandler<Env & FreshEnv>;
