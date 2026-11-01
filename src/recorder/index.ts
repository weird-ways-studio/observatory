// The recorder Worker (card feea07eb, route A): a separate Worker from the Observatory's backup
// Worker (src/index.ts), deployed from wrangler.recorder.jsonc. It has one address, behind the edge
// login, and reaches only the records bucket and its own Durable Object -- never the backups.
// Cloudflare calls `fetch` for each request (routed in http.ts). Every write goes to one Durable
// Object instance, named "v1", whose Ledger (ledger.ts) takes records one at a time.
import { DurableObject } from "cloudflare:workers";
import type { AccessEnv } from "./access.ts";
import { handle } from "./http.ts";
import { Ledger, type Storage } from "./ledger.ts";

export interface RecorderEnv extends AccessEnv {
  RECORDS: R2Bucket;
  LEDGER: DurableObjectNamespace<Recorder>;
}

/** The one Durable Object instance ("v1") that holds the Ledger; the Worker calls it over RPC. */
export class Recorder extends DurableObject<RecorderEnv> {
  #ledger = new Ledger(this.ctx.storage as unknown as Storage, this.env.RECORDS);
  accept(body: string) { return this.#ledger.accept(body); }
  status() { return this.#ledger.status(new Date()); }
}

export default {
  async fetch(req, env): Promise<Response> {
    return handle(req, env, () => env.LEDGER.get(env.LEDGER.idFromName("v1")), (r) => fetch(r), new Date());
  },
} satisfies ExportedHandler<RecorderEnv>;
