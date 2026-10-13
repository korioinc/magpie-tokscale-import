import { createHash } from "node:crypto";
import { aggregate, payload, yesterday } from "./aggregate.mjs";
import { credentials } from "./config.mjs";
import { locked, loadState, saveState } from "./state.mjs";
import { SubmissionError, submit } from "./transport.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clientTotals = day => {
  const result = {};
  for (const group of day.clients) result[group.client] = (result[group.client] ?? 0) + Object.values(group.tokens).reduce((a, b) => a + b, 0);
  return result;
};

export async function run(config, { yes = false, date, retry = false, scheduled = false, now = new Date() } = {}) {
  const startedAt = performance.now();
  return locked(config, async assertOwned => {
    const state = await loadState(config);
    if (scheduled && config.autoSubmit === false) return { status: "disabled" };
    if (scheduled && (yes || date || retry)) throw new Error("Scheduled runs cannot override consent, select a date, or unblock failures.");
    const auth = await credentials(config, { allowMissingAccount: scheduled });
    if (!auth.token) return { status: "not-configured", message: "Sign in to Tokscale Import or set TOKSCALE_API_TOKEN." };
    if (!yes && !auth.consent) return { status: "disabled", message: "Automatic upload needs explicit consent." };
    const tokenDigest = digest(auth.token);
    if (state.tokenDigest && state.tokenDigest !== tokenDigest) {
      // A new account/token must not inherit another account's successful checkpoints.
      state.days = {};
      state.failures = {};
      state.authBlocked = false;
      delete state.schedule;
      delete state.pendingScheduledUpload;
    }
    state.tokenDigest = tokenDigest;
    let scheduledUtcDate;
    if (scheduled) {
      const today = now.toISOString().slice(0, 10);
      if (!state.schedule) {
        state.schedule = { completedUtcDate: today, initializedAt: now.toISOString() };
        assertOwned();
        await saveState(config, state);
        return { status: "schedule-initialized", nextRunAt: new Date(today + "T00:00:00Z").getTime() + 86400000 };
      }
      scheduledUtcDate = new Date(new Date(state.schedule.completedUtcDate + "T00:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
      if (scheduledUtcDate > today) return { status: "not-due" };
      date = yesterday(new Date(scheduledUtcDate + "T00:00:00Z"));
    }
    if (state.pendingScheduledUpload) {
      const pending = state.pendingScheduledUpload;
      if (scheduled || date === pending.date || !date) return { status: "complete", date: pending.date, submitted: [], unchanged: [], failed: [], deferred: [{ date: pending.date, reason: "blocked; scheduled upload outcome is uncertain; verify profile before retrying" }] };
    }
    if (state.authBlocked && !retry) return { status: "auth-blocked", message: "Replace the token or use submit --yes --retry after resolving permissions." };
    if (retry) {
      state.authBlocked = false;
      for (const [day, failure] of Object.entries(state.failures)) {
        if (day === state.pendingScheduledUpload?.date) continue;
        // Manual retry may unblock compatibility/warning failures, never bypass Retry-After.
        if (failure.blocked) {
          if (failure.nextAttemptAt > now.getTime()) {
            failure.blocked = false;
            failure.attempts = 1;
          } else delete state.failures[day];
        }
      }
    }
    const snapshot = await aggregate(config, { now, date });
    state.pricing = snapshot.pricing;
    assertOwned();
    await saveState(config, state);
    const result = { status: "complete", submitted: [], unchanged: [], deferred: [], failed: [], diagnostics: snapshot.diagnostics };
    for (const day of snapshot.contributions) {
      const hash = digest(day);
      const previous = state.days[day.date];
      if (previous?.digest === hash) { result.unchanged.push(day.date); continue; }
      const failure = state.failures[day.date];
      if (failure?.blocked && (scheduled || failure.digest === hash)) {
        result.deferred.push({ date: day.date, reason: "blocked; inspect failure, then use --retry" });
        continue;
      }
      if (failure && failure.nextAttemptAt > now.getTime()) {
        result.deferred.push({ date: day.date, reason: "retry backoff", nextAttemptAt: new Date(failure.nextAttemptAt).toISOString() });
        continue;
      }
      const totals = clientTotals(day);
      const regression = previous && Object.entries(previous.clientTokens).some(([client, count]) => (totals[client] ?? 0) < count);
      if (regression) {
        result.failed.push({ date: day.date, reason: "Local usage decreased; restore full original history before submitting." });
        continue;
      }
      try {
        assertOwned();
        if (scheduled) {
          state.pendingScheduledUpload = { date: day.date, digest: hash, tokenDigest, startedAt: now.toISOString() };
          state.failures[day.date] = { digest: hash, attempts: failure?.attempts ?? 1, blocked: true, nextAttemptAt: now.getTime(), reason: "Scheduled upload outcome is uncertain. Verify the profile before retrying." };
          await saveState(config, state);
        }
        const response = await submit(payload(day, now), auth.token);
        assertOwned();
        state.days[day.date] = { digest: hash, clientTokens: totals, submittedAt: now.toISOString(), ...response };
        delete state.failures[day.date];
        if (scheduled) delete state.pendingScheduledUpload;
        result.submitted.push(day.date);
      } catch (error) {
        if (!(error instanceof SubmissionError)) throw error;
        const attempts = failure?.digest === hash ? failure.attempts + 1 : 1;
        const ambiguous = scheduled && error.kind !== "auth" && !error.message.startsWith("Tokscale rejected the payload (HTTP");
        const reason = ambiguous ? "Scheduled upload outcome is uncertain. Verify the profile before retrying." : error.message;
        const blocked = error.kind !== "retry" || attempts >= 8 || ambiguous;
        if (scheduled && !ambiguous) delete state.pendingScheduledUpload;
        const backoff = Math.min(6 * 3600000, 60000 * 2 ** Math.min(attempts - 1, 12)) * (0.8 + Math.random() * 0.4);
        state.failures[day.date] = { digest: hash, attempts, blocked, nextAttemptAt: now.getTime() + Math.ceil(performance.now() - startedAt) + Math.max(backoff, error.retryAfterMs), reason };
        result.failed.push({ date: day.date, reason });
        if (error.kind === "auth") state.authBlocked = true;
        assertOwned();
        await saveState(config, state);
        // Avoid hammering an unavailable or incompatible service with every historical date.
        break;
      }
      assertOwned();
      await saveState(config, state);
    }
    if (scheduled && !result.failed.length && !result.deferred.length) {
      state.schedule.completedUtcDate = scheduledUtcDate;
      state.schedule.lastCheckedAt = now.toISOString();
      assertOwned();
      await saveState(config, state);
    }
    return { ...result, ...(scheduled ? { date, scheduledUtcDate } : {}) };
  });
}

export function startWorker(config, { yes = false, log = console.error } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await run(config, { yes });
      if (result.failed?.length || result.submitted?.length || result.status === "auth-blocked") log("[magpie-tokscale-import] " + JSON.stringify(result));
    } catch (error) { log("[magpie-tokscale-import] " + error.message); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 60000);
  timer.unref?.();
  return () => clearInterval(timer);
}
