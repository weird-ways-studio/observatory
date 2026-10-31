# Observatory -- agent notes

Public repo (Ben, decision 0cd48379: "Option 1"). Epic cafd3acc, plan studio-os docs/specifications/trust-but-verify/PLAN.md. Phase 1 card 24b9395b.

- Never push to `main`; open a PR and wait for Ben. Never deploy: only Workers Builds deploys, from `main`.
- No agent ever holds an Observatory credential. If one appears anywhere an agent can read, stop and tell Ben.
- Public repo: no secrets, live hostnames, account or key IDs, or where any credential is stored. The pre-commit hook (studio-os hooks/observatory-pre-commit.sh) refuses identifiers on the private deny list, then runs the secret scan.
- Deploys: Workers Builds runs `npx wrangler deploy` on `main`; there is no custom build step.

## Release Checklist

1. [command] `npm test` passes
2. [command] `npx tsc --noEmit` passes
3. [command] `npx wrangler deploy --dry-run --outdir /tmp/obs-dist` succeeds (run inside sandbox-run)
4. [command] `python3 ~/studio/studio-os/scripts/public_repo_guard.py observatory --all` passes
5. [inspect] Every new refusal has a test shown failing with the safeguard removed.
