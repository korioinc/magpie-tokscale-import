import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, locked, saveState } from "../lib/state.mjs";
import { run } from "../lib/worker.mjs";

const now = new Date("2026-03-10T12:00:00Z");
const hash = value => createHash("sha256").update(value).digest("hex");
async function setup(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "magpie-state-test-"));
  const config = { magpieDir: dir, stateDir: join(dir, "state"), timezone: "UTC" };
  await fs.mkdir(config.stateDir);
  const token = "test-only-state-token";
  const legacy = {
    version: 1, timezone: "Asia/Seoul",
    days: { "2026-03-08": { digest: hash("day"), clientTokens: { pi: 120 } } },
    failures: { "2026-03-09": { digest: hash("pending"), attempts: 2, blocked: true, nextAttemptAt: 0, reason: "uncertain" } },
    pendingScheduledUpload: { date: "2026-03-09", digest: hash("pending"), tokenDigest: hash(JSON.stringify(token)), startedAt: "2026-03-10T00:00:00Z" },
    tokenDigest: hash(JSON.stringify(token)), authBlocked: false,
    schedule: { completedUtcDate: "2026-03-09", initializedAt: "2026-03-09T00:00:00Z" },
    pricing: { available: false }, customMetadata: { marker: ["keep", 42] },
  };
  const path = join(config.stateDir, "state.json");
  const backup = join(config.stateDir, "state.v1.backup.json");
  await fs.writeFile(path, JSON.stringify(legacy));
  await fs.writeFile(join(dir, "plugin-auth.json"), JSON.stringify({ "tokscale-import": { type: "api", key: token } }));
  const previousToken = process.env.TOKSCALE_API_TOKEN;
  delete process.env.TOKSCALE_API_TOKEN;
  t.after(async () => {
    if (previousToken === undefined) delete process.env.TOKSCALE_API_TOKEN;
    else process.env.TOKSCALE_API_TOKEN = previousToken;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { config, legacy, path, backup };
}

const operational = ({ version, timezone, legacyTimezone, pendingScheduledUpload, pendingScheduledUploads, ...records }) => records;
const read = async path => JSON.parse(await fs.readFile(path, "utf8"));

function failFS(t, method, predicate) {
  const original = fs[method];
  const mock = t.mock.method(fs, method, async (...args) => {
    if (predicate(...args)) throw Object.assign(new Error("Injected filesystem failure"), { code: "EIO" });
    return original(...args);
  });
  syncBuiltinESMExports();
  const restore = () => { mock.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test("Automatic migration backs up the original and preserves operational data before an early return", async t => {
  const { config, legacy, path, backup } = await setup(t);
  await run({ ...config, autoSubmit: false }, { scheduled: true, now });
  assert.deepEqual(await read(backup), legacy);
  assert.deepEqual(operational(await read(path)), operational(legacy));
  const before = await fs.readFile(path, "utf8");
  await run({ ...config, autoSubmit: false }, { scheduled: true, now });
  assert.equal(await fs.readFile(path, "utf8"), before);
});

test("Read-only state access preserves the original bytes and historical records", async t => {
  const { config, legacy, path } = await setup(t);
  const before = await fs.readFile(path, "utf8");
  assert.deepEqual(operational(await loadState(config)), operational(legacy));
  assert.equal(await fs.readFile(path, "utf8"), before);
});

for (const version of [1, 2]) {
  test(`Version ${version} migration protects a pending day without blocking later delivery`, async t => {
    const { config, legacy, path } = await setup(t);
    legacy.version = version;
    if (version === 2) legacy.timezone = "UTC";
    delete legacy.failures["2026-03-09"]; // The pending marker alone must prevent replay.
    await fs.writeFile(path, JSON.stringify(legacy));
    const backup = join(config.stateDir, `state.v${version}.backup.json`);
    config.usageFile = join(config.magpieDir, "usage.jsonl");
    config.pricingFile = join(config.magpieDir, "missing-models.json");
    await fs.writeFile(config.usageFile, JSON.stringify({ t: "2026-03-10T12:00:00Z", agent: "pi", provider: "openai", model: "example", in: 100, out: 20 }) + "\n");
    let remoteTokens = 120;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      if (init.method !== "POST") throw new TypeError("profile unavailable");
      for (const day of JSON.parse(init.body).contributions) remoteTokens += day.totals.tokens;
      return Response.json({ success: true, submissionId: "synthetic", username: "synthetic", mode: "merge", metrics: { totalTokens: remoteTokens } });
    });
    await run(config, { yes: true, retry: true, date: "2026-03-09", now });
    assert.equal(remoteTokens, 120);
    assert.deepEqual(await read(backup), legacy);
    assert.deepEqual((await read(path)).days, legacy.days);
    await run(config, { scheduled: true, now }); // Resumes at the legacy pending boundary.
    await run(config, { scheduled: true, now: new Date("2026-03-11T12:00:00Z") });
    assert.equal(remoteTokens, 240);
    assert.equal((await read(path)).days["2026-03-10"].clientTokens.pi, 120);
    await run(config, { yes: true, retry: true, date: "2026-03-09", now: new Date("2026-03-11T13:00:00Z") });
    assert.equal(remoteTokens, 240);
  });
}

test("Overlapping migration users cannot overwrite the lock owner's later checkpoint", async t => {
  const { config, legacy, path, backup } = await setup(t);
  let enter, unblock;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const first = locked(config, async (assertOwned, state) => {
    enter(); await gate;
    state.days["2026-03-09"] = { digest: hash("new"), clientTokens: { pi: 80 } };
    assertOwned(); await saveState(config, state);
  });
  await entered;
  try { await locked(config, async () => { throw new Error("Another writer acquired the held lock"); }); }
  finally { unblock(); await first; }
  await locked(config, async () => {});
  assert.equal((await read(path)).days["2026-03-09"].clientTokens.pi, 80);
  assert.deepEqual(await read(backup), legacy);
});

for (const variant of ["future", "checkpoint", "collision", "backup", "pending-owner", "pending-conflict", "verification-time"]) {
  test("Unsafe " + variant + " input cannot replace state or its backup", async t => {
    const { config, legacy, path, backup } = await setup(t);
    if (variant === "future") legacy.version = 999;
    if (variant === "checkpoint") legacy.days["2026-03-08"].clientTokens.pi = -1;
    if (variant === "collision") legacy.legacyTimezone = "America/New_York";
    if (variant === "backup") await fs.writeFile(backup, JSON.stringify({ ...legacy, customMetadata: { other: true } }));
    if (variant === "pending-owner") legacy.pendingScheduledUpload.tokenDigest = hash("another-account");
    if (variant === "pending-conflict") legacy.pendingScheduledUploads = { "2026-03-09": { ...legacy.pendingScheduledUpload, digest: hash("another-upload") } };
    if (variant === "verification-time") legacy.pendingScheduledUpload.nextVerificationAt = -1;
    await fs.writeFile(path, JSON.stringify(legacy));
    const before = await fs.readFile(path, "utf8");
    const previousBackup = await fs.readFile(backup, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    await assert.rejects(locked(config, async () => {}));
    assert.equal(await fs.readFile(path, "utf8"), before);
    if (previousBackup !== null) assert.equal(await fs.readFile(backup, "utf8"), previousBackup);
  });
}

for (const method of ["link", "rename"]) {
  test("Migration " + method + " failure preserves the original and retry completes safely", async t => {
    const { config, legacy, path, backup } = await setup(t);
    const original = await fs.readFile(path, "utf8");
    const restore = failFS(t, method, (_from, to) => to === (method === "link" ? backup : path));
    await assert.rejects(locked(config, async () => {}));
    assert.equal(await fs.readFile(path, "utf8"), original);
    restore();
    await locked(config, async () => {});
    assert.deepEqual(await read(backup), legacy);
    assert.deepEqual(operational(await read(path)), operational(legacy));
  });
}

test("A failed operation after migration leaves the committed state and original backup intact", async t => {
  const { config, legacy, path, backup } = await setup(t);
  await assert.rejects(locked(config, async () => { throw new Error("operation failed"); }));
  const migrated = await fs.readFile(path, "utf8");
  await locked(config, async () => {});
  assert.equal(await fs.readFile(path, "utf8"), migrated);
  assert.deepEqual(await read(backup), legacy);
});
