import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";

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

test("phase 1 reaches nothing: only the reviewed keys, so no bindings, vars, crons or build step", () => {
  assert.deepEqual(Object.keys(config).sort(), [
    "compatibility_date",
    "main",
    "name",
    "preview_urls",
    "send_metrics",
    "workers_dev",
  ]);
});

test("anything that does reach it gets 404", async () => {
  const res = await worker.fetch();
  assert.equal(res.status, 404);
});
