import { AUTH_PROVIDER, configuration } from "./lib/config.mjs";
import { DAILY_UPLOAD_TIME, startDailyScheduler } from "./lib/scheduler.mjs";
import { run } from "./lib/worker.mjs";

export default {
  id: "magpie-tokscale-import",
  async server(input, options = {}) {
    if (input?.project?.id !== "magpie") throw new Error("This plugin needs Magpie usage.jsonl. Use the standalone CLI outside Magpie.");
    const settings = configuration(options, input.directory);
    let stopScheduler, lastLog;
    const log = async (message, level = "info") => {
      if (message === lastLog) return;
      try {
        await input.client.app.log({ body: { service: "tokscale-import", level, message } });
      } catch {
        // Do not expose logger errors, which may contain request data.
        console.error("[tokscale-import] " + message);
      }
      lastLog = message;
    };
    return {
      async config(config) {
        config.provider ??= {};
        config.provider[AUTH_PROVIDER] ??= { name: "Tokscale Import", models: {} };
        // Each host may check; the worker's shared disk lock/checkpoints prevent duplicate submissions.
        stopScheduler ??= startDailyScheduler(async now => {
          const result = await run(settings, { scheduled: true, now });
          if (["not-due", "locked"].includes(result.status) && !result.verification) return;
          const level = result.failed?.length || result.status === "auth-blocked" ? "error"
            : result.deferred?.length || (result.verification && result.verification.status !== "verified") ? "warn" : "info";
          await log(JSON.stringify(result), level);
        }, message => log(message, "error"));
      },
      auth: {
        provider: AUTH_PROVIDER,
        methods: [{
          type: "api",
          label: process.env.TOKSCALE_API_TOKEN !== undefined
            ? `API key — TOKSCALE_API_TOKEN overrides saved keys. Daily public uploads are ${settings.autoSubmit === true ? `enabled (${DAILY_UPLOAD_TIME} UTC)` : "disabled; set autoSubmit to true to enable"}.`
            : settings.autoSubmit === false
              ? "API key — automatic uploads are disabled by configuration."
              : `API key — saving enables daily uploads to your public Tokscale profile at ${DAILY_UPLOAD_TIME} UTC.`,
          placeholder: "Create an API token at https://tokscale.ai/settings",
        }],
      },
    };
  },
};
