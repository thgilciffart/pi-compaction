import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { efforts, type Config, type Policy } from "./config.ts";

const inherit = "Inherit";
const back = "Back";

function preview(value: string | undefined): string {
	return value === undefined ? inherit : value.replace(/\s+/g, " ").slice(0, 60) || "Empty";
}

async function chooseModel(ctx: ExtensionContext, rule = false): Promise<string | undefined> {
	const models = rule ? ctx.modelRegistry.getAll() : ctx.modelRegistry.getAvailable();
	const ids = new Set(models.map(m => `${m.provider}/${m.id}`));
	if (rule && ctx.model) ids.add(`${ctx.model.provider}/${ctx.model.id}`);
	if (ids.size === 0) {
		ctx.ui.notify("No models with configured credentials are available. Configure a provider in Pi first.", "warning");
		return;
	}
	const providers = [...new Set([...ids].map(id => id.slice(0, id.indexOf("/"))))].sort();
	const provider = await ctx.ui.select(rule ? "Conversation model" : "Compaction model provider", [...providers, back]);
	if (!provider || provider === back) return;
	return ctx.ui.select("Choose a model", [...ids].filter(id => id.startsWith(`${provider}/`)).sort());
}

async function editPolicy(ctx: ExtensionContext, title: string, p: Policy): Promise<void> {
	while (true) {
		const rows = [
			`Model: ${preview(p.model)}`,
			`Effort: ${p.effort ?? inherit}`,
			`Automatic compaction: ${p.auto?.enabled === undefined ? inherit : p.auto.enabled ? "On" : "Off"}`,
			`Context threshold: ${p.auto?.thresholdPercent === undefined ? inherit : `${p.auto.thresholdPercent}%`}`,
			`Summary instructions: ${preview(p.instructions)}`,
			`On summary failure: ${p.onError === undefined ? inherit : p.onError === "cancel" ? "Cancel compaction" : "Use Pi defaults"}`,
			back,
		];
		const selected = await ctx.ui.select(title, rows);
		if (!selected || selected === back) return;
		switch (rows.indexOf(selected)) {
			case 0: {
				const choice = await ctx.ui.select("Compaction model", ["Choose a model", "Use conversation model", inherit]);
				if (choice === inherit) delete p.model;
				else if (choice === "Use conversation model") p.model = "current";
				else if (choice === "Choose a model") {
					const model = await chooseModel(ctx);
					if (model) p.model = model;
				}
				break;
			}
			case 1: {
				const choice = await ctx.ui.select("Reasoning effort", [inherit, ...efforts]);
				if (choice === inherit) delete p.effort;
				else if (efforts.some(e => e === choice)) p.effort = choice as Policy["effort"];
				break;
			}
			case 2: {
				const choice = await ctx.ui.select("Automatic compaction. Pi's master switch still applies.", [inherit, "On", "Off"]);
				if (choice === inherit) { if (p.auto) delete p.auto.enabled; }
				else if (choice) (p.auto ??= {}).enabled = choice === "On";
				break;
			}
			case 3: {
				const choice = await ctx.ui.select("Compact when context reaches", [inherit, "50%", "60%", "70%", "75%", "80%", "85%", "90%", "Custom percentage"]);
				if (choice === inherit) { if (p.auto) delete p.auto.thresholdPercent; }
				else if (choice) {
					let value: number;
					if (choice === "Custom percentage") {
						const input = await ctx.ui.input("Context percentage, greater than 0 and less than 100", String(p.auto?.thresholdPercent ?? 75));
						if (input === undefined) break;
						value = Number(input.trim());
					} else value = Number(choice.slice(0, -1));
					if (!Number.isFinite(value) || value <= 0 || value >= 100) ctx.ui.notify("Enter a percentage greater than 0 and less than 100.", "error");
					else (p.auto ??= {}).thresholdPercent = value;
				}
				break;
			}
			case 4: {
				const choice = await ctx.ui.select("Summary instructions", ["Edit instructions", "Clear inherited instructions", inherit]);
				if (choice === inherit) delete p.instructions;
				else if (choice === "Clear inherited instructions") p.instructions = "";
				else if (choice === "Edit instructions") {
					const instructions = await ctx.ui.editor("Summary instructions", p.instructions ?? "");
					if (instructions !== undefined) p.instructions = instructions;
				}
				break;
			}
			case 5: {
				const choice = await ctx.ui.select("On summary failure", [inherit, "Cancel compaction", "Use Pi defaults"]);
				if (choice === inherit) delete p.onError;
				else if (choice) p.onError = choice === "Cancel compaction" ? "cancel" : "default";
				break;
			}
		}
	}
}

async function editModels(ctx: ExtensionContext, config: Config): Promise<void> {
	while (true) {
		const ids = Object.keys(config.models ?? {}).sort();
		const selected = await ctx.ui.select("Policies by conversation model", ["Add a model", ...ids, back]);
		if (!selected || selected === back) return;
		if (selected === "Add a model") {
			const id = await chooseModel(ctx, true);
			if (id) await editPolicy(ctx, id, (config.models ??= {})[id] ??= {});
		} else {
			const action = await ctx.ui.select(selected, ["Edit policy", "Remove policy", back]);
			if (action === "Edit policy") await editPolicy(ctx, selected, config.models![selected]);
			else if (action === "Remove policy") delete config.models![selected];
		}
	}
}

/** Keep changes in memory until the user selects Save changes. */
export async function editConfig(ctx: ExtensionContext, initial: Config, scope: string): Promise<Config | undefined> {
	const config = structuredClone(initial);
	while (true) {
		const selected = await ctx.ui.select(`${scope} compaction settings`, [
			"Defaults", "Policies by conversation model", "Override all models", "Save changes", "Discard changes",
		]);
		if (!selected || selected === "Discard changes") return;
		if (selected === "Save changes") return config;
		if (selected === "Defaults") await editPolicy(ctx, `${scope} defaults`, config.defaults ??= {});
		else if (selected === "Override all models") await editPolicy(ctx, `${scope} override. These values take precedence over model policies.`, config.override ??= {});
		else if (selected === "Policies by conversation model") await editModels(ctx, config);
	}
}
