# BitFrost Guide

## Setup

### Codex

Install and sign in to the Codex CLI or the ChatGPT desktop app. Nothing else to do.

BitFrost checks the standalone CLI, the desktop app's downloaded CLI releases,
and its bundled CLI. On macOS, it looks for ChatGPT in `/Applications` and
`~/Applications`, including the signed CLI inside `Contents/Resources/codex-cli`.

### ZCode (GLM)

Sign in to ZCode's command-line tool once. On Linux (change `/opt/ZCode` if ZCode is elsewhere):

```
ELECTRON_RUN_AS_NODE=1 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/opt/ZCode/resources/config/provider/zcode-builtin.json /opt/ZCode/zcode /opt/ZCode/resources/glm/zcode.cjs login
```

On macOS (change `/Applications/ZCode.app` if ZCode is elsewhere):

```sh
ELECTRON_RUN_AS_NODE=1 \
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json" \
  "/Applications/ZCode.app/Contents/MacOS/ZCode" \
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" login
```

BitFrost finds ZCode in `/Applications`, `~/Applications`, or `/opt/ZCode`, and
through a `zcode` executable on PATH. A custom `providers.zcode.dir` or
`BITFROST_ZCODE_DIR` can name the Linux install directory or the macOS `.app` bundle.

Then run `bitfrost setup zcode` once. Without it, GLM can't ask you for permission and is refused instead.

### OpenCode, Oh My Pi, Gemini CLI, Crush

Sign in to the app first (`opencode auth login`, `omp`, `gemini`, or `crush login` and Crush's own provider setup). Then open the config screen (`bitfrost config`), turn the app on and pick its models. Or do the same by hand in `~/.config/bitfrost/config.json`:

```json
{
  "providers": {
    "opencode": { "enabled": true, "models": ["deepseek/*"] },
    "omp": { "enabled": true, "models": ["deepseek/deepseek-v4-pro"] },
    "gemini": { "enabled": true },
    "crush": { "enabled": true, "models": ["opencode-go/glm-5.3"] }
  }
}
```

OpenCode, Oh My Pi and Crush need `models`: only the models listed there are offered. `*` works as a wildcard. Gemini CLI offers all its models unless you name ones to skip.

Any model they list can be offered, Claude, GPT, GLM and Gemini included. A Claude model needs a pattern that names it, like anthropic/* or its full id. A bare * doesn't turn Claude models on. Claude models get no short names, so names like sonnet keep meaning Claude Code's own models. If Codex, ZCode or Gemini CLI also offers that model, theirs keeps the short name, like glm, and the copy is named after its model id, like opencode-go-glm-5-3.

### Grok Build

Sign in to the Grok CLI (`grok login`). Then open the config screen (`bitfrost config`) and turn Grok Build on. Or do the same by hand in `~/.config/bitfrost/config.json`:

```json
{ "providers": { "grok": { "enabled": true } } }
```

It offers all its Grok models without a `models` list. No setup step. BitFrost runs it in always-approve mode and gates every action itself, so reads and edits inside the task folder run without asking; other commands and actions ask you. Its own subagents and scheduled runs are refused.

### Antigravity

Sign Antigravity in with an API key or a business account (an enterprise, Workspace or Google Cloud account). A personal Google account, or any sign-in BitFrost doesn't recognize as an API key or business account, won't work with BitFrost, because Antigravity's terms don't allow using it through another tool while it is signed in to a personal account. Then open the config screen (`bitfrost config`) and turn Antigravity on. Or do the same by hand in `~/.config/bitfrost/config.json`:

```json
{ "providers": { "agy": { "enabled": true } } }
```

Turning it on installs a small BitFrost bridge plugin into `~/.gemini/config/plugins/bitfrost-bridge`, so there is no setup step. If BitFrost ever says the bridge is missing, run `bitfrost setup agy`. The plugin does nothing in your own `agy` sessions and is removed by `bitfrost uninstall`. Reads and edits inside the task folder run without asking; commands and other actions ask you. Its subagents, agent messaging, workflows and schedules are refused.

It offers Gemini models, for example Gemini 3.8 Flash with effort low, medium and high, and gpt-oss. Antigravity's separate per-effort model ids show as one model with efforts, and its Claude models stay off until you turn them on in the config screen, or name them in `"anthropic": [...]` under `providers.agy`. Without a current bridge, BitFrost keeps Antigravity's permission prompts on, so actions that need permission are refused.

### Why did my Antigravity models disappear?

BitFrost checks how each Antigravity run signed in, before the first prompt and again before each model request. If that run used a personal Google account, a sign-in BitFrost doesn't recognize, or BitFrost can't tell how it signed in, BitFrost stops it and the task fails with a message saying why. The model listing does the same check, so with a personal sign-in the Antigravity models drop out of Claude's list of subagents and the Models page shows the reason. There is no setting to override this.

Switch Antigravity to an API key or a business account and it works again from the next run. The models come back within about 10 minutes, or right away after a refresh on the BitFrost Models page. Note that an API key set only in a shell rc file may not reach the BitFrost helper if it was started from the desktop app; the key must be in the environment the helper runs in.

### Custom Claude profiles

Run the installer with `CLAUDE_CONFIG_DIR` set to your profile to install the plugin there:

```sh
curl -fsSL https://github.com/SavaSoftworks/BitFrost/releases/latest/download/install.sh | CLAUDE_CONFIG_DIR="$HOME/.claude-other" sh
```

Add `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to the `env` block of that profile's `settings.json`.

Also list the profile on the config screen's Settings page, or in `allowedProfiles` in `~/.config/bitfrost/config.json`:

```json
{ "allowedProfiles": ["~/.claude", "~/.claude-other"] }
```

Profiles not listed get no subagents.

### Choosing settings

Use Settings in `bitfrost config` to manage Claude profiles, official handback, history retention and app locations. `bitfrost setup` asks about options you haven't chosen; `bitfrost setup handback` lets you change handback.

The installer and `bitfrost update` ask about new options. Updates from the TUI leave them for **Configure new settings** on Home. Use Up/Down or W/S to choose an answer, Left/Right or A/D to revisit steps, and Enter/E to continue. Review your choices and save at the final step; cancelling leaves them unanswered. You can also run `bitfrost setup` later. New optional features remain disabled until configured. Claude mentions unchosen settings once.

### How do I open the config screen?

Run `bitfrost config`, or just `bitfrost` in a terminal. Models manages providers, models and usage statistics; Settings manages configuration; Status shows sessions and daemon activity. Press Tab, or your controller's left shoulder button, to view controls. Gamepads are supported on Linux.

If the interface can't open on your platform, BitFrost prints help and tells you to edit `~/.config/bitfrost/config.json`.

### How do I turn a model on or off?

On the Models page, pick an app, then pick a model. Apps serving their own company's models, like Codex, ZCode and Gemini CLI, offer every model unless you turn them off, which adds the model to `providers.<app>.disabled`:

```json
{ "providers": { "codex": { "disabled": ["gpt-5-mini"] } } }
```

Apps serving many companies' models, like OpenCode, Oh My Pi and Crush, only offer the models you list, so turning one on adds it:

```json
{ "providers": { "opencode": { "models": ["deepseek/*"] } } }
```

`*` works as a wildcard. Configuration reloads automatically; start a new Claude session to refresh its available models.

### Why is an app dimmed on the Models page?

That app isn't installed, or BitFrost can't find it. Install and sign in to it, then open the screen again. You can also set where it lives in the screen's Settings page, or in `~/.config/bitfrost/config.json` as `providers.<app>.bin` (or `providers.zcode.dir`).

### Can I use the config screen over SSH or without animations?

Keyboard and mouse controls work over SSH. To turn off animation, set `BITFROST_NO_ANIM=1`.

### Updating, or installing a specific version

Run `bitfrost update`. It installs the latest release if it's newer than yours, and does nothing otherwise. The config screen (`bitfrost`) also checks when it opens and shows an Update button when there's a newer release; it installs it and reopens on the new version without leaving the screen.

Install and update migrate your database and process existing history before activating the new release. This also happens when reinstalling with retained history. If agents are running, installation asks you to let them finish first. A migration failure stops installation and leaves the previous version active.

Before migrating an existing database, BitFrost saves a private backup in `~/bitfrost-db-backups` (or `BITFROST_BACKUP_DIR`). Historical usage is rebuilt from the data still retained; already deleted history cannot be recovered. For a source checkout or a manually replaced installation, run `bitfrost migrate` before starting the daemon.

For a specific version, run that release's installer. It installs its own version:

```
curl -fsSL https://github.com/SavaSoftworks/BitFrost/releases/download/v0.8.1/install.sh | sh
```

### Uninstalling

Run `bitfrost uninstall`. It lists what it will remove and asks whether to remove BitFrost, your configuration, and your subagent history and usage stats. Keeping history preserves it for a reinstall.

`--yes` removes everything without prompting; add `--keep-config` or `--keep-history` to preserve either. It also removes the Antigravity bridge plugin, if installed. If a subagent is running, uninstall changes nothing and asks you to wait.

## Troubleshooting

### No BitFrost models in Claude

- Start a new Claude session. If no model can be offered, it shows a BitFrost note saying why.
- Check `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is `"1"` in the `env` block of your Claude profile's `settings.json` (`~/.claude/settings.json` by default).
- Run `bitfrost status` to see which apps were found and how many models each offers.

### BitFrost can't find Node, Codex or ZCode

Set `BITFROST_NODE`, `BITFROST_CODEX_BIN` or `BITFROST_ZCODE_DIR`, or in `config.json`:

```json
{ "providers": { "codex": { "bin": "/path/to/codex" }, "zcode": { "dir": "/opt/ZCode" } } }
```

You can also set an app's location on the config screen's Settings page.

Node must be 23.6 or newer.

### "BitFrost is off: config.json is invalid"

Fix the file, then start a new session. `bitfrost status` shows what's wrong.

### Does an app work?

```
bitfrost selftest opencode deepseek/deepseek-v4-flash
bitfrost selftest --all
```

### Where's the log?

`$XDG_RUNTIME_DIR/bitfrost/bitfrostd.log`, or `/tmp/bitfrost-<uid>/bitfrost/bitfrostd.log`.

### Do I need to restart after changing config or updating an app?

BitFrost reloads configuration and detects app updates automatically. Changes that require restarting an app wait until its active tasks finish. Start a new Claude session to refresh its available models. To restart the daemon manually, run `bitfrost restart`.

### How do I turn an app off?

On the config screen, pick the app on the Settings page and turn it off. Or set `"enabled": false` under its name in `providers` in `~/.config/bitfrost/config.json`. Grok Build and Antigravity start off, so turn them on this way first.

## Using it

### How do I set reasoning effort?

Say it: "have sol6 on high review this".

### Can Claude see what a subagent is doing?

Yes. Ask "what is glm doing?". Claude checks BitFrost for the current step, recent tool calls, latest text, token usage and run time.

### Can I message a subagent while it works?

Yes, through Claude. Codex models take the message inside their current turn. Antigravity steers the running turn, like Codex. Grok Build has no steering, so a message waits for its next turn. GLM and OpenCode models get it when their turn ends. If it can't wait, ask Claude to interrupt: the subagent stops its current step and carries on in the same conversation with your message. Claude is told which of these happened.

### Can I resume a subagent after restarting Claude?

Yes. Reopen the conversation and ask Claude to continue it. It picks up in the same conversation inside its app. For OpenCode this only works if your OpenCode version can reopen sessions.

### Where does BitFrost keep subagent history?

In `~/.local/share/bitfrost/bitfrost.db`, or `~/Library/Application Support/BitFrost/bitfrost.db` on macOS. Raw events are kept 30 days after a session ends and messages 180 days. Change this on the config screen's Settings page, or by hand:

```json
{ "retention": { "eventsDays": 30, "messagesDays": 180 } }
```

Usage totals are kept forever, even after transcripts are deleted.

It holds the subagents' commands and tool output, so it can contain anything they read. The database is stored with owner-only file permissions. `bitfrost uninstall` asks before deleting it unless you use `--yes`.

### Where do the usage numbers come from?

From the subagent runs BitFrost has recorded. The Models page shows usage for Today, 7 days, 30 days and All time, including tokens, cache reads, sessions, turns, failures and average durations. Charts show hourly usage for Today and daily usage for the other periods. Each model also shows when it was first and last used.

### Who answers a subagent's permission requests?

In normal mode, you decide; no answer means Deny. In auto mode, a safety review decides instead. Grok Build and Antigravity run in approve mode, so BitFrost gates their actions itself: reads and edits inside the task folder don't ask, other commands and actions ask you, and their own subagents and schedules are refused.

### What is official handback?

Normally BitFrost writes the step that returns a finished subagent's report to Claude. With this setting on, a Claude model writes that step instead, so auto mode's safety classifier reviews the report on its way through. BitFrost only accepts the report word for word: the model gets up to three tries, then BitFrost hands the report over itself. The extra Claude step counts toward your Claude usage.

Turn it on from the config screen's Settings page, with `bitfrost setup handback`, or in `~/.config/bitfrost/config.json`:

```json
{ "handback": { "enabled": true, "model": "sonnet", "effort": "low" } }
```

`model` is a family name (Haiku, Sonnet, Opus or Fable; Sonnet is the default) or a full model id. A family name means that family's newest model as of your BitFrost release, so updating BitFrost moves you to a newer one. `effort` is `low` unless you set it. A change applies without a restart.

### Does it use my accounts?

Yes. Your coding apps use their configured accounts. See [Accounts, terms and affiliation](README.md#accounts-terms-and-affiliation) for usage limits, responsibilities and project affiliation.
