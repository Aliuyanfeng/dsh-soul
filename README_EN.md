[简体中文](./README.md) | [English](./README_EN.md)

# dsh-soul

A personalization plugin for DeepSeek Harness (DSH). Configure your agent's nickname, reply style, tone, and custom instructions.

## Features

- Personalization settings page in the Web UI
- Localized settings UI (English/Chinese, follows the interface language), dirty tracking (save disabled when unchanged), save-result toasts, and a read-only "active prompt" viewer
- Enable or disable personalization
- "About you": set your nickname, occupation and bio so replies fit your background
- Combined style & tone option: `professional`, `casual`, `humorous`, `roast`, `efficient`
- Trait fine-tuning (layered on top of style & tone):
  - Headings & lists: `default`, `more` (clear formatting with headings and lists), `less` (more paragraph text)
  - Emoji: `default`, `more` (frequent emoji usage), `less` (minimal emoji usage)
  - Tables: `default`, `more` (prefer tables for comparisons and multi-field data), `less` (avoid tables; use lists or paragraphs)
- Reply length preference: `concise` (key points only), `normal` (no extra constraint, default), `detailed` (expand background, steps and reasoning)
- Output language (agent reply language + `/soul` command output language): Chinese or English
- The compiled system prompt follows the output language (English descriptions when `language=en`)
- Custom instructions
- Agent-callable tool `set_persona` to let the model adjust persona during a conversation
- Named personas: 6 built-in personas (Socratic Questioner / Minimalist / Senior Architect / Teaching Explainer / Strict Code Reviewer / Brainstorm Partner — shipped with the plugin, cannot be deleted) plus your own named personas, switched with one click (save / use / list / delete, in both the Web UI and slash commands); each row summarises the style and every dimension that differs from its default
- `set_persona` confirmation mode (`requireToolConfirmation`): agent persona changes take effect only after `/soul confirm`
- Composer light trail: while the agent is replying, a light trail loops around the composer border (default color `#679EFE`)
  - Color: preset swatches, a color picker, or a hex input (e.g. `#679EFE`)
  - Flow speed: slow / normal / fast (default slow, 4.8s / 3.6s / 2.4s); trail thickness: thin / normal / thick (default thin, 1.5 / 2.5 / 4 px)
  - The trail advances at constant speed along the border and fades into a tail; it sits exactly on the composer border, never producing a double line
  - The settings page shows a live preview that follows color / speed / thickness; automatically disabled under "reduce motion"
- `/soul set` key=value field updates
- Configuration persisted to disk
- Input validation: field whitelist, types, length limits (nickname/occupation 50, bio 500, custom instructions 2000 chars), enum and hex-color checks; invalid or oversized fields reject the whole write
- Configuration synced to all active agents after every update
- Change detection: the prompt is refreshed and sessions injected only when a behavior-affecting field actually changed — appearance-only config (composer light trail) is persisted without injecting anything
- Plugin icon: a dedicated icon in the plugin manager list and the sidebar entry (`assets/icon.svg`, 36×36, shipped with the npm package)
- Settings nav icon: the "Personalization" entry in the settings panel draws the same geometry as the plugin icon — same trail and spark, but coloured and weighted like its neighbours (monochrome `currentColor`). DSH hardcodes nav glyphs by section id and offers no way for a plugin to declare one, so the client swaps the glyph in the DOM

## Installation

```powershell
dsh plugin --profile web add dsh-soul
dsh plugin --profile web update dsh-soul
```

The plugin is registered via `cordis.patch.yml`:

```yaml
- insert:
    - id: soul
      name: dsh-soul
```

## Compatibility

The plugin ships no DSH runtime packages; the host provides them all. DSH validates `peerDependencies` before loading, comparing against the **DSH runtime version** (the version of `@deepseek-ai/dsh-app-boot`), not the individual packages' versions:

| Package | Range |
| --- | --- |
| `@deepseek-ai/dsh-llm` | `>=0.1.1-rc.2 <0.3.0-0` |
| `@deepseek-ai/dsh-tools` | `>=0.1.0-rc.6 <0.3.0-0` |
| `@deepseek-ai/cordis` | `^4.0.1 \|\| ^4.0.5-alpha.1` |

So DSH **0.1.x and 0.2.x** are supported, prereleases included. Run `npm run verify:compat` to check the declaration against your environment.

If DSH reports "dsh-soul@x.y.z is incompatible with DSH a.b.c", the plugin predates that DSH version — updating it is enough:

```powershell
dsh plugin --profile web update dsh-soul
```

## Screenshots

**Settings page (About you + Traits)**

![Settings page (upper part): About you & start of Traits](./screenshots/image0.png)

**Settings page (Traits + Output language + Custom instructions)**

![Settings page (lower part): Traits, Output language & Custom instructions](./screenshots/image1.png)

**`/soul` command prompt**

![`/soul` command autocomplete hint and input box](./screenshots/image2.png)

**`/soul` command output (set nickname, show, enable, disable, reset)**

![Sample outputs of multiple `/soul` commands](./screenshots/image3.png)

## Usage

After starting DSH, open the **Personalization** section on the settings page, edit the configuration and click **Save Settings**.

Slash commands are also available:

```text
/soul show        Show current configuration (confirmation mode & persona count)
/soul set k=v     Change config fields (e.g. /soul set style=humorous language=en; trail: trailColor=#679EFE trailSpeed=fast trailWidth=thick)
/soul save <name> Save the current config as a persona (built-in names are reserved)
/soul use <name>  Apply a persona (built-in personas work the same way)
/soul list        List personas (✔ marks the active match; built-ins carry a [built-in] tag)
/soul del <name>  Delete a persona (delete / rm aliases; built-in personas cannot be deleted)
/soul confirm     Apply the pending persona proposal (confirmation mode)
/soul reject      Discard the pending persona proposal
/soul reset       Reset configuration (keeps the persona library)
/soul enable      Enable personalization
/soul disable     Disable personalization
/soul Bob         Set nickname
```

Once saved, the configuration is synced to all active agents and takes effect on the next request in the current session; no-op saves inject nothing.

The agent can also use the `set_persona` tool to adjust your persona (nickname, style & tone, traits, reply language, custom instructions). The model only invokes this tool when you explicitly ask to change how it addresses or responds to you. With **Require confirmation for persona changes** (`requireToolConfirmation`) enabled, tool changes come back as a pending proposal and take effect only after `/soul confirm` (or are discarded by `/soul reject`).

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
  "occupation": "Software Engineer",
  "bio": "Interested in programming and technology",
  "style": "professional",
  "language": "en",
  "customInstructions": "Be concise and lead with the conclusion.",
  "requireToolConfirmation": false,
  "trailEnabled": true,
  "trailColor": "#679EFE",
  "trailSpeed": "slow",
  "trailWidth": "thin"
}
```

Your own personas are stored in the same file under the `personas` field: name → persona field snapshot (nickname / occupation / bio / style / traits / reply length / language / custom instructions) + `updatedAt`. Persona library changes never touch the active config; a persona is applied to the config (and synced to sessions) only when used. Built-in personas are not persisted — they live in `lib/personas.mjs` — and listing / applying / match detection all go through the merged view of built-ins plus your own; on a name collision the built-in wins, and a built-in name can neither be saved over nor deleted.

Composer light trail fields: `trailEnabled` (on/off, default `true`), `trailColor` (6-digit hex, stored uppercase, default `#679EFE`), `trailSpeed` (`slow` / `normal` / `fast`, default `slow`), `trailWidth` (`thin` / `normal` / `thick`, default `thin`). These are appearance-only: they are persisted but never enter the system prompt and never trigger a session injection.

Length limits: nickname / occupation 50 chars, bio 500 chars, custom instructions 2000 chars; the color must be `#rrggbb`. Unknown fields are dropped; invalid or oversized fields reject the whole write (HTTP returns 400 with per-field error details).

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
