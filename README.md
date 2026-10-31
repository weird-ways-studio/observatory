# Observatory

The studio's independent check on its agents. It will record every request agents make through the Front Desk before it runs, read what the providers say changed, and alert Ben on anything that does not match. Only code Ben approved ever runs here.

Today it does two jobs: a second, locked copy of the studio's nightly backups (phase 2c), and an hourly check that what runs here is what is on `main` (card f0d4e2fc).

## Nightly backup copy (phase 2c, card 202ac367)

At 11:00 UTC (`triggers` in `wrangler.jsonc`), `src/copy.ts` runs:

1. Lists that night's backup objects in the main backup bucket, with a read-only key scoped to that one bucket. The objects are encrypted before upload, so the Observatory cannot read them.
2. Copies each one into this account's own bucket. R2 refuses a copy whose bytes do not hash to the source's MD5, and the Worker checks the result again. A source object without a plain MD5 fails the night rather than go unchecked.
3. Tries to delete a permanently locked canary object. If it is ever gone, the lock is not working and the night fails.
4. Pings the dead-man check "up" only if every step passed; otherwise it reports a failure, so Ben gets an email. A missed night also emails him.

The copy bucket's lock rules keep each night for 3 days (the canary forever); a lifecycle rule then removes it. Lock rules win over lifecycle rules, and the Worker's own code cannot delete a locked object. One log line per night records counts, bytes, total stored bytes and the canary result.

## Hourly freshness check (card f0d4e2fc)

At :30 past every hour, `src/fresh.ts` (and only it: `src/index.ts` routes each cron by name) reads `main`'s head commit from GitHub's public API by the repo's numeric id (it survives the move to a new org), without a credential, and compares it with `DEPLOYED_SHA`, which the deploy command records for each deploy.

- `main` ahead of what is live for 6 hours: one alert ("a merge did not go live").
- GitHub unreadable for 3 hours (including its 60-an-hour limit on reads without a key), or no `DEPLOYED_SHA`, or its own state unreadable: one alert ("cannot verify what is live"). Never "healthy".
- Its own healthchecks check (`PING_URL_FRESH`) hears "up" every hour while nothing is overdue and `/fail` every hour while something is. An alert that cannot reach the phone falls back to that check, never the backup check, so a good backup night never clears a freshness failure.
- State (when a mismatch was first seen, which alert was sent) lives at `state/freshness.json` in the copy bucket; `state/` has no lock.
- Until `PING_URL_FRESH` and the `DEPLOYED_SHA` deploy command are set up at cutover, it logs one line an hour and sends nothing.

Limit: it runs inside the thing it checks. That counts only after cutover, when nothing but Workers Builds can deploy.

## How it is protected

- **Who can change it:** `main` takes only pull requests with Ben's approval of the latest push (ruleset `protect-main`, the same as front-desk's): no bypass, no force push, no deletion.
- **What deploys:** Cloudflare **Workers Builds** in the Observatory's own Cloudflare account builds `main` and deploys it; its trigger includes only `main`, because a branch build would run code nobody reviewed with the build's deploy rights. **Known gap (2026-10-31):** a merge does not yet start a build by itself -- every build so far was started by hand (dashboard retry or the Builds API), always from `main`. Root-cause card c19f4946.
- **Who holds keys:** no agent holds any Observatory credential, except two temporary keys Ben approved for phase 2c setup (one for R2 and Workers scripts, one for reading and starting builds), both expiring 2026-11-13. Agents change the code only by opening pull requests.
- **Address (studio app-exposure doors):** none. `wrangler.jsonc` turns off workers.dev and preview URLs and has no routes, so the Worker is unreachable from any network, which is stricter than the tailnet-only door. Endpoints added in later phases go behind an edge login (door 2). `test/config.test.ts` fails if the address, bindings or schedules change.
- **Entry point:** `src/index.ts` (`main` in `wrangler.jsonc`); Cloudflare calls its default export's `scheduled` on each cron and `fetch` only if an address were ever added.

## Known limits

- Until the studio's temporary access ends on 2026-11-13 (revocation plan, epic cafd3acc), agents hold keys that can edit org rulesets, the main backup bucket's settings, and this account. So neither this protection nor the backup copy is independent of the agents yet; independence is claimed only after those keys are proven refused.
- The copy faithfully copies whatever the source holds. If tonight's source were overwritten with garbage, earlier nights stay locked here for 3 days; spotting the tampering is a later phase.
- Cloudflare's own GitHub app (Workers and Pages) holds administration write on the repos it is installed on. Cloudflare controls it; no studio agent can drive it.

## Develop

`npm test`, `npm run typecheck`. Install packages only inside the studio sandbox.
