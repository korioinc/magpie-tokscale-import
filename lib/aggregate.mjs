import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { VERSION, readJSON, validDate } from "./config.mjs";

// Tokscale upstream bd62b8c; unknown callers are never inferred from model names.
const CLIENTS = new Set("opencode claude codex mcode copilot gemini cursor amp codebuff freebuff droid openclaw hermes pi kimi qwen roocode kilocode kilo mux crush goose antigravity kiro zed trae warp cline synthetic gjc 9router grok jcode commandcode micode antigravity-cli antigravity-extension junie zcode opencodereview codebuddy workbuddy devin-cli devin-desktop senpi augment kimchi reasonix prime-agent cherrystudio dsh fx omp lmstudio unsloth hindsight micode-desktop muse".split(" "));
const ALIASES = { "claude-code": "claude", "claude code": "claude", "hermes-agent": "hermes", "pi-coding-agent": "pi", kilocode: "kilo" };
const BUCKETS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const emptyTokens = () => Object.fromEntries(BUCKETS.map(key => [key, 0]));
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const priceNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sum = tokens => BUCKETS.reduce((value, key) => value + tokens[key], 0);

export function dateInZone(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = type => parts.find(p => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function yesterday(now, timezone) {
  const today = dateInZone(now, timezone);
  return new Date(new Date(today + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
}

export function normalize(record, timezone) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid record.");
  if (typeof record.t !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(record.t) || !validDate(record.t.slice(0, 10))) throw new Error("Invalid timestamp.");
  const time = new Date(record.t);
  if (!Number.isFinite(time.getTime())) throw new Error("Invalid timestamp.");
  const counts = ["in", "out", "cache_read", "cache_write", "cache_write_1h", "reasoning"].map(key => record[key] ?? 0);
  if (!counts.every(safeInteger)) throw new Error("Invalid tokens.");
  const [input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning] = counts;
  if (reasoning > output || cacheWrite1h > cacheWrite) throw new Error("Overlapping token counts are inconsistent.");
  const tokens = { input, output: output - reasoning, cacheRead, cacheWrite, reasoning };
  if (!safeInteger(sum(tokens))) throw new Error("Token total overflow.");
  if ((record.rejected !== undefined && typeof record.rejected !== "boolean") || (record.handed_on !== undefined && typeof record.handed_on !== "boolean")) throw new Error("Invalid attempt flags.");
  if (record.rejected || (!record.provider && record.status >= 400) || !sum(tokens)) return { excluded: "zeroOrRejected" };
  if (typeof record.agent !== "string") return { excluded: "unknownAgent", tokens: sum(tokens) };
  const agent = record.agent.toLowerCase().trim().replace(/@wsl:.+$/, "");
  const client = ALIASES[agent] ?? agent;
  if (!CLIENTS.has(client) && !/^cc-mirror\/[a-z0-9][a-z0-9._-]{0,95}$/.test(client)) return { excluded: "unknownAgent", tokens: sum(tokens) };
  const model = record.served || record.model;
  if (typeof model !== "string" || !model.trim() || model.length > 512 || typeof record.provider !== "string" || !record.provider || record.provider.length > 256) return { excluded: "unknownModel", tokens: sum(tokens) };
  return { date: dateInZone(time, timezone), client, model: model.trim(), provider: record.provider, tokens, cacheWrite1h, rawOutput: output, messages: record.handed_on ? 0 : 1 };
}

async function pricing(config) {
  let raw;
  try { raw = await readFile(config.pricingFile); }
  catch (error) {
    if (error.code === "ENOENT" && !config.pricingExplicit) return { models: {}, metadata: { available: false } };
    throw new Error("Cannot read pricing catalog " + config.pricingFile + ".", { cause: error });
  }
  let models;
  try { models = JSON.parse(raw); } catch { throw new Error("Invalid models.dev pricing catalog."); }
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Invalid pricing catalog.");
  return { models, metadata: { available: true, sha256: createHash("sha256").update(raw).digest("hex"), source: config.pricingFile } };
}

function requestCost(record, catalog) {
  const provider = { codex: "openai", claude: "anthropic", gemini: "google" }[record.provider] ?? record.provider;
  const model = catalog[provider]?.models?.[record.model];
  const base = model?.cost;
  if (!base || !priceNumber(base.input) || !priceNumber(base.output)) return undefined;
  let rates = base;
  if (base.tiers !== undefined) {
    if (!Array.isArray(base.tiers)) return undefined;
    const tiers = [];
    for (const tier of base.tiers) {
      if (!tier || typeof tier !== "object") return undefined;
      if (tier.tier && tier.tier.type !== "context") return undefined;
      const above = tier.tier?.size ?? tier.above;
      if (!safeInteger(above) || !above) return undefined;
      const selected = { ...base, ...tier };
      if (["input", "output", "cache_read", "cache_write", "cache_write_1h"].some(key => selected[key] !== undefined && !priceNumber(selected[key]))) return undefined;
      tiers.push({ above, selected });
    }
    for (const tier of tiers.sort((a, b) => a.above - b.above)) {
      if (record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite > tier.above) rates = tier.selected;
    }
  }
  const oneHour = rates.cache_write_1h ?? (provider === "anthropic" && record.model.toLowerCase().includes("claude") ? rates.input * 2 : undefined);
  const items = [
    [record.tokens.input, rates.input], [record.rawOutput, rates.output],
    [record.tokens.cacheRead, rates.cache_read],
    [record.tokens.cacheWrite - record.cacheWrite1h, rates.cache_write], [record.cacheWrite1h, oneHour],
  ];
  if (items.some(([tokens, rate]) => tokens > 0 && !priceNumber(rate))) return undefined;
  const cost = items.reduce((value, [tokens, rate]) => value + (tokens ? tokens * rate : 0), 0) / 1e6;
  return priceNumber(cost) ? cost : undefined;
}

async function* lines(path) {
  let pending = Buffer.alloc(0);
  // Re-read full snapshots: rotations/truncation cannot turn a byte offset into lost history.
  for await (const chunk of createReadStream(path)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    let index;
    while ((index = pending.indexOf(10, offset)) !== -1) {
      if (index - offset > 1024 * 1024) throw new Error("Usage line exceeds 1 MiB.");
      yield pending.subarray(offset, index).toString("utf8");
      offset = index + 1;
    }
    pending = pending.subarray(offset);
    if (pending.length > 1024 * 1024) throw new Error("Usage line exceeds 1 MiB.");
  }
  // Magpie appends newline last: never parse an unfinished final record.
  if (pending.length) yield null;
}

export async function aggregate(config, { now = new Date(), date } = {}) {
  if (date !== undefined && !validDate(date)) throw new Error("date must be a real YYYY-MM-DD date.");
  const state = await readJSON(`${config.stateDir}/state.json`, true);
  const timezone = config.timezone ?? state?.timezone ?? "UTC";
  if (state?.timezone && config.timezone && state.timezone !== config.timezone) throw new Error("Timezone differs from persisted history. Use a separate state directory and migration plan.");
  const through = yesterday(now, timezone);
  if (date && date > through) throw new Error("Only completed dates can be previewed or submitted.");
  const prices = await pricing(config);
  const days = new Map();
  const diagnostics = { records: 0, malformed: 0, partial: 0, duplicates: 0, zeroOrRejected: 0, unknownAgent: 0, unknownModel: 0, excludedTokens: 0, unpricedRecords: 0, unpricedTokens: 0 };
  const seen = new Set();
  for await (const line of lines(config.usageFile)) {
    if (line === null) { diagnostics.partial++; continue; }
    if (!line.trim()) continue;
    diagnostics.records++;
    let raw, record;
    try { raw = JSON.parse(line); record = normalize(raw, timezone); }
    catch { diagnostics.malformed++; continue; }
    if (record.excluded) {
      diagnostics[record.excluded]++;
      diagnostics.excludedTokens += record.tokens ?? 0;
      continue;
    }
    if (record.date > through || (config.startDate && record.date < config.startDate) || (date && record.date !== date)) continue;
    // Only exact copies with vendor IDs are deduplicated. IDs/route alone may cover distinct paid attempts.
    if (raw.rid || raw.response_id) {
      const hash = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
      if (seen.has(hash)) { diagnostics.duplicates++; continue; }
      seen.add(hash);
    }
    const cost = requestCost(record, prices.models);
    let day = days.get(record.date);
    if (!day) {
      day = { date: record.date, totals: { tokens: 0, cost: 0, messages: 0, costIsComplete: true }, intensity: 0, tokenBreakdown: emptyTokens(), groups: new Map() };
      days.set(record.date, day);
    }
    if (cost === undefined) {
      diagnostics.unpricedRecords++;
      diagnostics.unpricedTokens += sum(record.tokens);
      day.totals.costIsComplete = false;
    }
    const key = JSON.stringify([record.client, record.provider, record.model]);
    let group = day.groups.get(key);
    if (!group) {
      group = { client: record.client, modelId: record.model, providerId: record.provider, tokens: emptyTokens(), cost: 0, messages: 0 };
      day.groups.set(key, group);
    }
    for (const bucket of BUCKETS) {
      group.tokens[bucket] += record.tokens[bucket];
      day.tokenBreakdown[bucket] += record.tokens[bucket];
    }
    group.cost += cost ?? 0;
    group.messages += record.messages;
    day.totals.tokens += sum(record.tokens);
    day.totals.cost += cost ?? 0;
    day.totals.messages += record.messages;
    if (!safeInteger(day.totals.tokens) || !safeInteger(day.totals.messages) || !priceNumber(day.totals.cost)) throw new Error("Daily aggregation overflow.");
  }
  const contributions = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ groups, ...day }) => ({ ...day, clients: [...groups.values()].sort((a, b) => JSON.stringify([a.client, a.providerId, a.modelId]).localeCompare(JSON.stringify([b.client, b.providerId, b.modelId]))) }));
  return { timezone, through, contributions, diagnostics, pricing: prices.metadata };
}

export function payload(day, now = new Date()) {
  const active = day.totals.tokens > 0 ? 1 : 0;
  const contribution = { ...day, intensity: day.totals.cost > 0 ? 4 : 0 };
  return {
    meta: { generatedAt: now.toISOString(), version: VERSION, dateRange: { start: day.date, end: day.date } },
    summary: { totalTokens: day.totals.tokens, totalCost: day.totals.cost, totalDays: 1, activeDays: active, averagePerDay: active ? day.totals.cost : 0, maxCostInSingleDay: day.totals.cost, clients: [...new Set(day.clients.map(c => c.client))].sort(), models: [...new Set(day.clients.map(c => c.modelId))].sort() },
    years: [{ year: day.date.slice(0, 4), totalTokens: day.totals.tokens, totalCost: day.totals.cost, range: { start: day.date, end: day.date } }],
    contributions: [contribution],
    provenance: { origin: "backfill", importer: "magpie-tokscale-import" },
  };
}
