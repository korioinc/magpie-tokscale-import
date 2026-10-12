import { createHash } from "node:crypto";
import { credentials } from "./config.mjs";
import { aggregate } from "./aggregate.mjs";
import { locked, loadState, saveState } from "./state.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const buckets = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

async function getJSON(url, token) {
  const response = await fetch(url, { headers: token ? { authorization: "Bearer " + token } : {}, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Profile verification unavailable.");
  if (!response.body) throw new Error("Profile verification response empty.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) { await reader.cancel().catch(() => {}); throw new Error("Profile verification response too large."); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid profile verification response; no checkpoint was recovered."); }
}

function sameDay(local, remote) {
  if (!remote || remote.date !== local.date || remote.totals?.tokens !== local.totals.tokens || remote.totals?.cost !== local.totals.cost || !Array.isArray(remote.clients)) return false;
  if (buckets.some(key => remote.tokenBreakdown?.[key] !== local.tokenBreakdown[key])) return false;
  const expected = new Map();
  for (const row of local.clients) {
    let client = expected.get(row.client);
    if (!client) {
      client = { tokens: Object.fromEntries(buckets.map(key => [key, 0])), messages: 0, cost: 0, models: new Map() };
      expected.set(row.client, client);
    }
    for (const key of buckets) client.tokens[key] += row.tokens[key];
    client.messages += row.messages;
    client.cost += row.cost;
    let model = client.models.get(row.modelId);
    if (!model) {
      model = { tokens: 0, cost: 0, messages: 0, ...Object.fromEntries(buckets.map(key => [key, 0])) };
      client.models.set(row.modelId, model);
    }
    model.tokens += buckets.reduce((n, key) => n + row.tokens[key], 0);
    model.cost += row.cost;
    model.messages += row.messages;
    for (const key of buckets) model[key] += row.tokens[key];
  }
  if (remote.clients.length !== expected.size) return false;
  const checked = new Set();
  for (const row of remote.clients) {
    const client = expected.get(row.client);
    if (!client || checked.has(row.client) || row.messages !== client.messages || row.cost !== client.cost || buckets.some(key => row.tokens?.[key] !== client.tokens[key]) || !row.models || Object.keys(row.models).length !== client.models.size) return false;
    checked.add(row.client);
    for (const [id, model] of client.models) {
      const actual = row.models[id];
      if (!actual || ["tokens", "cost", "messages", ...buckets].some(key => actual[key] !== model[key])) return false;
    }
  }
  return true;
}

// Recovery only: verify a previously unacknowledged upload by GET, never POST usage.
export async function verifyRecordedDay(config, date) {
  return locked(config, async assertOwned => {
    const state = await loadState(config);
    const auth = await credentials(config);
    const failure = state.failures[date];
    const uncertainSchedule = failure?.reason === "Scheduled upload outcome is uncertain. Verify the profile before retrying." && state.pendingScheduledUpload?.date === date && state.pendingScheduledUpload.digest === failure.digest;
    if (!auth.token || !failure || !failure.blocked || (failure.reason !== "Unexpected Tokscale response; success not confirmed." && !uncertainSchedule) || state.tokenDigest !== digest(auth.token)) return { status: "not-eligible" };
    const snapshot = await aggregate({ ...config, timezone: state.timezone }, { date });
    const day = snapshot.contributions[0];
    if (!day || digest(day) !== failure.digest) return { status: "snapshot-changed" };
    const identity = await getJSON("https://tokscale.ai/api/auth/token", auth.token);
    if (typeof identity.user?.username !== "string" || !identity.user.username) throw new Error("Profile identity not verified.");
    const profile = await getJSON("https://tokscale.ai/api/users/" + encodeURIComponent(identity.user.username));
    if (profile.user?.username !== identity.user.username) return { status: "identity-mismatch" };
    if (typeof profile.stats?.costIsComplete === "boolean" && profile.stats.costIsComplete !== day.totals.costIsComplete) return { status: "cost-completeness-mismatch" };
    const rows = Array.isArray(profile.contributions) ? profile.contributions.filter(value => value.date === date) : [];
    if (rows.length !== 1 || !sameDay(day, rows[0])) return { status: "profile-mismatch" };
    if (digest((await credentials(config)).token) !== state.tokenDigest) throw new Error("Credentials changed during verification.");
    const current = await aggregate({ ...config, timezone: state.timezone }, { date });
    if (digest(current.contributions[0]) !== failure.digest) return { status: "snapshot-changed" };
    assertOwned();
    const clientTokens = {};
    for (const row of day.clients) clientTokens[row.client] = (clientTokens[row.client] ?? 0) + buckets.reduce((n, key) => n + row.tokens[key], 0);
    state.days[date] = { digest: failure.digest, clientTokens, submittedAt: new Date().toISOString(), mode: "verified-profile" };
    delete state.failures[date];
    if (uncertainSchedule) delete state.pendingScheduledUpload;
    await saveState(config, state);
    return { status: "verified", date, tokens: day.totals.tokens, clients: Object.keys(clientTokens) };
  });
}
