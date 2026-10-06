# Contributing

Thanks for helping. Bug reports, fixes and support for more apps are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Keep each pull request to one change.

## What's in this repo

| Path | What |
|---|---|
| `plugins/bitfrost/` | The Claude Code plugin. Installing it installs everything below. |
| `plugins/bitfrost/hooks/register.js` | The plugin code. It starts the helper, adds the models as subagents, and plays each model's work into Claude's subagent view. |
| `plugins/bitfrost/daemon/` | The helper, `bitfrostd`. `provider.ts` is what every provider implements, `providers/` has one file per app (`codex.ts`, `zcode.ts`, ...), and `registry.ts` picks the models and their short names. |
| `plugins/bitfrost/hooks/register.test.ts` | Tests for the plugin code against a fake helper, run by Claude Code's plugin test kit (`npm run test:plugin`). |
| `plugins/bitfrost/daemon/test/` | Tests that replay recorded app output through each provider, and one that runs the helper itself against a fake Codex (`npm run test:daemon`). They are named `*.spec.ts` so the plugin test kit leaves them alone. `npm test` runs both suites. |
| `plugins/bitfrost/bin/bitfrostd` | Starts the helper and finds a usable Node. The `bitfrost` command links to it. |
| `release/install.sh` | The installer, attached to every release as is. |
| `release/build.sh` | Builds `dist/bitfrost-<version>.tar.gz` and its `.sha256`. |
| `.github/workflows/release.yml` | Tests every pull request. On main, makes a release when the version in `plugin.json` has none yet. |

## Installing from a checkout

To work on BitFrost itself, install the plugin from your checkout:

```
claude plugin marketplace add /path/to/bitfrost
claude plugin install bitfrost@bitfrost --scope user
```

## Ground rules

These are what keep BitFrost within each company's terms. Changes that break them won't be merged.

- Never read, copy, store or send anyone's credentials or tokens. Each company's own app signs in and makes every model request.
- Never pretend to be another company's app or client, and never call a company's API directly in place of its app.
- Don't try to get around rate limits, quotas or access rules.
- Keep the profile check: only profiles in `allowedProfiles` may use BitFrost.
- Permission requests from a subagent go to the user, and no answer means Deny. The one exception is auto mode, which the user turns on (in Claude, or with the Switch to auto button): then a separate review decides, as Claude Code's auto mode does. Never let the agent that spawned the subagent, or the subagent itself, answer them.

## Code

- The helper (`plugins/bitfrost/daemon/`) is TypeScript that Node runs directly. Use only syntax Node can strip (no enums, no namespaces, no parameter properties).
- The plugin (`plugins/bitfrost/hooks/register.js`) runs inside Claude Code. Run `claude plugin validate plugins/bitfrost` before sending a change.
- Match the style of the code around you. Comment why, not what.
- Test against the real apps where you can, and say in the pull request what you tried.

## Adding a provider

A provider is an app BitFrost can hand work to. Each one is a file in `plugins/bitfrost/daemon/providers/` that exports a `ProviderFactory`, listed in `providers/index.ts`. Nothing else needs to change: the plugin only sees the events in `daemon/events.ts`.

1. Implement `Provider` from `daemon/provider.ts`: start a session, send follow-ups, interrupt, list models, and answer approvals and questions.
2. Turn the app's output into BitFrost's events. A `usage` event is one model request, and its `inputTokens` is the context size at that request. Never send a turn's total: Claude Code reads it as the context size and compacts the subagent.
3. Every action the app would ask its user about must become an `approval_requested` event and wait for the answer. Set `tool` and `input` when the action matches a Claude Code tool (a shell command is `Bash` with `command`), so the user's permission rules and auto mode work. If the app can only route some actions this way, set `capabilities.gates` to `'destructive'` and say so in GUIDE.md.
4. If the app runs a different model than the one asked for, stop the turn and say so.
5. Never call the app's login or `authenticate` step, and never read its credential files. If it isn't signed in, fail with a message naming its own login command.
6. Set `vendor` if the app is one company's own. Apps that serve many companies' models (opencode) start with `optIn: true`, so they stay off until the user turns them on.
7. Add a replay test: record the app's raw output with `BITFROST_RECORD_DIR=<dir>` set on the helper, keep a small run as a fixture under `daemon/test/fixtures/<provider>/`, and check the events it gives.
8. Bump the plugin version. A running helper is only replaced by a newer version number.

## Releases

The version in `plugins/bitfrost/.claude-plugin/plugin.json` is the version of everything: plugin, helper and release. When a change reaches main with a version that has no release yet, CI tests it and makes release `v<version>` with `bitfrost-<version>.tar.gz`, its `.sha256`, and `release/install.sh`. A change that doesn't bump the version is tested but not released. To try a release locally, run `release/build.sh`, then `sh release/install.sh --from dist/bitfrost-<version>.tar.gz`.

## License

By contributing, you agree that your work is released under the GPL-3.0-only license, as in [LICENSE](LICENSE).
