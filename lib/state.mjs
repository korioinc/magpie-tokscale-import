import { mkdir, open, rename, link, unlink, chmod } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { readJSON, validDate, requireUTC } from "./config.mjs";

export const STATE_VERSION = 3;

export async function atomicJSON(path, value, { exclusive = false, beforeCommit = () => {} } = {}) {
  const temp = path + "." + randomUUID() + ".tmp";
  let file;
  try {
    file = await open(temp, "wx", 0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
    await file.close();
    file = undefined;
    beforeCommit();
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await file?.close();
    await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function locked(config, operation) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  let compromised = false;
  let release;
  try {
    release = await lockfile.lock(config.stateDir, { stale: 120000, update: 10000, retries: 0, onCompromised() { compromised = true; } });
  } catch (error) {
    if (error.code === "ELOCKED") return { status: "locked" };
    throw new Error("Cannot acquire exporter state lock.", { cause: error });
  }
  const assertOwned = () => { if (compromised) throw new Error("Exporter lock lost. Submission outcome may be uncertain; next worker will retry the snapshot."); };
  try {
    requireUTC(config.timezone);
    const original = await readJSON(join(config.stateDir, "state.json"), true);
    const state = normalizeState(original);
    if (original && original.version !== STATE_VERSION) {
      const backup = join(config.stateDir, "state.v" + original.version + ".backup.json");
      try { await atomicJSON(backup, original, { exclusive: true, beforeCommit: assertOwned }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (!isDeepStrictEqual(await readJSON(backup), original)) throw new Error("State migration backup differs from current state. Preserve both files and resolve the conflict before retrying.");
      await atomicJSON(join(config.stateDir, "state.json"), state, { beforeCommit: assertOwned });
    }
    assertOwned();
    return await operation(assertOwned, state);
  }
  finally { if (!compromised) await release(); }
}

export async function loadState(config) {
  requireUTC(config.timezone);
  return normalizeState(await readJSON(join(config.stateDir, "state.json"), true));
}

function normalizeState(value) {
  if (value === undefined) return { version: STATE_VERSION, timezone: "UTC", days: {}, failures: {}, pendingScheduledUploads: {} };
  const object = v => v && typeof v === "object" && !Array.isArray(v);
  const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!object(value) || ![1, 2, STATE_VERSION].includes(value.version) || typeof value.timezone !== "string" || !object(value.days) || !object(value.failures)) throw new Error("Unsupported or invalid exporter state. Use a compatible plugin or restore a verified backup; do not reset history.");
  if (value.version >= 2 && (value.timezone !== "UTC" || (value.legacyTimezone !== undefined && (typeof value.legacyTimezone !== "string" || !value.legacyTimezone)))) throw new Error("Invalid current state timezone metadata.");
  if (value.version === 1 && Object.hasOwn(value, "legacyTimezone") && value.legacyTimezone !== value.timezone) throw new Error("Legacy timezone metadata conflicts with the original state. Resolve it before migration.");
  if (value.tokenDigest !== undefined && !digest(value.tokenDigest)) throw new Error("Invalid exporter authentication checkpoint.");
  for (const [date, day] of Object.entries(value.days)) {
    if (!validDate(date) || !object(day) || !digest(day.digest) || !object(day.clientTokens) || !Object.values(day.clientTokens).every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error("Invalid daily checkpoint.");
  }
  for (const [date, failure] of Object.entries(value.failures)) {
    if (!validDate(date) || !object(failure) || !digest(failure.digest) || !Number.isSafeInteger(failure.attempts) || failure.attempts < 1 || typeof failure.blocked !== "boolean" || !Number.isFinite(failure.nextAttemptAt)) throw new Error("Invalid retry checkpoint.");
  }
  const validPending = pending => object(pending) && validDate(pending.date) && digest(pending.digest) && digest(pending.tokenDigest) && pending.tokenDigest === value.tokenDigest && typeof pending.startedAt === "string" && Number.isFinite(Date.parse(pending.startedAt)) && (pending.nextVerificationAt === undefined || (Number.isFinite(pending.nextVerificationAt) && pending.nextVerificationAt >= 0));
  if (value.pendingScheduledUpload !== undefined && (value.version === STATE_VERSION || !validPending(value.pendingScheduledUpload))) throw new Error("Invalid pending scheduled upload.");
  if (value.pendingScheduledUploads !== undefined && (!object(value.pendingScheduledUploads) || Object.entries(value.pendingScheduledUploads).some(([date, pending]) => !validPending(pending) || date !== pending.date))) throw new Error("Invalid pending scheduled uploads.");
  if (value.schedule !== undefined && (!object(value.schedule) || !validDate(value.schedule.completedUtcDate) || typeof value.schedule.initializedAt !== "string" || !Number.isFinite(Date.parse(value.schedule.initializedAt)))) throw new Error("Invalid daily schedule checkpoint.");
  if (value.authBlocked !== undefined && typeof value.authBlocked !== "boolean") throw new Error("Invalid authentication failure state.");
  if (value.version !== STATE_VERSION) {
    const migrated = { ...value, version: STATE_VERSION, timezone: "UTC", pendingScheduledUploads: { ...value.pendingScheduledUploads } };
    if (value.version === 1 && value.timezone !== "UTC") migrated.legacyTimezone = value.timezone;
    const pending = value.pendingScheduledUpload;
    if (pending) {
      const existing = migrated.pendingScheduledUploads[pending.date];
      if (existing && !isDeepStrictEqual(existing, pending)) throw new Error("Conflicting pending scheduled uploads. Preserve both records before migration.");
      migrated.pendingScheduledUploads[pending.date] = pending;
    }
    delete migrated.pendingScheduledUpload;
    return normalizeState(migrated);
  }
  return { ...value, pendingScheduledUploads: value.pendingScheduledUploads ?? {} };
}

export const saveState = (config, state) => atomicJSON(join(config.stateDir, "state.json"), state);
