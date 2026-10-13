#!/usr/bin/env node
import { parseArgs } from "node:util";
import { configuration, credentials, validDate } from "./lib/config.mjs";
import { aggregate, payload } from "./lib/aggregate.mjs";
import { run, startWorker } from "./lib/worker.mjs";
import { verifyRecordedDay } from "./lib/reconcile.mjs";
import { loadState } from "./lib/state.mjs";

const help = `magpie-tokscale-import <preview|submit|verify|daemon|status> [options]
  preview                     Local-only completed daily snapshots; no authentication/network.
  submit --yes                Upload changed completed days, including missing history.
  verify --date YYYY-MM-DD     Recover an uncertain upload by profile GET only; never resubmit.
  daemon --yes                Check every minute while this process lives.
  status                      Show configuration and whether credentials/consent exist; no secrets.
  --date YYYY-MM-DD           Select one completed day (preview/submit/verify).
  --timezone UTC              UTC only; saved legacy timezone does not affect extraction.
  --start-date YYYY-MM-DD     Exclude earlier history.
  --magpie-dir PATH           Magpie config/usage/auth directory.
  --usage-file PATH           Full, unrotated usage.jsonl snapshot.
  --state-dir PATH            Durable state + cross-process lock directory.
  --pricing-file PATH         Local models.dev JSON catalog; never fetched by preview.
  --account PROVIDER[#slot]   Select a Tokscale Import sign-in account.
  --retry                     Unblock manually resolved permanent failures (submit only).
Environment: TOKSCALE_API_TOKEN, TOKSCALE_TIMEZONE, TOKSCALE_START_DATE,
  MAGPIE_DIR, TOKSCALE_STATE_DIR, TOKSCALE_USAGE_FILE, TOKSCALE_PRICING_FILE,
  TOKSCALE_ACCOUNT, TOKSCALE_AUTO_SUBMIT=true|false.
Credentials: Magpie Tokscale Import API-key sign-in, or TOKSCALE_API_TOKEN.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, yes: { type: "boolean" }, retry: { type: "boolean" },
    date: { type: "string" }, timezone: { type: "string" }, account: { type: "string" },
    "start-date": { type: "string" }, "magpie-dir": { type: "string" }, "usage-file": { type: "string" },
    "state-dir": { type: "string" }, "pricing-file": { type: "string" },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); }
  else {
    if (positionals.length !== 1 || !["preview", "submit", "verify", "daemon", "status"].includes(command)) throw new Error("Unknown command. Run --help.");
    if (values.retry && command !== "submit") throw new Error("--retry is only valid with submit.");
    if (values.date && !["preview", "submit", "verify"].includes(command)) throw new Error("--date is only valid with preview/submit/verify.");
    if (command === "verify" && !validDate(values.date)) throw new Error("verify requires --date YYYY-MM-DD.");
    const config = configuration({
      timezone: values.timezone, account: values.account, startDate: values["start-date"],
      magpieDir: values["magpie-dir"], usageFile: values["usage-file"], stateDir: values["state-dir"], pricingFile: values["pricing-file"],
    });
    if (command === "preview") {
      const snapshot = await aggregate(config, { date: values.date });
      console.log(JSON.stringify({ ...snapshot, contributions: undefined, payloads: snapshot.contributions.map(day => payload(day)) }, null, 2));
    } else if (command === "verify") {
      const result = await verifyRecordedDay(config, values.date);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "verified") process.exitCode = 1;
    } else if (command === "status") {
      await loadState(config);
      const auth = await credentials(config);
      console.log(JSON.stringify({ ...config, configured: !!auth.token, consent: auth.consent }, null, 2));
    } else {
      if (!values.yes) throw new Error("Upload requires --yes. Review preview first; uploaded usage may appear on your public Tokscale profile.");
      if (command === "submit") {
        const result = await run(config, { yes: true, date: values.date, retry: values.retry });
        console.log(JSON.stringify(result, null, 2));
        if (result.failed?.length || !["complete", "locked"].includes(result.status)) process.exitCode = 1;
      } else {
        const stop = startWorker(config, { yes: true });
        const keepAlive = setInterval(() => {}, 3600000);
        for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); clearInterval(keepAlive); });
      }
    }
  }
} catch (error) {
  console.error("magpie-tokscale-import: " + error.message);
  process.exitCode = 1;
}
