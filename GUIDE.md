# BitFrost FAQ

## Setup

### Codex

Install and sign in to the Codex CLI or the ChatGPT desktop app. Nothing else to do.

### ZCode (GLM)

Sign in to ZCode's command-line tool once (change `/opt/ZCode` if ZCode is elsewhere):

```
ELECTRON_RUN_AS_NODE=1 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/opt/ZCode/resources/config/provider/zcode-builtin.json /opt/ZCode/zcode /opt/ZCode/resources/glm/zcode.cjs login
```

Then run `bitfrost setup zcode` once. Without it, GLM can't ask you for permission and is refused instead.

### opencode, Oh My Pi, Gemini CLI

Sign in to the app first (`opencode auth login`, `omp`, or `gemini`). Then turn it on in `~/.config/bitfrost/config.json`:

```json
{
  "providers": {
    "opencode": { "enabled": true, "models": ["deepseek/*"] },
    "omp": { "enabled": true, "models": ["deepseek/deepseek-v4-pro"] },
    "gemini": { "enabled": true }
  }
}
```

opencode and Oh My Pi need `models`: only the models listed there are offered. `*` works as a wildcard.

Anthropic models are never offered through these apps. Neither are GPT, GLM or Gemini models, which run through their own apps.

### Using a Claude profile other than `~/.claude`

Add it to `allowedProfiles` in `~/.config/bitfrost/config.json`:

```json
{ "allowedProfiles": ["~/.claude", "~/.claude-other"] }
```

Profiles not listed get no subagents.

### Choosing settings

Run `bitfrost setup` to answer any settings you haven't chosen yet, and `bitfrost setup handback` to answer one again. The installer and `bitfrost update` ask about them at the end of an install, using the new release's own questions. Without a terminal nothing is asked: the settings stay off, and the installer lists `bitfrost setup` as a next step. A Claude session also mentions unchosen settings, once.

### Updating, or installing a specific version

Run `bitfrost update`. It installs the latest release if it's newer than yours, and does nothing otherwise.

For a specific version, run that release's installer. It installs its own version:

```
curl -fsSL https://github.com/SavaSoftworks/BitFrost/releases/download/v0.8.1/install.sh | sh
```

### Uninstalling

Run `bitfrost uninstall`. It lists what it will remove and asks two questions: remove BitFrost (the Claude plugin, the GLM bridge in ZCode and every file BitFrost added), then also remove your BitFrost config. Add `--yes` to skip the questions and remove both, for example in a script, or `--yes --keep-config` to keep your config. If a subagent is still running, it changes nothing and asks you to wait.

## Troubleshooting

### No BitFrost models in Claude

- Start a new Claude session. If no model can be offered, it shows a BitFrost note saying why.
- Check `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is `"1"` in the `env` block of `~/.claude/settings.json`.
- Run `bitfrost status` to see which apps were found and how many models each offers.

### BitFrost can't find Node, Codex or ZCode

Set `BITFROST_NODE`, `BITFROST_CODEX_BIN` or `BITFROST_ZCODE_DIR`, or in `config.json`:

```json
{ "providers": { "codex": { "bin": "/path/to/codex" }, "zcode": { "dir": "/opt/ZCode" } } }
```

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

No. If you want to anyway: `bitfrost restart`.

### How do I turn an app off?

`"enabled": false` under its name in `providers`.

## Using it

### How do I set reasoning effort?

Say it: "have sol6 on high review this".

### Can Claude see what a subagent is doing?

Yes. Ask "what is glm doing?". Claude checks BitFrost for the current step, recent tool calls, latest text, token usage and run time.

### Can I message a subagent while it works?

Yes, through Claude. Codex models take the message inside their current turn. GLM and opencode models get it when their turn ends. If it can't wait, ask Claude to interrupt: the subagent stops its current step and carries on in the same conversation with your message. Claude is told which of these happened.

### Can I resume a subagent after restarting Claude?

Yes. Reopen the conversation and ask Claude to continue it. It picks up in the same conversation inside its app. For opencode this only works if your opencode version can reopen sessions.

### Where does BitFrost keep subagent history?

In `~/.local/share/bitfrost/bitfrost.db`, or `~/Library/Application Support/BitFrost/bitfrost.db` on macOS. Raw events are kept 30 days after a session ends and messages 180 days. To change that:

```json
{ "retention": { "eventsDays": 30, "messagesDays": 180 } }
```

It holds the subagents' commands and tool output, so it can contain anything they read. Only your user can open it. `bitfrost uninstall` deletes it.

### Who answers a subagent's permission requests?

You, never Claude. No answer means Deny. In auto mode, a safety review decides instead.

### What is official handback?

Normally BitFrost writes the step that returns a finished subagent's report to Claude. With this setting on, a Claude model writes that step instead, so auto mode's safety classifier reviews the report on its way through. BitFrost only accepts the report word for word: the model gets up to three tries, then BitFrost hands the report over itself. The extra Claude step counts toward your Claude usage.

Turn it on with `bitfrost setup handback`, or in `~/.config/bitfrost/config.json`:

```json
{ "handback": { "enabled": true, "model": "sonnet", "effort": "low" } }
```

`model` is a family name (Haiku, Sonnet, Opus or Fable; Sonnet is the default) or a full model id. A family name means that family's newest model as of your BitFrost release, so updating BitFrost moves you to a newer one. `effort` is `low` unless you set it. A change applies without a restart.

### Does it use my accounts?

Yes. Each app signs in and makes its own requests. Usage counts against your account with that company. BitFrost never touches credentials.

### Terms

Use each company's app within its terms. BitFrost is independent, not affiliated with Anthropic, OpenAI or Z.ai.
