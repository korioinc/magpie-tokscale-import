import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../lib/aggregate.mjs";

const now = new Date("2026-03-10T12:00:00Z");
const call = overrides => ({ t: "2026-03-08T12:00:00Z", agent: "pi", provider: "openai", model: "example", in: 70, out: 30, cache_read: 20, reasoning: 10, ...overrides });
async function setup(t, records) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-usage-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const usageFile = join(dir, "usage.jsonl");
  await writeFile(usageFile, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
  return { usageFile, stateDir: join(dir, "state"), pricingFile: join(dir, "missing-models.json"), timezone: "UTC" };
}

test("OpenAI, Anthropic, Gemini canonical logs conserve all tokens without adding reasoning/TTL twice", async t => {
  const config = await setup(t, [
    call({ provider: "openai" }),
    call({ provider: "anthropic", model: "claude-example", cache_write: 12, cache_write_1h: 5 }),
    call({ provider: "google", model: "gemini-example" }),
  ]);
  const { contributions } = await aggregate(config, { now });
  const day = contributions[0];
  // Raw canonical totals: 120 + 132 + 120. Reasoning is already in out; TTL already in cache_write.
  assert.equal(day.totals.tokens, 372);
  assert.equal(day.tokenBreakdown.output, 60);
  assert.equal(day.tokenBreakdown.reasoning, 30);
  assert.equal(day.tokenBreakdown.cacheWrite, 12);
});

test("Exact identified copies are discarded; distinct paid failover attempts remain", async t => {
  const first = call({ rid: "same-id", route_id: 99, handed_on: true, status: 503 });
  const config = await setup(t, [first, { ...first }, call({ rid: "same-id", route_id: 99, status: 200, t: "2026-03-08T12:00:01Z" })]);
  const { contributions } = await aggregate(config, { now });
  assert.equal(contributions[0].totals.tokens, 240);
  assert.equal(contributions[0].totals.messages, 1);
});

test("Incomplete tail is deferred and subsequently counted, without replaying previous usage", async t => {
  const config = await setup(t, [call()]);
  const partial = JSON.stringify(call({ t: "2026-03-08T12:00:01Z" }));
  await writeFile(config.usageFile, JSON.stringify(call()) + "\n" + partial);
  const before = await aggregate(config, { now });
  assert.equal(before.contributions[0].totals.tokens, 120);
  await writeFile(config.usageFile, JSON.stringify(call()) + "\n" + partial + "\n");
  const after = await aggregate(config, { now });
  assert.equal(after.contributions[0].totals.tokens, 240);
});

test("UTC midnight separates days and keeps current-day usage private regardless of timestamp offset", async t => {
  const config = await setup(t, [
    call({ t: "2026-03-08T08:59:59+09:00" }), // March 7, 23:59:59 UTC.
    call({ t: "2026-03-08T09:00:00+09:00" }), // March 8, 00:00:00 UTC.
    call({ t: "2026-03-09T00:00:00Z" }), // Current UTC day: do not upload.
  ]);
  const { contributions } = await aggregate(config, { now: new Date("2026-03-09T00:00:01Z") });
  assert.equal(contributions.find(day => day.date === "2026-03-07").totals.tokens, 120);
  assert.equal(contributions.find(day => day.date === "2026-03-08").totals.tokens, 120);
  assert.equal(contributions.reduce((n, day) => n + day.totals.tokens, 0), 240);
});

test("Unknown callers, impossible overlaps and rejected requests cannot become submitted usage", async t => {
  const config = await setup(t, [call(), call({ agent: "unknown" }), call({ reasoning: 31 }), call({ rejected: true }), "not-json"]);
  const { contributions } = await aggregate(config, { now });
  assert.equal(contributions[0].totals.tokens, 120);
});
