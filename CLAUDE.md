# Observatory -- agent notes

Public repo (Ben, decision 0cd48379: "Option 1"). Epic cafd3acc, plan studio-os docs/specifications/trust-but-verify/PLAN.md. Phase 1 card 24b9395b.

- Never push to `main`; open a PR and wait for Ben. Never deploy: only Workers Builds deploys, from `main`.
- No agent ever holds an Observatory credential. If one appears anywhere an agent can read, stop and tell Ben. One exception, approved by Ben for phase 2c setup (card 202ac367): two temporary keys that expire 2026-11-13 (an account key used only for R2 and Workers script calls, and a builds key for reading build logs and starting builds of `main`).
- Public repo: no secrets, live hostnames, account or key IDs, or where any credential is stored. The pre-commit hook (studio-os hooks/observatory-pre-commit.sh) refuses identifiers on the private deny list, then runs the secret scan.
- Deploys: Workers Builds runs `npx wrangler deploy` on `main`; there is no custom build step.

## Proposing a change after cutover (card 3e2f8870)

The repo lives in the `weird-ways-observatory` org, which no agent credential can reach. Two logins, so the author is never the approver:

1. The agent pushes a branch to the fork `weird-ways-studio/observatory-proposals` and sends Ben the compare link (fork branch -> `weird-ways-observatory/observatory` `main`) with a merge recommendation.
2. Ben opens the PR from that link in Safari, signed in as `weird-ways`.
3. Ben approves and merges in the GitHub app as `benculbert`. Any push after his approval cancels it (ruleset `protect-main`), so the agent never pushes to a branch Ben has approved.

Agents have no direct route: the old `weird-ways-studio/observatory` address only redirects here, and pushes to this repo are refused.

## Release Checklist

1. [command] `npm test` passes
2. [command] `npx tsc --noEmit` passes
3. [command] `npx wrangler deploy --dry-run --outdir /tmp/obs-dist` succeeds (run inside sandbox-run)
4. [command] `python3 ~/studio/studio-os/scripts/public_repo_guard.py observatory --all` passes
5. [inspect] Every new refusal has a test shown failing with the safeguard removed.
