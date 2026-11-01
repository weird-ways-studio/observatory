# Records contract v1 (phase 2a, card feea07eb)

The front desk (the broker) records each grant here **before** it acts. The Observatory reads
these records every hour (`src/records.ts`) and alerts Ben on anything outside this contract.

## Where

Bucket `observatory-records` in the Observatory's Cloudflare account. No address: the broker
writes with the S3 API using a key scoped to this one bucket, which Ben makes. A lock rule on
`records/` (at least 400 days) makes the bucket add-only: Cloudflare refuses any overwrite or
delete of a locked object and still allows new ones.

## Keys

    records/v1/<YYYY-MM-DD>/<grant id>/<stage>.json

- `<YYYY-MM-DD>`: the UTC date of the record's `at`.
- `<grant id>`: the front desk's grant id, 8-64 of `A-Z a-z 0-9 _ -`.
- `<stage>`: `request`, `verdict`, `approval` or `result`.

Nothing else may exist in the bucket.

## Body

JSON object, at most 8192 bytes:

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | `1` |
| `grant` | yes | same as the key |
| `stage` | yes | same as the key |
| `at` | yes | UTC ISO time the broker wrote it, e.g. `2026-11-01T12:30:00Z` (milliseconds optional); within 10 minutes of when R2 stored it |
| `job` | yes | the job name, e.g. `cf.token.canary` (`a-z 0-9 . -`, up to 40) |
| anything else | no | e.g. `params`, `requester`, `hash`, `outcome` |

No secret values, ever, and no field whose name contains `secret`, `password`, `token`,
`private` or `credential` (the Observatory flags those names).

## Order

R2's own upload time decides order; the writer cannot set it.

- `approval` needs an earlier `request`.
- `verdict` (the overseer's) needs an earlier `request`.
- `result` needs an earlier `request` **and** an earlier `approval`. A result without a request
  is reported as "something ran unrecorded".

## The broker's side (phase 3)

- Write with `If-None-Match: *`. Success is the receipt; **no receipt, no run**.
- A refused write (already exists, or `ObjectLockedByBucketPolicy`) is never retried under a new
  key for the same grant and stage.
- Stop taking jobs when today's folder holds 400 records (the cap the Observatory alerts on).

## What the Observatory checks every hour

Today's and yesterday's folders: each key, size, body and time; the order above; at most 400 records
a day; anything outside `records/v1/`; any day folder that is not a real date or is in the future;
and the lock on `records/` (once `LOCK_READ_TOKEN` exists). Once a day (04:30 UTC) it also sweeps
every record and flags any stored on a day other than its folder's (filed into an old day after the
fact). Alerts show the worst findings first and never repeat writer-chosen text raw (field names
are counted, times re-printed, names cleaned); a finding counts as told only if it fit in the alert,
the rest follow the next hour. Each finding alerts once; again only if it clears and comes back.
Until Ben sets `PING_URL_RECORDS`, it only logs.
