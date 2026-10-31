// The Observatory Worker (phase 1: empty). Cloudflare calls the default export's `fetch`
// (`main` in wrangler.jsonc). It has no address yet, so this only answers if one is added by mistake.
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
