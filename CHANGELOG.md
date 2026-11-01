# Changelog

## Unreleased

- Use Delete to remove checked or highlighted policies in the model picker, or all selected policies in their editor.
- Add selected models to policies when editing from any model view, even if their fields remain unset.
- Mark unsaved field and policy changes with `*`, and add Save changes and Discard changes to policy editors.
- Match Pi's model picker with themed borders, scope tabs, search, provider labels, checkmarks, and model details.
- Add a persistent conversation-model picker with Tab views for scoped, added, and all models, plus Space selection that advances the cursor.
- Save settings with Ctrl+S from menus, text fields, and model selection.
- Merge Custom and Saved prompt into one saved-prompt choice and offer prompt creation from the picker.
- Prefill saved prompt titles and descriptions with editable values.
- Replace threshold presets with an input accepting percentages or absolute token counts, including `100k` shorthand.
- Edit multiple conversation-model policies together, with mixed values and changes applied only to edited fields.
- Place Saved prompts above Save changes and Discard changes in the settings menu.
- Remove Override all models. Use shared defaults and per-model policies instead. The `override` configuration field is no longer supported.
- Use Escape to go back and Ctrl+C to quit the settings editor without saving.
- Create, edit, and select saved Markdown compaction prompts with a title and optional description.
- Store prompts globally or in trusted projects, and stage prompt edits until settings are saved.
- Select Native Pi, Claude Code-style, Codex-style, or Custom compaction prompts in the settings menu.
- Configure styles globally or by conversation model.
- Edit custom system and summary prompts while retaining Pi's split-turn handling, file tracking, and usage accounting.

## 0.2.0

- Replace the JSON editor with menus for defaults, model policies, and overrides.
- Add provider and model pickers, effort choices, and context threshold presets.
- Save or discard changes to global or trusted project settings.
- Open the editor with `/compaction-settings` and inspect the effective policy with `/compaction-settings show`.

## 0.1.0

- Configure the compaction model, reasoning effort, and summary instructions.
- Set automatic compaction thresholds and enable switches by conversation model.
- Apply global and trusted project policies with explicit overrides.
- Inspect effective settings and edit the global configuration inside Pi.
