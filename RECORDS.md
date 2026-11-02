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
or Ben) shows today's count, whether a write is pending, and the recorder's public key. Nothing else answers.

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
| 429 | today's 400 slots (UTC day) are taken, or the lifetime storage budget (1 GiB of stored envelopes) is full. A request takes 4 slots and reserves room in the budget for its grant's other three stages, so admitted grants can always finish. A new day starts with the slots still reserved by grants opened the day before, never at zero, so no UTC day stores more than 400 records; a write held over midnight by an outage, however briefly, is charged to the day it is finally stored and carries that day's time. A full budget refuses every request until Ben decides. |

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

    { "v": 2, "seq": 42, "grant": "...", "stage": "...", "recorded_at": "<recorder's time>",
      "sha256": "<hex of body>", "body": "<the writer's record, as sent>", "sig": "<base64>" }

`sig` is the recorder's Ed25519 signature over the JSON of the other fields in that order
(`sealed` in `src/contract.ts`). The key is made inside the recorder's Durable Object on first use
(a record or a status read); its private half stays in that object's storage and is never returned
or logged. Records stored before signing began are version 1, with no `sig`.

## Pinning the recorder's key (Ben's step)

The checker trusts one public key, written into `PIN` in `src/records.ts` by a PR Ben merges:
`{ key: "<public_key from GET /v1/status>", from: <the first record number that must be signed> }`.
Until then the checker reads as it did before signing, except that a shared number is only a
finding. When a pin first takes effect, every number from `from` that was already read is checked
once for exactly one signed copy (an `unsigned` finding otherwise), without being counted again; the
run stays unverified until that check has caught up. A lost or replaced key makes every later record foreign, loudly, until Ben merges the
new key.

## What the Observatory checks every hour

Every record stored since its last run, asking for the next expected number by name each time,
so names elsewhere in the bucket cost nothing and cannot hide records still to come (at most 500
an hour; more is itself a finding). From `PIN.from` on, the record at a number is the one copy whose
signature the pinned key verifies and whose envelope names that same number, grant and stage; every
other object there is a foreign finding, and reading goes on with no step for Ben (the recorder
itself still stops, 503, while something else sits under its next number). With no signed
copy at a number yet, the bookmark waits there and reads it again next hour. Two signed copies at
one number mean the key may be stolen: a `forged` finding, ranked first, and the read stops there,
unverified. More than 20 objects at one number, or one that cannot be read, also leaves the run
unverified with the bookmark in place. Before the pin, two objects with one number are a finding
and none of them counts. A missing number with a
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
