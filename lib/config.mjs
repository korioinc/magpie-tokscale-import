import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

export const AUTH_PROVIDER = "tokscale-import";
// Tokscale stores meta.version in cli_version varchar(20); provenance carries the full package name.
export const VERSION = "magpie-import/0.1.4";

export function requireUTC(timezone) {
  if (timezone !== undefined && timezone !== "UTC") throw new Error("Only UTC aggregation is supported. Remove the timezone override or set it to UTC.");
  return "UTC";
}

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function configuration(options = {}, directory) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Plugin options must be an object.");
  for (const key of ["token", "apiKey", "apiToken", "key"]) {
    if (key in options) throw new Error("Do not store secrets in plugin options. Use Tokscale Import sign-in or TOKSCALE_API_TOKEN.");
  }
  const env = process.env;
  const configHome = isAbsolute(env.XDG_CONFIG_HOME || "") ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  const cacheHome = isAbsolute(env.XDG_CACHE_HOME || "") ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  const path = (value, fallback) => {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error("Configured paths must be nonempty strings.");
    return resolve(value ?? fallback);
  };
  const magpieDir = path(options.magpieDir ?? env.MAGPIE_DIR, directory || join(configHome, "magpie"));
  const timezone = requireUTC(options.timezone ?? env.TOKSCALE_TIMEZONE);
  const startDate = options.startDate ?? env.TOKSCALE_START_DATE;
  if (startDate !== undefined && !validDate(startDate)) throw new Error("startDate must be a real YYYY-MM-DD date.");
  let autoSubmit = options.autoSubmit;
  if (autoSubmit !== undefined && typeof autoSubmit !== "boolean") throw new Error("autoSubmit must be boolean.");
  if (env.TOKSCALE_AUTO_SUBMIT !== undefined) {
    if (!["true", "false"].includes(env.TOKSCALE_AUTO_SUBMIT)) throw new Error("TOKSCALE_AUTO_SUBMIT must be true or false.");
    autoSubmit = env.TOKSCALE_AUTO_SUBMIT === "true";
  }
  const account = options.account ?? env.TOKSCALE_ACCOUNT;
  if (account !== undefined && (typeof account !== "string" || !(account === AUTH_PROVIDER || account.startsWith(AUTH_PROVIDER + "#")))) throw new Error("Invalid Tokscale auth account selector.");
  return {
    magpieDir, timezone, startDate, autoSubmit, account,
    usageFile: path(options.usageFile ?? env.TOKSCALE_USAGE_FILE, join(magpieDir, "usage.jsonl")),
    stateDir: path(options.stateDir ?? env.TOKSCALE_STATE_DIR, join(magpieDir, "tokscale-import")),
    pricingFile: path(options.pricingFile ?? env.TOKSCALE_PRICING_FILE, join(cacheHome, "magpie", "models.json")),
    pricingExplicit: options.pricingFile !== undefined || env.TOKSCALE_PRICING_FILE !== undefined,
  };
}

export async function readJSON(path, optional = false) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw new Error("Cannot read valid JSON from " + path + ".", { cause: error });
  }
}

export async function credentials(config, { allowMissingAccount = false } = {}) {
  const envToken = process.env.TOKSCALE_API_TOKEN;
  if (envToken !== undefined) return { token: checkedToken(envToken), consent: config.autoSubmit === true, source: "environment" };
  const auth = await readJSON(join(config.magpieDir, "plugin-auth.json"), true);
  if (auth === undefined) return { consent: false };
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("Invalid Magpie authentication storage.");
  let entries = Object.entries(auth).filter(([id]) => id === AUTH_PROVIDER || id.startsWith(AUTH_PROVIDER + "#"));
  if (config.account) entries = entries.filter(([id]) => id === config.account);
  if (entries.length > 1) throw new Error("Multiple Tokscale accounts: set account or TOKSCALE_ACCOUNT explicitly.");
  if (!entries.length) {
    if (config.account && !allowMissingAccount) throw new Error("Selected Tokscale account not found.");
    return { consent: false };
  }
  const value = entries[0][1];
  if (value?.type !== "api") throw new Error("Tokscale sign-in must be an API key.");
  return { token: checkedToken(value.key), consent: config.autoSubmit ?? (value.metadata?.autoSubmit === undefined || value.metadata.autoSubmit === "yes"), source: "saved", account: entries[0][0] };
}

function checkedToken(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /\s/.test(value)) throw new Error("Invalid Tokscale API token. Update Tokscale Import sign-in or TOKSCALE_API_TOKEN.");
  return value;
}
