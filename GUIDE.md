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

### Updating, or installing a specific version

Run the installer again to update. For a specific version:

```
curl -fsSL https://github.com/SavaSoftworks/BitFrost/releases/latest/download/install.sh | sh -s -- --version 0.8.1
```

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

### Who answers a subagent's permission requests?

You, never Claude. No answer means Deny. In auto mode, a safety review decides instead.

### Does it use my accounts?

Yes. Each app signs in and makes its own requests. Usage counts against your account with that company. BitFrost never touches credentials.

### Terms

Use each company's app within its terms. BitFrost is independent, not affiliated with Anthropic, OpenAI or Z.ai.
