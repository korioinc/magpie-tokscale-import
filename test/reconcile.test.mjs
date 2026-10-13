import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "../lib/worker.mjs";
import { verifyRecordedDay } from "../lib/reconcile.mjs";
import { aggregate } from "../lib/aggregate.mjs";
import { configuration } from "../lib/config.mjs";
import { yesterday } from "../lib/aggregate.mjs";

test("An uncertain settled day recovers only from matching account/day/model usage, without another POST", async t => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-reconcile-test-"));
  const oldFetch = globalThis.fetch, oldToken = process.env.TOKSCALE_API_TOKEN;
  delete process.env.TOKSCALE_API_TOKEN;
  t.after(async () => { globalThis.fetch = oldFetch; if (oldToken === undefined) delete process.env.TOKSCALE_API_TOKEN; else process.env.TOKSCALE_API_TOKEN = oldToken; await rm(dir, { recursive: true, force: true }); });
  const config = configuration({ magpieDir: dir, stateDir: join(dir, "state") });
  const date = yesterday(new Date());
  await writeFile(config.usageFile, JSON.stringify({ t: date + "T12:00:00+09:00", agent: "pi", provider: "openai", model: "example", in: 100, out: 20 }) + "\n");
  await writeFile(join(dir, "plugin-auth.json"), JSON.stringify({ "tokscale-import": { type: "api", key: "tt_synthetic_recovery_test", metadata: { autoSubmit: "no" } } }));
  globalThis.fetch = async () => Response.json({ success: true, mode: "merge", metrics: { totalTokens: 120 } });
  await run(config, { yes: true, date }); // Synthetic remote response lacks receipt: no successful checkpoint.
  const before = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  let successfulTokens = Object.values(before.days).reduce((n, day) => n + Object.values(day.clientTokens).reduce((a, b) => a + b, 0), 0);
  assert.equal(successfulTokens, 0);
  const day = (await aggregate(config, { date })).contributions[0];
  const makeProfile = tokens => ({ user: { username: "synthetic" }, contributions: [{ date, totals: { tokens, cost: 0, messages: 0 }, tokenBreakdown: day.tokenBreakdown, clients: [{ client: "pi", tokens: day.clients[0].tokens, messages: 1, cost: 0, models: { example: { ...day.clients[0].tokens, tokens: 120, messages: 1, cost: 0 } } }] }] });
  let mismatch = true;
  globalThis.fetch = async (url, init) => {
    if (init.method === "POST") throw new Error("Recovery must never resubmit usage.");
    return Response.json(String(url).endsWith("/api/auth/token") ? { user: { username: "synthetic" } } : makeProfile(mismatch ? 119 : 120));
  };
  await verifyRecordedDay(config, date);
  const rejected = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(rejected.days).reduce((n, day) => n + Object.values(day.clientTokens).reduce((a, b) => a + b, 0), 0), 0);
  mismatch = false;
  await verifyRecordedDay(config, date);
  const recovered = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(recovered.days).reduce((n, day) => n + Object.values(day.clientTokens).reduce((a, b) => a + b, 0), 0), 120);
  await verifyRecordedDay(config, date);
  const repeated = JSON.parse(await readFile(join(config.stateDir, "state.json"), "utf8"));
  assert.equal(Object.values(repeated.days).reduce((n, day) => n + Object.values(day.clientTokens).reduce((a, b) => a + b, 0), 0), 120);
});
