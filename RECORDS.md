# Records contract v1 (phase 2a, card feea07eb, route A)

The front desk records each grant here **before** it acts. It sends each record to the recorder
Worker (`src/recorder/`), which checks it, stores it add-only and answers with a receipt. The
Observatory re-reads every stored record each hour (`src/records.ts`). Both sides use one
definition of the format: `src/contract.ts`.

## How to send a record

    POST https://observatory-recorder.<account subdomain>.workers.dev/v1/records
    headers: CF-Access-Client-Id, CF-Access-Client-Secret   (the front desk's service token)
    body:    the record (JSON, at most 8192 bytes)

Cloudflare Access stands in front of the address and lets through only the front desk's service
token and Ben. The recorder checks Access's signed token again itself. `GET /v1/status` (front desk
or Ben) shows today's count and whether a write is pending. Nothing else answers.

## The record

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | `1` |
| `grant` | yes | the front desk's grant id, 8-64 of `A-Z a-z 0-9 _ -` |
| `stage` | yes | `request`, `verdict`, `approval` or `result` |
| `job` | yes | the job name, e.g. `cf.token.canary` (`a-z 0-9 . -`, up to 40); every stage of a grant names the same job |
| `request` | every stage but `request` | the SHA-256 (hex) of the request record's exact bytes, as in its receipt |
| anything else | no | e.g. `params`, `requester`, `outcome` |

The body is the exact bytes sent, UTF-8 with no byte-order mark (a leading mark is kept and then fails as not JSON).

No secret values, ever, and no field at any depth whose name contains `secret`, `password`,
`token`, `private` or `credential`, nested no deeper than 8 levels. The recorder refuses these;
it cannot detect a secret under an innocent name, so the front desk redacts (phase 3).

## What the recorder refuses, before storing anything

| Answer | Why |
|---|---|
| 401 / 403 | no valid edge-login token, or not the front desk (Ben may read status, not write) |
| 503 | its edge-login settings are missing; Access's keys unreadable; a write pending that the bucket has not taken yet (retry); or anything it did not write already sitting under its next record number (stops until Ben looks) |
| 413 | over 8192 bytes, counted as the body arrives |
| 400 | outside the record format above (a fixed reason, never the writer's own text) |
| 409 | approval or verdict with no recorded request; result with no recorded approval; wrong request hash or job; this stage already recorded with other content |
| 410 | the grant's request is over 24 hours old |
| 429 | today's 400 slots (UTC day) are taken, or the lifetime storage budget (1 GiB of stored envelopes) is full. A request takes 4 slots and reserves room in the budget for its grant's other three stages, so admitted grants can always finish. A new day starts with the slots still reserved by grants opened the day before, never at zero, so no UTC day stores more than 400 records; a write held over midnight by an outage is charged to the day it is finally stored. A full budget refuses every request until Ben decides. |

The same bytes sent again for a recorded stage get the same receipt (200), so a lost answer is
safe to retry. A new record gets 201 and its receipt:

    { "receipt": { "v": 1, "seq": 42, "key": "records/v1/000000000042.<grant>.<stage>.json",
                   "grant": "...", "stage": "...", "sha256": "<hex of the body>",
                   "recorded_at": "2026-11-01T12:30:00.000Z" } }

A receipt is given only after the record is in the bucket. **No receipt, no run** (phase 3).

## What is stored

Bucket `observatory-records` in the Observatory's Cloudflare account, written only by the
recorder. A lock rule on `records/` (at least 400 days) makes it add-only: Cloudflare refuses any
overwrite or delete of a locked object.

    records/v1/<12-digit sequence number>.<grant>.<stage>.json

The recorder picks every name: numbers start at 1 with no gaps, so sorting by name is the order
it accepted them. Each object holds an envelope, with the writer's bytes untouched:

    { "v": 1, "seq": 42, "grant": "...", "stage": "...", "recorded_at": "<recorder's time>",
      "sha256": "<hex of body>", "body": "<the writer's record, as sent>" }

## What the Observatory checks every hour

Every record stored since its last run, asking for the next expected number by name each time,
so names elsewhere in the bucket cost nothing and cannot hide records still to come (at most 500
an hour; more is itself a finding). Two objects with one number: the checker cannot tell which copy
is the recorder's (by design it cannot read the recorder's ledger), so the number is held. Reading
goes on past it; every copy at a held number is re-checked every hour, so the recorder's own is
checked whenever it lands; none counts toward a grant or a day; and the run stays unverified until
Ben names the copy he trusts in the `RECORDS_HELD_ACK` setting, as `<number>:<grant>.<stage>`
(comma-separated); that copy then joins the order and day checks. At most 20 numbers are held;
the 21st stops the read, unverified. A missing number with a
higher one present is a standing gap finding. For each record: the name, the size, the envelope against the name and R2's upload time (within
10 minutes), the hash, the record against this contract, and the order of each grant's stages
(no duplicates, request first, approval before result, same request and job). Also: any gap in
the numbers, anything outside `records/v1/`, a UTC day over 400 records, and the lock on
`records/` (once `LOCK_READ_TOKEN` exists). Once a day (04:30 UTC) it counts every record against
the recorder's last number, which catches an object slipped in under an older name. Findings
never repeat writer-chosen text: grant ids and unexpected names are shown as fingerprints (the first 16 hex of their SHA-256), and grant findings name the record number.
A lock it cannot read, including before `LOCK_READ_TOKEN` exists, is a finding, never healthy. Each finding
alerts once, worst first; it counts as told only once a channel took the alert, and the rest are
carried to the next hour. Until Ben sets `PING_URL_RECORDS`, it only logs.

## Choices for Ben to keep or change

400 records a day (100 grants), 8192 bytes a record, a 1 GiB lifetime storage budget, 24 hours
to finish a grant, and a 400-day lock are builder defaults (Codex r1 drift item), sized for the front desk's expected few
approvals a day. Changing any of them is one constant in `src/contract.ts` or `src/records.ts`. Before anything deletes old records after the lock, the daily count (records stored = last number) must change with it.
