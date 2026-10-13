import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/worker.mjs";
import { configuration } from "../lib/config.mjs";
import { aggregate } from "../lib/aggregate.mjs";
import { verifyRecordedDay } from "../lib/reconcile.mjs";

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-schedule-test-"));
  const originalFetch = globalThis.fetch, originalToken = process.env.TOKSCALE_API_TOKEN;
  delete process.env.TOKSCALE_API_TOKEN;
  t.after(async () => { globalThis.fetch = originalFetch; if (originalToken === undefined) delete process.env.TOKSCALE_API_TOKEN; else process.env.TOKSCALE_API_TOKEN = originalToken; await rm(dir, { recursive: true, force: true }); });
  const config = configuration({ magpieDir: dir, stateDir: join(dir, "state"), autoSubmit: true });
  const auth = key => writeFile(join(dir, "plugin-auth.json"), JSON.stringify({ "tokscale-import": { type: "api", key } }));
  await auth("tt_synthetic_schedule");
  const record = (date, input = 100) => ({ t: date + "T12:00:00+09:00", agent: "pi", provider: "openai", model: "example", in: input, out: 20 });
  await writeFile(config.usageFile, ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"].map(date => JSON.stringify(record(date))).join("\n") + "\n");
  const ledger = join(dir, "remote-ledger.json");
  await writeFile(ledger, "{}");
  const remoteTotal = async () => Object.values(JSON.parse(await readFile(ledger, "utf8"))).reduce((a, b) => a + b, 0);
  const receive = async (_url, init) => {
    const payload = JSON.parse(init.body), rows = JSON.parse(await readFile(ledger, "utf8"));
    for (const day of payload.contributions) rows[day.date] = day.totals.tokens;
    await writeFile(ledger, JSON.stringify(rows));
    return Response.json({ success: true, submissionId: "synthetic", username: "synthetic", mode: "merge", metrics: { totalTokens: String(await remoteTotal()) } });
  };
  return { config, auth, record, receive, remoteTotal };
}

test("Saving an API key enables daily uploads without overriding an earlier refusal or explicit disable", async t => {
  const { config, auth, receive, remoteTotal } = await setup(t);
  delete config.autoSubmit;
  globalThis.fetch = receive;
  const authFile = join(config.magpieDir, "plugin-auth.json");
  await writeFile(authFile, JSON.stringify({ "tokscale-import": { type: "api", key: "tt_synthetic_schedule", metadata: { autoSubmit: "no" } } }));
  await run(config, { scheduled: true, now: new Date("2026-03-09T18:00:00Z") });
  await run(config, { scheduled: true, now: new Date("2026-03-10T00:00:00Z") });
  assert.equal(await remoteTotal(), 0);
  await auth("tt_synthetic_schedule");
  await run(config, { scheduled: true, now: new Date("2026-03-10T18:00:00Z") });
  await run({ ...config, autoSubmit: false }, { scheduled: true, now: new Date("2026-03-11T00:00:00Z") });
  assert.equal(await remoteTotal(), 0);
  await run(config, { scheduled: true, now: new Date("2026-03-11T00:00:00Z") });
  assert.equal(await remoteTotal(), 120);
});

test("Enabling a daily schedule does not submit old history before its first UTC midnight", async t => {
  const { config, receive, remoteTotal } = await setup(t);
  globalThis.fetch = receive;
  await run(config, { scheduled: true, now: new Date("2026-03-09T18:00:00Z") });
  await run(config, { scheduled: true, now: new Date("2026-03-09T23:59:59Z") });
  assert.equal(await remoteTotal(), 0);
  await run(config, { scheduled: true, now: new Date("2026-03-10T00:00:00Z") });
  assert.equal(await remoteTotal(), 120);
  await run(config, { scheduled: true, now: new Date("2026-03-10T00:01:00Z") });
  assert.equal(await remoteTotal(), 120);
});

test("Restart catches up missed UTC days without adding current usage or replaying settled snapshots", async t => {
  const { config, receive, remoteTotal } = await setup(t);
  globalThis.fetch = receive;
  await run(config, { scheduled: true, now: new Date("2026-03-08T18:00:00Z") });
  await run(config, { scheduled: true, now: new Date("2026-03-11T03:00:00Z") });
  await run(config, { scheduled: true, now: new Date("2026-03-11T03:01:00Z") });
  await run(config, { scheduled: true, now: new Date("2026-03-11T03:02:00Z") });
  assert.equal(await remoteTotal(), 360);
  await run(config, { scheduled: true, now: new Date("2026-03-10T22:00:00Z") }); // Clock moved backwards.
  assert.equal(await remoteTotal(), 360);
});

test("An uncertain remote commit stops automatic replay even if late records change the snapshot", async t => {
  const { config, receive, remoteTotal, record } = await setup(t);
  globalThis.fetch = receive;
  await run(config, { scheduled: true, now: new Date("2026-03-09T18:00:00Z") });
  globalThis.fetch = async (...args) => { await receive(...args); throw new TypeError("connection lost after commit"); };
  await run(config, { scheduled: true, now: new Date("2026-03-10T00:00:00Z") });
  assert.equal(await remoteTotal(), 120);
  const before = await readFile(config.usageFile, "utf8");
  await writeFile(config.usageFile, before + JSON.stringify(record("2026-03-09", 50)) + "\n");
  globalThis.fetch = async () => { throw new Error("Uncertain upload must not be replayed."); };
  await run(config, { scheduled: true, now: new Date("2026-03-10T02:00:00Z") });
  await run(config, { yes: true, date: "2026-03-09", now: new Date("2026-03-10T02:01:00Z") });
  const state = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(state.days).reduce((n, day) => n + Object.values(day.clientTokens).reduce((a, b) => a + b, 0), 0), 0);
  assert.equal(await remoteTotal(), 120);
});

test("Retrying a different day cannot destroy an uncertain scheduled day's profile recovery", async t => {
  const { config, receive } = await setup(t);
  globalThis.fetch = receive;
  await run(config, { scheduled: true, now: new Date("2026-03-09T18:00:00Z") });
  globalThis.fetch = async (...args) => { await receive(...args); throw new TypeError("lost receipt"); };
  await run(config, { scheduled: true, now: new Date("2026-03-10T00:00:00Z") });
  globalThis.fetch = receive;
  await run(config, { yes: true, retry: true, date: "2026-03-08", now: new Date("2026-03-10T02:00:00Z") });
  const day = (await aggregate(config, { date: "2026-03-09" })).contributions[0];
  globalThis.fetch = async (url, init) => {
    if (init.method === "POST") throw new Error("Recovery must not resubmit.");
    return Response.json(String(url).endsWith("/api/auth/token") ? { user: { username: "synthetic" } } : { user: { username: "synthetic" }, contributions: [{ date: day.date, totals: { ...day.totals, messages: 0 }, tokenBreakdown: day.tokenBreakdown, clients: [{ ...day.clients[0], models: { example: { ...day.clients[0].tokens, tokens: 120, cost: 0, messages: 1 } } }] }] });
  };
  await verifyRecordedDay(config, day.date);
  const state = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(state.days[day.date].clientTokens).reduce((a, b) => a + b, 0), 120);
});

test("Deleting the key pauses due submissions; rotation starts a fresh schedule baseline", async t => {
  const { config, receive, remoteTotal, auth } = await setup(t);
  globalThis.fetch = receive;
  await run(config, { scheduled: true, now: new Date("2026-03-09T18:00:00Z") });
  await writeFile(join(config.magpieDir, "plugin-auth.json"), "{}");
  await run(config, { scheduled: true, now: new Date("2026-03-10T00:00:00Z") });
  assert.equal(await remoteTotal(), 0);
  await auth("tt_synthetic_rotated_schedule");
  await run(config, { scheduled: true, now: new Date("2026-03-10T02:00:00Z") });
  assert.equal(await remoteTotal(), 0);
  await run(config, { scheduled: true, now: new Date("2026-03-11T00:00:00Z") });
  assert.equal(await remoteTotal(), 120);
});
