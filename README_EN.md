[简体中文](./README.md) | [English](./README_EN.md)

# dsh-soul

A personalization plugin for DeepSeek Harness (DSH). Configure your agent's nickname, reply style, tone, and custom instructions.

## Features

- Personalization settings page in the Web UI
- Enable or disable personalization
- Set a user nickname
- Reply styles: `professional`, `casual`, `friendly`, `humorous`, `academic`
- Tones: `neutral`, `formal`, `informal`, `enthusiastic`, `calm`
- Command output language: Chinese or English
- Custom instructions with ready-to-use example templates
- Configuration persisted to disk
- Configuration synced to all active agents after every update

## Installation

```powershell
dsh plugin --profile web add dsh-soul
dsh --profile web web
```

The plugin is registered via `cordis.patch.yml`:

```yaml
- insert:
    - id: soul
      name: dsh-soul
```

## Usage

After starting DSH, open the **Personalization** section on the settings page, edit the configuration and click **Save Settings**.

Slash commands are also available:

```text
/soul show       Show current configuration
/soul reset      Reset configuration
/soul enable     Enable personalization
/soul disable    Disable personalization
/soul Bob        Set nickname
```

Once saved, the configuration is synced to all active agents and takes effect on the next request in the current session.

## Configuration File

The configuration is stored in the DSH user data directory:

```text
soul-config.json
```

Example:

```json
{
  "enabled": true,
  "nickname": "Bob",
  "style": "professional",
  "tone": "neutral",
  "language": "en",
  "customInstructions": "Be concise and lead with the conclusion."
}
```

## How It Works

The plugin compiles the nickname, style, tone and custom instructions into a system prompt via `compilePrompt()` and registers it with DSH:

```js
spCtx.systemPrompt.section({
  name: 'soul:persona',
  order: 0,
  text: () => compilePrompt(configCache || DEFAULT_CONFIG)
})
```

After each update, the plugin iterates over all active agents and calls `agent.inject()` with a standard `UserMessage`:

```js
agent.inject(createUserMessage({
  content: [{ type: 'text', text: prompt }],
  source: {
    kind: 'plugin',
    plugin: 'dsh-soul',
    form: 'snapshot',
    sections: [{ name: 'soul:persona', text: prompt }]
  }
}))
```

`agent.inject()` places the latest configuration into the agent's pending context so it takes effect on the next request. It does not trigger a new request and does not modify message history.

## License

MIT License
