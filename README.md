# Pi compaction

Configure the model and reasoning effort used by `/compact`. Set automatic compaction policies for each conversation model, or apply one override to every model.

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

Run `/compaction-settings edit` to edit the global JSON file in Pi. The command validates the JSON before it saves.

You can also create `~/.pi/agent/compaction.json` in a text editor. If `PI_CODING_AGENT_DIR` is set, Pi uses that directory instead.

```json
{
	"defaults": {
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
	},
	"override": {}
}
```

Replace the example model IDs with models available in your Pi installation. Configure credentials through Pi's provider settings or `/login`.

Run `/compaction-settings` to show the resolved policy for the current conversation model. File changes take effect at the next compaction check. No reload is required.

A trusted project can add `.pi/compaction.json` with the same structure. The extension ignores project configuration until Pi grants project trust.

## Configuration reference

Policies merge in this order. Later values replace earlier values.

1. Global `defaults`.
2. Project `defaults`.
3. Global `models[provider/model]`.
4. Project `models[provider/model]`.
5. Global `override`.
6. Project `override`.

The `auto` object merges by field. Instructions replace earlier instructions. Per-model keys match the conversation model exactly, including the provider. Model IDs can contain additional slashes. Wildcards are not supported.

`defaults`, each `models` entry, and `override` accept these fields:

| Field | Values | Default |
| --- | --- | --- |
| `model` | `"current"` or `"provider/model-id"` | Current conversation model |
| `effort` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` | Current conversation effort |
| `auto.enabled` | Boolean | Pi's automatic compaction behavior |
| `auto.thresholdPercent` | Number greater than 0 and less than 100 | Pi's token reserve threshold |
| `instructions` | String | No additional instructions |
| `onError` | `"cancel"` or `"default"` | `"cancel"` |

The model's provider determines which effort levels it supports. Non-reasoning models ignore effort. `"off"` sends no reasoning request. `"current"` resets an inherited compaction model to the conversation model.

`override` applies across conversation models. For example, this global policy disables automatic compaction for every model unless a project override enables it:

```json
{
	"override": {
		"auto": { "enabled": false }
	}
}
```

An empty file must contain `{}`. Missing files leave Pi's defaults in place. Invalid JSON, unknown fields, and invalid values cancel compaction and produce an error notification. The extension does not reuse stale settings after a validation error.

The package includes [a JSON schema](config.schema.json) for editor completion and [a complete example](examples/compaction.json). The optional `$schema` field accepts an editor schema path or URL.

## Automatic compaction behavior

Pi's automatic compaction setting remains the master switch. If you disable it through Pi, this extension does not start automatic compaction. Manual `/compact` remains available.

With `thresholdPercent`, the extension checks context usage after a completed agent run. It requests compaction when usage reaches the configured percentage. It skips aborted runs, queued messages, unknown usage, and an existing compaction request. It also cancels Pi's native threshold compaction below that percentage, which allows a later threshold.

Pi still handles context overflow recovery before the percentage threshold. Setting `auto.enabled` to `false` cancels both threshold compaction and overflow compaction. After an overflow, manual compaction may be required to continue.

A percentage threshold is a trigger, not a hard context limit. A long tool loop can exhaust context before the run ends. Choose a threshold that leaves room for tool output and the model's response.

Pi controls which recent messages remain verbatim. Configure `compaction.keepRecentTokens`, `compaction.reserveTokens`, and `compaction.modelOverrides` in Pi's own settings when you need token-based retention policies. This extension does not rewrite Pi's settings files.

## Summary behavior and failures

The extension calls Pi's built-in summarizer with the selected model and effort. Pi preserves previous summaries, split turns, file operations, the retained message boundary, and summary token usage. Instructions from `/compact <instructions>` follow the configured instructions.

Summary requests use Pi's model registry for provider authentication and its retry settings for transient failures. Cancellation reaches the provider through Pi's abort signal. Empty, failed, and truncated summaries cannot replace the session history.

By default, a missing model or failed summary cancels compaction. With `onError: "default"`, the extension reports the failure and lets Pi compact with its default model, effort, and instructions. Configured instructions do not apply to that fallback.

The conversation model and effort remain unchanged. The extension does not customize `/tree` branch summaries. Install only one extension that replaces `session_before_compact` summaries.

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

Test locally with `pi -e ./src/index.ts`. Run `/compaction-settings edit`, start a conversation, and use `/compact` to check your provider credentials and selected model.

The manifest declares the extension entry point and the `pi-package` keyword required for the [Pi package catalog](https://pi.dev/docs/latest/packages). The published package contains TypeScript source and requires no build step.

To release from this repository, authenticate to npm as an account with access to the `@thgilciffart` scope, then run:

```sh
npm publish --access public
```

npm publication makes the package eligible for catalog discovery. This repository does not publish automatically.
