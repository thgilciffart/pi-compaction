import { ExtensionInputComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { efforts, parseThresholdInput, type Config, type Policy } from "./config.ts";
import { chooseConversationModels } from "./model-picker.ts";
import { DiscardSettings, SaveSettings } from "./navigation.ts";
import { matchesKey } from "@earendil-works/pi-tui";
import type { SavedPrompt, SavedPromptLibrary } from "./saved-prompts.ts";

const inherit = "Inherit";
const back = "Back";
const styleLabels = { native: "Native Pi", "claude-code": "Claude Code-style", codex: "Codex-style", custom: "Saved prompt" } as const;

function preview(value: string | undefined): string {
	return value === undefined ? inherit : value.replace(/\s+/g, " ").slice(0, 60) || "Empty";
}

async function chooseModel(ctx: ExtensionContext): Promise<string | undefined> {
	const models = ctx.modelRegistry.getAvailable();
	const ids = new Set(models.map(m => `${m.provider}/${m.id}`));
	if (ids.size === 0) {
		ctx.ui.notify("No models with configured credentials are available. Configure a provider in Pi first.", "warning");
		return;
	}
	const providers = [...new Set([...ids].map(id => id.slice(0, id.indexOf("/"))))].sort();
	while (true) {
		const provider = await ctx.ui.select("Compaction model provider", [...providers, back]);
		if (!provider || provider === back) return;
		const model = await ctx.ui.select("Choose a model", [...ids].filter(id => id.startsWith(`${provider}/`)).sort());
		if (model) return model;
	}
}

function promptLabel(prompt: SavedPrompt): string {
	return `${prompt.title.replace(/\s+/g, " ")} [${prompt.id}]${prompt.description ? `: ${prompt.description.replace(/\s+/g, " ")}` : ""}`;
}

async function chooseSavedPrompt(ctx: ExtensionContext, library: SavedPromptLibrary): Promise<string | undefined> {
	const { prompts, errors } = library.list();
	for (const error of errors) ctx.ui.notify(error, "warning");
	const labels = prompts.map(promptLabel);
	const selected = await ctx.ui.select(prompts.length ? "Choose a saved compaction prompt" : "No saved prompts. Would you like to create one?", [...labels, "Create a prompt", back]);
	if (selected === "Create a prompt") return (await editSavedPrompt(ctx, library))?.id;
	return prompts[labels.indexOf(selected ?? "")]?.id;
}

async function promptInput(ctx: ExtensionContext, title: string, value: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const component = new ExtensionInputComponent(title, undefined, done, () => done(undefined), { tui, initialValue: value });
		const handleInput = component.handleInput.bind(component);
		component.handleInput = data => handleInput(matchesKey(data, "ctrl+s") ? "\r" : data);
		return component;
	});
}

async function editSavedPrompt(ctx: ExtensionContext, library: SavedPromptLibrary, existing?: SavedPrompt): Promise<SavedPrompt | undefined> {
	const title = await promptInput(ctx, "Prompt title", existing?.title ?? "");
	if (title === undefined) return;
	const description = await promptInput(ctx, "Description (optional)", existing?.description ?? "");
	if (description === undefined) return;
	const system = await ctx.ui.editor("Compaction system prompt", existing?.system ?? "");
	if (system === undefined) return;
	try { return library.stage(title, description, system, existing?.id); }
	catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
}

async function editSavedPrompts(ctx: ExtensionContext, library: SavedPromptLibrary): Promise<void> {
	while (true) {
		const { prompts, errors } = library.list();
		for (const error of errors) ctx.ui.notify(error, "warning");
		const editable = prompts.filter(prompt => prompt.id.startsWith(`${library.scope}/`));
		const labels = editable.map(promptLabel);
		const selected = await ctx.ui.select("Saved compaction prompts", ["Create a prompt", ...labels, back]);
		if (!selected || selected === back) return;
		await editSavedPrompt(ctx, library, editable[labels.indexOf(selected)]);
	}
}

type PolicyField = Exclude<keyof Policy, "auto"> | "auto.enabled" | "auto.threshold";

function fieldValue(p: Policy, field: PolicyField): unknown {
	if (field === "auto.enabled") return p.auto?.enabled;
	if (field === "auto.threshold") return { percent: p.auto?.thresholdPercent, tokens: p.auto?.thresholdTokens };
	return p[field];
}

async function editPolicy(ctx: ExtensionContext, title: string, policy: Policy | Policy[], library?: SavedPromptLibrary, globalDefaults = false, baseline?: Policy | Policy[]): Promise<"remove" | void> {
	const targets = Array.isArray(policy) ? policy : [policy];
	const original = structuredClone(baseline === undefined ? targets : Array.isArray(baseline) ? baseline : [baseline]);
	const p = structuredClone(targets[0]);
	const defaultEffort = globalDefaults ? "Use conversation effort" : inherit;
	const defaultAuto = globalDefaults ? "Use Pi setting" : inherit;
	const defaultThreshold = globalDefaults ? "Use Pi threshold" : inherit;
	const defaultInstructions = globalDefaults ? "No additional instructions" : inherit;
	const dirty = (field: PolicyField) => targets.some((target, index) => JSON.stringify(fieldValue(target, field)) !== JSON.stringify(fieldValue(original[index], field)));
	const display = (field: PolicyField, text: string) => {
		const value = targets.every(target => JSON.stringify(fieldValue(target, field)) === JSON.stringify(fieldValue(targets[0], field))) ? text : "Mixed";
		return `${value}${dirty(field) ? " *" : ""}`;
	};
	while (true) {
		const rows = [
			`Model: ${display("model", globalDefaults && (!p.model || p.model === "current") ? "Use conversation model" : preview(p.model))}`,
			`Effort: ${display("effort", p.effort ?? defaultEffort)}`,
			`Automatic compaction: ${display("auto.enabled", p.auto?.enabled === undefined ? defaultAuto : p.auto.enabled ? "On" : "Off")}`,
			`Context threshold: ${display("auto.threshold", p.auto?.thresholdTokens !== undefined ? `${p.auto.thresholdTokens} tokens` : p.auto?.thresholdPercent === undefined ? defaultThreshold : `${p.auto.thresholdPercent}%`)}`,
			`Summary instructions: ${display("instructions", globalDefaults && !p.instructions ? defaultInstructions : preview(p.instructions))}`,
			`On summary failure: ${display("onError", p.onError === undefined ? globalDefaults ? "Cancel compaction" : inherit : p.onError === "cancel" ? "Cancel compaction" : "Use Pi defaults")}`,
			`Compaction style: ${display("style", p.style ? styleLabels[p.style] : globalDefaults ? "Native Pi" : inherit)}`,
			...(targets.some(target => typeof target.prompt === "string") ? [`Saved prompt: ${display("prompt", String(p.prompt))}`] : []),
			"Save changes", "Discard changes",
			...(Array.isArray(policy) ? ["Remove policies"] : []),
			back,
		];
		const selected = await ctx.ui.select(title, rows);
		if (!selected || selected === back) return;
		if (selected === "Save changes") throw new SaveSettings();
		if (selected === "Discard changes") throw new DiscardSettings();
		if (selected === "Remove policies") return "remove";
		let changed: PolicyField[] = [];
		switch (rows.indexOf(selected)) {
			case 0: {
				const choice = await ctx.ui.select("Compaction model", ["Choose a model", "Use conversation model", ...(globalDefaults ? [] : [inherit])]);
				if (choice === inherit) { delete p.model; changed = ["model"]; }
				else if (choice === "Use conversation model") { p.model = "current"; changed = ["model"]; }
				else if (choice === "Choose a model") {
					const model = await chooseModel(ctx);
					if (model) { p.model = model; changed = ["model"]; }
				}
				break;
			}
			case 1: {
				const choice = await ctx.ui.select("Reasoning effort", [defaultEffort, ...efforts]);
				if (choice === defaultEffort) delete p.effort;
				else if (efforts.some(e => e === choice)) p.effort = choice as Policy["effort"];
				if (choice === defaultEffort || efforts.some(e => e === choice)) changed = ["effort"];
				break;
			}
			case 2: {
				const choice = await ctx.ui.select("Automatic compaction. Pi's master switch still applies.", [defaultAuto, "On", "Off"]);
				if (choice === defaultAuto) { if (p.auto) delete p.auto.enabled; }
				else if (choice) (p.auto ??= {}).enabled = choice === "On";
				if (choice) changed = ["auto.enabled"];
				break;
			}
			case 3: {
				const current = p.auto?.thresholdTokens !== undefined ? `${p.auto.thresholdTokens}` : p.auto?.thresholdPercent !== undefined ? `${p.auto.thresholdPercent}%` : "";
				const input = await ctx.ui.input(`Compact when context reaches (80% or 100000 tokens; blank: ${defaultThreshold})`, current);
				if (input === undefined) break;
				try {
					const threshold = parseThresholdInput(input);
					if (p.auto) { delete p.auto.thresholdPercent; delete p.auto.thresholdTokens; }
					if (Object.keys(threshold).length) Object.assign(p.auto ??= {}, threshold);
					changed = ["auto.threshold"];
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
				break;
			}
			case 4: {
				const choice = await ctx.ui.select("Summary instructions", globalDefaults ? ["Edit instructions", defaultInstructions] : ["Edit instructions", "Clear inherited instructions", inherit]);
				if (choice === defaultInstructions) { delete p.instructions; changed = ["instructions"]; }
				else if (choice === "Clear inherited instructions") { p.instructions = ""; changed = ["instructions"]; }
				else if (choice === "Edit instructions") {
					const instructions = await ctx.ui.editor("Summary instructions", p.instructions ?? "");
					if (instructions !== undefined) { p.instructions = instructions; changed = ["instructions"]; }
				}
				break;
			}
			case 5: {
				const choice = await ctx.ui.select("On summary failure", [...(globalDefaults ? [] : [inherit]), "Cancel compaction", "Use Pi defaults"]);
				if (choice === inherit) delete p.onError;
				else if (choice) p.onError = choice === "Cancel compaction" ? "cancel" : "default";
				if (choice) changed = ["onError"];
				break;
			}
			case 6: {
				const choices = Object.values(styleLabels).filter(label => library || label !== "Saved prompt");
				const choice = await ctx.ui.select("Compaction style", [...(globalDefaults ? [] : [inherit]), ...choices]);
				if (choice === inherit) { delete p.style; changed = ["style"]; }
				else if (choice === "Saved prompt" && library) {
					const id = await chooseSavedPrompt(ctx, library);
					if (id) { p.prompt = id; p.style = "custom"; changed = ["prompt", "style"]; }
				}
				else {
					const style = (Object.keys(styleLabels) as (keyof typeof styleLabels)[]).find(key => styleLabels[key] === choice);
					if (style) { p.style = style; changed = ["style"]; }
				}
				break;
			}
			case 7: {
				if (library) {
					const id = await chooseSavedPrompt(ctx, library);
					if (id) { p.prompt = id; p.style = "custom"; changed = ["prompt", "style"]; }
				}
				break;
			}
		}
		for (const target of targets) {
			for (const field of changed) {
				if (field === "auto.enabled") {
					if (p.auto?.enabled === undefined) { if (target.auto) delete target.auto.enabled; }
					else (target.auto ??= {}).enabled = p.auto.enabled;
				} else if (field === "auto.threshold") {
					if (target.auto) { delete target.auto.thresholdPercent; delete target.auto.thresholdTokens; }
					if (p.auto?.thresholdPercent !== undefined) (target.auto ??= {}).thresholdPercent = p.auto.thresholdPercent;
					if (p.auto?.thresholdTokens !== undefined) (target.auto ??= {}).thresholdTokens = p.auto.thresholdTokens;
				} else if (p[field] === undefined) delete target[field];
				else Object.assign(target, { [field]: structuredClone(p[field]) });
			}
		}
	}
}

async function editModels(ctx: ExtensionContext, config: Config, library?: SavedPromptLibrary, baseline: Config = {}): Promise<void> {
	while (true) {
		const ids = Object.keys(config.models ?? {}).sort();
		const selected = await ctx.ui.select("Policies by conversation model", ["Add models", "Edit models", back]);
		if (!selected || selected === back) return;
		if (selected === "Add models" || selected === "Edit models") {
			const models = await chooseConversationModels(ctx, ids, selected === "Add models" ? "add" : "edit", models => {
				for (const id of models) if (config.models) delete config.models[id];
			});
			if (!models?.length) continue;
			const originals = models.map(id => config.models?.[id] ?? {});
			const policies = structuredClone(originals);
			let remove = false;
			try { remove = await editPolicy(ctx, `Edit ${models.length} conversation models`, policies, library, false, models.map(id => baseline.models?.[id] ?? {})) === "remove"; }
			finally {
				for (let i = 0; i < models.length; i++) {
					if (remove) { if (config.models) delete config.models[models[i]]; }
					else (config.models ??= {})[models[i]] = policies[i];
				}
			}
		}
	}
}

/** Keep changes in memory until the user selects Save changes. */
export async function editConfig(ctx: ExtensionContext, initial: Config, scope: string, library?: SavedPromptLibrary): Promise<Config | undefined> {
	const config = structuredClone(initial);
	try {
		while (true) {
			const selected = await ctx.ui.select(`${scope} compaction settings`, [
				"Defaults", "Policies by conversation model",
				...(library ? ["Saved prompts"] : []),
				"Save changes", "Discard changes",
			]);
			if (!selected || selected === "Discard changes") return;
			if (selected === "Save changes") return config;
			if (selected === "Defaults") await editPolicy(ctx, `${scope} defaults`, config.defaults ??= {}, library, scope === "Global", initial.defaults ?? {});
			else if (selected === "Policies by conversation model") await editModels(ctx, config, library, initial);
			else if (selected === "Saved prompts" && library) await editSavedPrompts(ctx, library);
		}
	} catch (error) {
		if (error instanceof SaveSettings) return config;
		if (error instanceof DiscardSettings) return undefined;
		throw error;
	}
}
