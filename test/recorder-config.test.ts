import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// wrangler.recorder.jsonc keeps its comments on their own lines, so dropping those lines leaves JSON.
const config = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "wrangler.recorder.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n"),
);

test("recorder: one address, its workers.dev URL (behind the edge login); no preview URLs, no routes", () => {
  assert.equal(config.name, "observatory-recorder");
  assert.equal(config.main, "src/recorder/index.ts");
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  for (const key of ["route", "routes", "triggers", "vars"]) assert.equal(config[key], undefined, key);
});

test("recorder: only the reviewed keys", () => {
  assert.deepEqual(Object.keys(config).sort(), [
    "compatibility_date",
    "durable_objects",
    "main",
    "migrations",
    "name",
    "observability",
    "preview_urls",
    "r2_buckets",
    "send_metrics",
    "workers_dev",
  ]);
});

test("recorder: it reaches the records bucket and its own ledger, never the backups", () => {
  assert.deepEqual(config.r2_buckets, [{ binding: "RECORDS", bucket_name: "observatory-records" }]);
  assert.deepEqual(config.durable_objects, { bindings: [{ name: "LEDGER", class_name: "Recorder" }] });
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["Recorder"] }]); // SQLite: the free-plan kind
});
