# magpie-tokscale-import

Want your Magpie usage to appear on Tokscale without exporting it by hand? **magpie-tokscale-import** uploads daily usage snapshots after you save your API key. It runs inside Magpie and reports results in the host logs. No separate service or Tokscale CLI is required.

## Installation

### 1. Add the plugin

Install [Magpie](https://usemagpie.ai), then open **Plugins → Add a plugin** and enter:

```text
github:korioinc/magpie-tokscale-import
```

Or use the Magpie CLI:

```sh
magpie plugin add github:korioinc/magpie-tokscale-import
```

Magpie installs the package and its dependencies and manages the Bun plugin runtime. No manual checkout or build is needed. The standalone CLI requires Node.js 22 or later.

### 2. Connect Tokscale

1. Create a token in [Tokscale Settings → API Tokens](https://tokscale.ai/settings).
2. In Magpie, open **Plugins → magpie-tokscale-import → Sign in**.
3. Read the daily public-upload notice, enter your API token, and save it. There is no separate Yes/No step.

**Saving your API key enables daily uploads to your public Tokscale profile.** It does not validate the token with Tokscale or trigger an immediate upload. An explicit `autoSubmit: false` setting keeps uploads disabled. If `TOKSCALE_API_TOKEN` overrides saved keys, it still requires `autoSubmit: true`.

An earlier **No — save token only** choice remains disabled until you sign in again and save the key, or explicitly enable `autoSubmit`.

### 3. Check the first upload

The first active check records the current UTC date. Uploads begin at the next **00:00 UTC**, using the previous completed day. New installations aggregate dates in UTC. Earlier history is not uploaded automatically when you first enable the plugin or replace the token.

Look for `tokscale-import` in Magpie host logs. The plugin reports missing credentials, disabled uploads, schedule initialization, successful uploads, unchanged snapshots, empty days, and failures. It does not add a separate log viewer.

**The Magpie plugin host must be running.** Magpie starts the host on demand, so an open app alone does not guarantee a midnight run. After a restart, the plugin processes missed days in order.

## Privacy and safety

- **Uploaded usage may appear on your public Tokscale profile.** Only enable uploads if you agree to this.
- The plugin submits aggregated token counts, message counts, and estimated costs by date, client, provider, and model. It does not submit prompts or responses.
- Magpie stores API keys in an unencrypted authentication file with restricted permissions. Protect your configuration directory and backups.
- Do not put API tokens in plugin options or command-line arguments. Use Magpie sign-in or `TOKSCALE_API_TOKEN`.
- Do not submit the same usage through multiple tools or devices. Checkpoints prevent unchanged snapshots from being resent, but cannot coordinate independent submitters.
- Keep the complete usage history and checkpoint state. Uploads are blocked when a day’s per-client token totals fall below its saved checkpoint. Rotated usage files are not discovered automatically.
- Costs are API estimates from the available models.dev catalog, not subscription charges. Missing prices are reported as incomplete, not free usage.

## Configuration

The sign-in flow is enough for normal use. Advanced settings belong in the installed plugin entry’s `options` object in Magpie’s `plugins.json`. For example:

```json
{
  "autoSubmit": true,
  "timezone": "UTC"
}
```

`autoSubmit: true` is explicit consent to automatic uploads. Reload the plugin after changing settings.

| Option | Environment variable | Purpose |
| --- | --- | --- |
| `autoSubmit` | `TOKSCALE_AUTO_SUBMIT` | Enable or disable automatic uploads. The environment overrides the option. Saved API keys enable uploads by default; an earlier refusal remains disabled until you sign in again. |
| `timezone` | `TOKSCALE_TIMEZONE` | Aggregation timezone. Defaults to the saved timezone, or UTC for new state. The schedule always runs at 00:00 UTC. |
| `startDate` | `TOKSCALE_START_DATE` | Exclude history before a `YYYY-MM-DD` date. |
| `account` | `TOKSCALE_ACCOUNT` | Select a saved `tokscale-import` account. Required when more than one exists. |
| `magpieDir` | `MAGPIE_DIR` | Magpie configuration directory. The plugin uses the host directory; the CLI uses the standard Magpie configuration directory. |
| `usageFile` | `TOKSCALE_USAGE_FILE` | Complete usage history. Defaults to `usage.jsonl` in the Magpie configuration directory. |
| `stateDir` | `TOKSCALE_STATE_DIR` | Checkpoints and shared locks. Defaults to `tokscale-import` in the Magpie configuration directory. |
| `pricingFile` | `TOKSCALE_PRICING_FILE` | models.dev catalog. Defaults to Magpie’s cached `models.json`. |
| — | `TOKSCALE_API_TOKEN` | Override saved credentials. Automatic uploads still require explicit consent. |

Except for `autoSubmit`, explicit options take precedence over their environment variables.

**Do not change the timezone of existing submissions without a migration plan.** A mismatch with saved state stops uploads. Changing only the setting or deleting checkpoints can cause overlaps with existing Tokscale records.

## Optional CLI

For previews, manual uploads, and recovery, install the CLI from GitHub with Node.js 22 or later and npm:

```sh
npm install --global github:korioinc/magpie-tokscale-import
magpie-tokscale-import --help
```

Use the same Magpie configuration and checkpoint state as the plugin. If needed, set `--magpie-dir` and `--state-dir`. Run `magpie-tokscale-import status` to check configuration and whether credentials and consent exist.

Replace the example date with the completed UTC day you want to inspect:

```sh
# Preview a day without authentication or network access.
magpie-tokscale-import preview --date 2026-01-01 --timezone UTC

# Upload that day only after reviewing the preview.
magpie-tokscale-import submit --date 2026-01-01 --timezone UTC --yes

# Check an uncertain upload against the profile without resubmitting usage.
magpie-tokscale-import verify --date 2026-01-01 --timezone UTC
```

**Omitting `--date` from `submit --yes` uploads all changed completed days, including missing history.** The optional `daemon --yes` command also checks historical usage. Neither is needed for the plugin’s daily schedule.

## Troubleshooting

**No upload yet:** Check that the plugin host is running, a token is saved, and automatic uploads are enabled. The first upload waits until the next UTC midnight. An empty completed day produces no upload.

**Authentication rejected:** Replace the token in Magpie. If `TOKSCALE_API_TOKEN` is set, update or remove it too: it overrides saved keys.

**Uncertain scheduled upload:** A timeout or ambiguous response can mean Tokscale received the data. The plugin blocks automatic replay. Use `verify` with the same token, date, and checkpoint state. Verification uses profile reads only and records success only when the snapshot matches; it does not recover the original submission receipt. A mismatch leaves the block in place.

**Resolved permanent failure:** `submit --yes --retry` can unblock manually resolved failures. It does not bypass Retry-After delays or uncertain scheduled-upload protection. Preview first and include `--date` to limit the upload.

**Disable uploads:** Set `autoSubmit` to `false` or `TOKSCALE_AUTO_SUBMIT=false`, then reload the plugin. Removing the saved token also stops future checks unless an environment token remains. Requests already in flight may complete. Removing credentials does not revoke the Tokscale token or delete uploaded records.

Tokscale API changes may require a plugin update. Imported history is not guaranteed to be excluded from leaderboards.

## Releases

Pushing a stable version tag such as `v1.0.1` runs the release workflow. It checks version consistency, runs the tests, and attaches an npm `.tgz` package to a GitHub Release with generated release notes. It does not publish to the npm registry.

To publish a release:

1. Update `package.json` and `package-lock.json` with `npm version 1.0.1 --no-git-tag-version`.
2. Set `VERSION` in `lib/config.mjs` to `magpie-import/1.0.1`. The complete value must fit in 20 characters.
3. Commit and merge the changes, including `.github/workflows/release.yml`, into `main`.
4. Tag the updated `main` commit and push the tag:

```sh
git switch main
git pull --ff-only origin main
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

Replace `1.0.1` with the intended version everywhere. The tag must match all three version files. Prerelease tags such as `v1.0.1-beta.1` are not supported.

The workflow uses the repository’s built-in `GITHUB_TOKEN`; no additional secret is required. GitHub Actions must be enabled. If a run fails, rerun it from the Actions page rather than moving the tag. Retries finish an existing draft; an already published release is left unchanged. Never move a published version tag.

## License

[MIT](LICENSE).
