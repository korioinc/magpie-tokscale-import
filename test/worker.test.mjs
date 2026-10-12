import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/worker.mjs";

const now = new Date("2026-03-10T12:00:00Z");
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-worker-test-"));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.TOKSCALE_API_TOKEN;
  delete process.env.TOKSCALE_API_TOKEN;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.TOKSCALE_API_TOKEN; else process.env.TOKSCALE_API_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  });
  const record = { t: "2026-03-08T12:00:00Z", agent: "pi", provider: "openai", model: "example", in: 70, out: 30, cache_read: 20, reasoning: 10 };
  await writeFile(join(dir, "usage.jsonl"), JSON.stringify(record) + "\n");
  const auth = token => writeFile(join(dir, "plugin-auth.json"), JSON.stringify({ "tokscale-import": { type: "api", key: token, metadata: { autoSubmit: "yes" } } }), { mode: 0o600 });
  await auth("test-only-token");
  const ledger = join(dir, "synthetic-service-ledger.json");
  await writeFile(ledger, "{}");
  const receive = async (_url, init) => {
    const data = JSON.parse(init.body);
    const rows = JSON.parse(await readFile(ledger, "utf8"));
    for (const day of data.contributions) rows[day.date] = day.totals.tokens;
    await writeFile(ledger, JSON.stringify(rows));
    return Response.json({ success: true, submissionId: "synthetic-id", username: "synthetic-user", mode: "merge", metrics: { totalTokens: Object.values(rows).reduce((a, b) => a + b, 0) } });
  };
  const total = async () => Object.values(JSON.parse(await readFile(ledger, "utf8"))).reduce((a, b) => a + b, 0);
  return { config: { magpieDir: dir, usageFile: join(dir, "usage.jsonl"), stateDir: join(dir, "state"), pricingFile: join(dir, "missing-models.json"), timezone: "UTC" }, auth, receive, total };
}

test("Missing consent prevents external usage mutation", async t => {
  const { config, receive, total } = await setup(t);
  globalThis.fetch = receive;
  await run({ ...config, autoSubmit: false }, { now });
  assert.equal(await total(), 0);
});

test("Failure does not lose a daily snapshot; restart retries it, then adds late usage", async t => {
  const { config, receive, total } = await setup(t);
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  await run(config, { now });
  globalThis.fetch = receive;
  await run(config, { now: new Date(now.getTime() + 3600000) });
  assert.equal(await total(), 120);
  await run(config, { now: new Date(now.getTime() + 7200000) });
  assert.equal(await total(), 120);
  const original = await readFile(config.usageFile, "utf8");
  await writeFile(config.usageFile, original + JSON.stringify({ t: "2026-03-08T13:00:00Z", agent: "pi", provider: "openai", model: "example", in: 25, out: 5 }) + "\n");
  await run(config, { now: new Date(now.getTime() + 10800000) });
  assert.equal(await total(), 150);
});

test("Interrupted success response remains recoverable after worker restart", async t => {
  const { config, receive, total } = await setup(t);
  globalThis.fetch = async (...args) => {
    await receive(...args); // Remote commit happened before the connection failed.
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"success":')); controller.error(new TypeError("socket closed")); },
    }));
  };
  await run(config, { now });
  globalThis.fetch = receive;
  await run(config, { now: new Date(now.getTime() + 3600000) });
  const checkpoint = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(checkpoint.days["2026-03-08"].clientTokens).reduce((a, b) => a + b, 0), 120);
  const original = await readFile(config.usageFile, "utf8");
  await writeFile(config.usageFile, original + JSON.stringify({ t: "2026-03-08T13:00:00Z", agent: "pi", provider: "openai", model: "example", in: 25, out: 5 }) + "\n");
  await run(config, { now: new Date(now.getTime() + 7200000) });
  assert.equal(await total(), 150);
});

test("A confirmed snapshot remains durable when service aggregates are decimal strings", async t => {
  const { config, receive } = await setup(t);
  globalThis.fetch = async (...args) => {
    const response = await receive(...args);
    const body = await response.json();
    body.metrics.totalTokens = String(body.metrics.totalTokens);
    return Response.json(body);
  };
  await run(config, { now });
  const checkpoint = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(checkpoint.days["2026-03-08"].clientTokens).reduce((a, b) => a + b, 0), 120);
});

test("Account token rotation cannot inherit another account's submission checkpoint", async t => {
  const { config, auth, receive, total } = await setup(t);
  globalThis.fetch = receive;
  await run(config, { now });
  await auth("test-only-other-account-token");
  // A distinct account has no history in this synthetic external ledger.
  const ledger = join(config.magpieDir, "synthetic-service-ledger.json");
  await writeFile(ledger, "{}");
  await run(config, { now });
  assert.equal(await total(), 120);
});

test("Overlapping worker cannot commit while the first snapshot owns submission", async t => {
  const { config, receive, total } = await setup(t);
  let entered, unblock;
  const submitting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  let firstRequest = true;
  globalThis.fetch = async (...args) => {
    if (firstRequest) { firstRequest = false; entered(); await gate; }
    return receive(...args);
  };
  const first = run(config, { now });
  await submitting;
  await run(config, { now });
  assert.equal(await total(), 0);
  unblock();
  await first;
  // Re-enter after release: real on-disk lock/checkpoint, not an in-memory lock mock.
  await run(config, { now });
  assert.equal(await total(), 120);
});
