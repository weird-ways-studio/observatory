// The Observatory Worker. Cloudflare calls the default export (`main` in wrangler.jsonc):
// `scheduled` on the cron in wrangler.jsonc (phase 2c nightly backup copy, src/copy.ts), and
// `fetch` only if an address is ever added by mistake -- it has none.
import { runNight, type Env } from "./copy.ts";

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
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runNight(env, { fetch: (req) => fetch(req), sized }, new Date()));
  },
} satisfies ExportedHandler<Env>;
