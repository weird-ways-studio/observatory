import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker, { NIGHT_CRON } from "../src/index.ts";
import { FRESH_CRON } from "../src/fresh.ts";

// wrangler.jsonc keeps its comments on their own lines, so dropping those lines leaves JSON.
const config = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);

test("no public address: workers.dev and preview URLs off, no routes", () => {
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  for (const key of ["route", "routes"]) assert.equal(config[key], undefined, key);
});

test("only the reviewed keys: no vars, no build step, nothing beyond phase 2c", () => {
  assert.deepEqual(Object.keys(config).sort(), [
    "compatibility_date",
    "main",
    "name",
    "observability",
    "preview_urls",
    "r2_buckets",
    "send_metrics",
    "triggers",
    "workers_dev",
  ]);
});

test("it reaches only its own copy bucket: once a night for backups, hourly for freshness", () => {
  assert.deepEqual(config.r2_buckets, [{ binding: "COPY", bucket_name: "observatory-backups" }]);
  assert.deepEqual(config.triggers, { crons: [NIGHT_CRON, FRESH_CRON] });
  assert.deepEqual([NIGHT_CRON, FRESH_CRON], ["15 3 * * *", "30 * * * *"]);
});

test("anything that does reach it gets 404", async () => {
  const res = await worker.fetch();
  assert.equal(res.status, 404);
});
