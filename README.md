# Observatory

The studio's independent check on its agents. It will record every request agents make through the Front Desk before it runs, read what the providers say changed, and alert Ben on anything that does not match. Only code Ben approved ever runs here.

Phase 1 (this repo today) is only the protected home: an empty Worker that answers nothing.

## How it is protected

- **Who can change it:** `main` takes only pull requests with Ben's approval of the latest push (ruleset `protect-main`, the same as front-desk's): no bypass, no force push, no deletion.
- **What deploys:** Cloudflare **Workers Builds** in the Observatory's own Cloudflare account watches `main` and deploys it. Builds for any other branch are **off**, because a branch build would run code nobody reviewed with the build's deploy rights.
- **Who holds keys:** no agent holds any Observatory credential, at any phase. Agents change it only by opening pull requests.
- **Address (studio app-exposure doors):** none. `wrangler.jsonc` turns off workers.dev and preview URLs and has no routes, so the Worker is unreachable from any network, which is stricter than the tailnet-only door. Endpoints added in later phases go behind an edge login (door 2). `test/config.test.ts` fails if the address or bindings change.
- **Entry point:** `src/index.ts` (`main` in `wrangler.jsonc`); Cloudflare calls its default export's `fetch`.

## Known limits

- Until the studio's temporary admin access ends (revocation plan, epic cafd3acc), a key that can edit org rulesets exists on the agents' machine, so this protection is not yet independent of the agents. The ruleset is recorded and re-checked; independence is claimed only after that key is proven refused.
- Cloudflare's own GitHub app (Workers and Pages) holds administration write on the repos it is installed on. Cloudflare controls it; no studio agent can drive it.

## Develop

`npm test`, `npm run typecheck`. Install packages only inside the studio sandbox.
