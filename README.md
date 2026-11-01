# Pi compaction

Choose a compaction style, model, and reasoning effort for `/compact`. Set shared defaults and policies for each conversation model.

This extension requires Pi 1.4.0 or later in the 1.x series, distributed as `@earendil-works/pi-coding-agent`. It does not support the older `@mariozechner` releases.

## Install

Install from GitHub:

```sh
pi install git:github.com/thgilciffart/pi-compaction
```

After the package is published to npm, install it with:

```sh
pi install npm:@thgilciffart/pi-compaction
```

Restart Pi or run `/reload` after installation. Keep using `/compact` and `/compact <instructions>`.

## Configure compaction

Run `/compaction-settings` to open the menu editor. Use the arrow keys to select an item and Enter to open it.

Press **Esc** to go back from a submenu. At the main menu, Esc closes the editor. Press **Ctrl+C** anywhere in the settings flow to quit the editor and discard all unsaved settings and prompt edits. **Ctrl+S** saves and closes the settings editor. From a text field, Ctrl+S submits that field before saving. A new prompt is staged only after its title, description, and body have been completed.

1. Choose **Global** or **This project**. The project option appears only for trusted projects.
2. Open **Defaults** or **Policies by conversation model**.
3. Choose the compaction style, model, reasoning effort, automatic compaction switch, and context threshold. Model selection lists providers first, then models with configured credentials.
4. Use **Back** to return to the main menu, then select **Save changes**.

Each field shows its configured value. Select **Inherit** to remove that value and use the next applicable policy. Summary instructions have a separate text editor.

Global defaults use explicit choices instead of **Inherit**: **Use conversation model**, **Use conversation effort**, **Use Pi setting** for automatic compaction, and **Use Pi threshold**. Their other defaults are **No additional instructions**, **Cancel compaction**, and **Native Pi**. Project defaults and model policies retain **Inherit**.

**Context threshold** opens a text input. Enter `80%` for a percentage or `100000` for an absolute token count. Token counts also accept `100k`, `1.5m`, and an optional `tokens` suffix. A bare number always means tokens. Leave the input blank to use Pi's threshold in global defaults, or inherit the threshold in a project or model policy. Escape cancels the edit.

Under **Policies by conversation model**, **Add models** starts with session-scoped models. Press **Tab** to switch between **Scoped models** and **All models**. Scoped models are the models configured through Pi's `--models` or `enabledModels` setting. When no scope is configured, this view shows available models and the current conversation model.

**Edit models** starts with models already added to this configuration. Tab cycles through **Added models → Scoped models → All models**. The All models view also includes existing policy IDs that are no longer in the registry.

In either picker, type in the search field to filter by model ID, provider, or model name. Rows show the model ID and provider, with the highlighted model's name below the list. Use the arrow keys to navigate and **Space** to toggle a checkmark and advance to the next row. The picker keeps its selections when you search or switch views. Press **Enter** to edit the selected policies together, or **Ctrl+S** to save immediately. Both adding and editing models create their policy entries, even if you leave their fields unset. Cancelling the picker adds nothing.

Batch editing shows **Mixed** where the selected policies differ. Only fields you change apply to every selected model. Other settings remain as configured for each model. Choosing **Inherit** removes that field from every selected policy.

An asterisk (`*`) marks fields that differ from the settings you opened. The marker remains when you reopen an edited policy and disappears if you restore its original value. Every policy editor includes **Save changes** and **Discard changes**, including the editor for multiple models. **Save changes** or Ctrl+S saves all pending settings and closes the editor. **Discard changes** closes the editor without saving any pending settings or prompt edits. **Back** keeps edits pending and returns to the parent menu. To remove policies, select their models through **Edit models**, then choose **Remove policies** or press **Delete** in the policy editor.

In the **Edit models** picker, **Delete** removes checked models' policies. With nothing checked, it removes the highlighted model's policy. Removal stays pending until you save. It does not remove models from Pi's catalogue.

Changes, including saved prompt edits, stay in memory until you select **Save changes** or press Ctrl+S. **Discard changes** or Escape at the main menu closes the editor without saving. `/compaction-settings edit` opens the same menu.

To inspect the resolved policy for the current conversation model, run `/compaction-settings show`. In a mode without dialogs, `/compaction-settings` also shows the resolved policy.

You can also create `~/.pi/agent/compaction.json` in a text editor. If `PI_CODING_AGENT_DIR` is set, Pi uses that directory instead.

```json
{
	"defaults": {
		"style": "native",
		"model": "current",
		"effort": "low",
		"auto": {
			"enabled": true,
			"thresholdPercent": 75
		},
		"instructions": "Preserve decisions, unfinished work, and test results."
	},
	"models": {
		"anthropic/claude-sonnet-4-5": {
			"model": "anthropic/claude-haiku-4-5",
			"effort": "off",
			"auto": { "thresholdPercent": 80 }
		}
	}
}
```

Replace the example model IDs with models available in your Pi installation. Configure credentials through Pi's provider settings or `/login`.

Saved changes take effect at the next compaction check. No reload is required.

A trusted project can add `.pi/compaction.json` with the same structure. The extension ignores project configuration until Pi grants project trust.

## Configuration reference

Policies merge in this order. Later values replace earlier values.

1. Global `defaults`.
2. Project `defaults`.
3. Global `models[provider/model]`.
4. Project `models[provider/model]`.

The `auto` object merges by field, except that a threshold replaces an earlier threshold of either type. Instructions and the `prompt` object each replace earlier values in full. Per-model keys match the conversation model exactly, including the provider. Model IDs can contain additional slashes. Wildcards are not supported.

`defaults` and each `models` entry accept these fields:

| Field | Values | Default |
| --- | --- | --- |
| `style` | `"native"`, `"claude-code"`, `"codex"`, `"custom"` | `"native"` |
| `prompt` | Object with non-empty `system` and `summary` strings, or a saved prompt ID such as `"global/review"` | Required when the resolved style is `"custom"` |
| `model` | `"current"` or `"provider/model-id"` | Current conversation model |
| `effort` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` | Current conversation effort |
| `auto.enabled` | Boolean | Pi's automatic compaction behavior |
| `auto.thresholdPercent` | Number greater than 0 and less than 100 | Pi's token reserve threshold |
| `auto.thresholdTokens` | Positive integer token count | Pi's token reserve threshold |
| `instructions` | String | No additional instructions |
| `onError` | `"cancel"` or `"default"` | `"cancel"` |

The model's provider determines which effort levels it supports. Non-reasoning models ignore effort. `"off"` sends no reasoning request. `"current"` resets an inherited compaction model to the conversation model.

A policy can set either `auto.thresholdPercent` or `auto.thresholdTokens`, but cannot set both. For example, `"auto": { "thresholdTokens": 100000 }` compacts at 100,000 context tokens. JSON settings require a number; abbreviations such as `100k` are accepted only in the menu's input.

For example, this global default disables automatic compaction unless a project default or model policy enables it:

```json
{
	"defaults": {
		"auto": { "enabled": false }
	}
}
```

An empty file must contain `{}`. Missing files leave Pi's defaults in place. Invalid JSON, unknown fields, and invalid values cancel compaction and produce an error notification. The extension does not reuse stale settings after a validation error.

The package includes [a JSON schema](config.schema.json) for editor completion and [a complete example](examples/compaction.json). The optional `$schema` field accepts an editor schema path or URL.

## Automatic compaction behavior

Pi's automatic compaction setting remains the master switch. If you disable it through Pi, this extension does not start automatic compaction. Manual `/compact` remains available.

With `thresholdPercent` or `thresholdTokens`, the extension checks context usage after a completed agent run. It requests compaction when usage reaches the configured percentage or token count. It skips aborted runs, queued messages, unknown usage, and an existing compaction request. It also cancels Pi's native threshold compaction below the configured threshold, which allows a later threshold.

Pi still handles context overflow recovery before the percentage threshold. Setting `auto.enabled` to `false` cancels both threshold compaction and overflow compaction. After an overflow, manual compaction may be required to continue.

A configured threshold is a trigger, not a hard context limit. A long tool loop can exhaust context before the run ends. Choose a threshold that leaves room for tool output and the model's response.

Pi controls which recent messages remain verbatim. Configure `compaction.keepRecentTokens`, `compaction.reserveTokens`, and `compaction.modelOverrides` in Pi's own settings when you need token-based retention policies. This extension does not rewrite Pi's settings files.

## Summary behavior and failures

The extension calls Pi's built-in summarizer with the selected model and effort. Pi preserves previous summaries, split turns, file operations, the retained message boundary, and summary token usage. The selected style controls the summary request's prompts. Instructions from `/compact <instructions>` follow the configured instructions.

Summary requests use Pi's model registry for provider authentication and its retry settings for transient failures. Cancellation reaches the provider through Pi's abort signal. Empty, failed, and truncated summaries cannot replace the session history.

By default, a missing model or failed summary cancels compaction. With `onError: "default"`, the extension reports the failure and lets Pi compact with its default model, effort, and instructions. The selected style and configured instructions do not apply to that fallback. Invalid configuration always cancels compaction.

The conversation model and effort remain unchanged. The extension does not customize `/tree` branch summaries. Install only one extension that replaces `session_before_compact` summaries.

## Compaction styles

In `/compaction-settings`, open a policy and select **Compaction style**:

| Choice | Behavior |
| --- | --- |
| Native Pi | Uses Pi's own system prompt and summary formats. |
| Claude Code-style | Produces a detailed session summary covering requests, technical context, file changes, errors, decisions, and unfinished work. |
| Codex-style | Produces a concise checkpoint focused on progress, constraints, next steps, and essential references. |
| Saved prompt | Selects a Markdown prompt by title, optional description, and scope. Offers to create one when none exist. |

The Claude Code and Codex presets are original portable prompts. The Codex preset follows the scope of the [public Codex checkpoint prompt](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md). The Claude Code preset approximates a detailed session summary. Neither preset reproduces the product's full compaction implementation or guarantees its output quality.

All styles produce readable text through the selected Pi model. The Codex preset does not call OpenAI's [encrypted compaction endpoint](https://developers.openai.com/api/docs/guides/compaction). You can use either preset with any configured summary model that has enough context capacity.

For a custom format, create a saved Markdown prompt and reference it in the policy:

```json
{
	"defaults": {
		"style": "custom",
		"prompt": "global/review"
	}
}
```

The menu requires a saved prompt for custom formats. Existing inline `prompt` objects with `system` and `summary` strings remain supported in configuration files. The extension supplies the conversation and any previous summary, identifies the summary task, and appends configured and manual instructions as additional focus. Prompt strings are literal text, with no template placeholders.

Styles inherit through the same global, project, and model policies as other settings. Select **Native Pi** to reset an inherited style, or **Inherit** to remove the current policy's style. Saved custom prompts remain available when switching styles and apply only when the resolved style is `"custom"`.

## Save and reuse prompts

Run `/compaction-settings`, choose a scope, and open **Saved prompts**. Select **Create a prompt**, then enter a title, an optional description, and the compaction system prompt. Leave the description empty to omit it. To edit an existing prompt, select its title in the same menu. All fields contain their saved values when editing. Press Enter to keep a value, or clear the description to remove it.

To use a saved prompt, open a policy and select **Compaction style → Saved prompt**. The picker shows each prompt's title, description, and ID. If none exist, it asks whether you want to create one. A prompt created from the picker is selected automatically. Return to the main menu and select **Save changes** to write the Markdown files and policy settings. **Discard changes** also discards prompt edits.

Global prompts are stored in `~/.pi/agent/compaction-prompts/`, or under `PI_CODING_AGENT_DIR` when set. Project prompts are stored in `.pi/compaction-prompts/` and are available only in trusted projects. Each scope's **Saved prompts** menu edits files in that scope. The picker can select prompts from either available scope.

You can also create or edit the Markdown files directly. For example, save this as `~/.pi/agent/compaction-prompts/review.md`:

```markdown
---
title: Review handoff
description: Preserve findings, exact errors, and unresolved risks.
---

Summarize the conversation for the next assistant. Output only the summary.
Use sections: Findings, Verified fixes, Unresolved risks, Next steps.
Preserve exact paths and errors. Distinguish verified results from assumptions.
```

`title` is required. `description` is optional. The Markdown body is the complete compaction system prompt, including any output format you want. The extension supplies the conversation, previous summary, summary task, and additional focus without imposing Pi's native summary format. These files affect compaction requests only.

Reference a file in a policy by scope and filename without `.md`:

```json
{
	"defaults": {
		"style": "custom",
		"prompt": "global/review"
	}
}
```

IDs use `global/name` or `project/name`. Filenames must start with a letter or digit and contain only letters, digits, underscores, and hyphens. The menu generates filenames from titles and adds a numeric suffix for duplicates. Editing a title keeps the filename and policy references unchanged. If you rename a file yourself, update its policy references.

Prompt files reload at the next compaction check. A missing or invalid selected prompt cancels compaction with an error. The picker reports invalid files and lists the valid ones. Native Pi and the built-in presets ignore saved prompt references.

## Choose a compaction policy

Use a summarizer with enough context capacity for the conversation. A cheaper model with a smaller context window can reject a long history. Start with low effort and compare summaries before raising the threshold or reducing retained context.

Custom instructions can preserve details that matter to your work, such as failed approaches, exact error messages, pending tests, and decisions. The effective-settings command helps you check per-model rules before a long session.

## Develop and publish

Run the checks:

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The tests exercise Pi's real summarizer with a simulated provider. They cover configuration precedence, project trust, model routing, reasoning effort, split turns, usage accounting, automatic thresholds, and truncated summaries. They do not make paid model requests.

Test locally with `pi -e ./src/index.ts`. Run `/compaction-settings`, start a conversation, and use `/compact` to check your provider credentials and selected model.

The manifest declares the extension entry point and the `pi-package` keyword required for the [Pi package catalog](https://pi.dev/docs/latest/packages). The published package contains TypeScript source and requires no build step.

To release from this repository, authenticate to npm as an account with access to the `@thgilciffart` scope, then run:

```sh
npm publish --access public
```

npm publication makes the package eligible for catalog discovery. This repository does not publish automatically.
