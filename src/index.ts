import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { compact, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editConfig } from "./editor.ts";
import { withSettingsNavigation } from "./navigation.ts";
import { withPromptStyle } from "./prompts.ts";
import { resolveSavedPrompt, SavedPromptLibrary, type PromptDirectories, type ResolvedPolicy } from "./saved-prompts.ts";
import { modelParts, parseConfig, readConfig, resolvePolicy, shouldAutoCompact } from "./config.ts";

export default function compaction(pi: ExtensionAPI) {
	const globalPath = join(getAgentDir(), "compaction.json");
	let pending = false;
	function promptDirectories(ctx: ExtensionContext): PromptDirectories {
		return { global: join(dirname(globalPath), "compaction-prompts"),
			project: ctx.isProjectTrusted() ? join(ctx.cwd, ".pi", "compaction-prompts") : undefined };
	}
	function settings(ctx: ExtensionContext): ResolvedPolicy {
		return resolveSavedPrompt(resolvePolicy(readConfig(globalPath), ctx.isProjectTrusted() ? readConfig(join(ctx.cwd, ".pi", "compaction.json")) : {},
			ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : ""), promptDirectories(ctx));
	}
	function report(ctx: ExtensionContext, error: unknown) {
		ctx.ui.notify(`Compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	pi.on("session_before_compact", async (event, ctx) => {
		let p: ResolvedPolicy;
		try { p = settings(ctx); } catch (error) { report(ctx, error); return { cancel: true }; }
		const automatic = event.reason !== "manual" || pending;
		if (automatic && p.auto?.enabled === false) return { cancel: true };
		// Overflow recovery must run even when the configured threshold is higher.
		if (event.reason === "threshold" && (p.auto?.thresholdPercent !== undefined || p.auto?.thresholdTokens !== undefined)) {
			const usage = ctx.getContextUsage();
			if (!shouldAutoCompact(p, usage?.percent, usage?.tokens)) return { cancel: true };
		}
		if (!p.model && !p.effort && !p.instructions && (!p.style || p.style === "native")) return;
		try {
			const model = p.model && p.model !== "current" ? ctx.modelRegistry.find(...modelParts(p.model)) : ctx.model;
			if (!model) throw new Error(`Model unavailable: ${p.model ?? "current"}`);
			if (event.signal.aborted) return { cancel: true };
			const instructions = [p.instructions, event.customInstructions].filter(Boolean).join("\n\n") || undefined;
			const stream = withPromptStyle(p, event.preparation, instructions,
				(m, context, options) => ctx.modelRegistry.streamSimple(m, context, options));
			// Pi's summarizer preserves split turns, file operations, and summary usage.
			const result = await compact(event.preparation, model, undefined, undefined, instructions, event.signal,
				p.effort ?? pi.getThinkingLevel(), stream,
				undefined, { enabled: true, maxRetries: 3, baseDelayMs: 2000, ...pi.getSettings().retry });
			return { compaction: result };
		} catch (error) {
			if (event.signal.aborted) return { cancel: true };
			report(ctx, error);
			if (p.onError === "default") {
				ctx.ui.notify("Using Pi's default compaction model and effort", "warning");
				return;
			}
			return { cancel: true };
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || pending || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		try {
			const p = settings(ctx);
			// Pi's auto-compaction switch remains the master switch.
			const usage = ctx.getContextUsage();
			if (pi.getSettings().compaction?.enabled === false || !shouldAutoCompact(p, usage?.percent, usage?.tokens)) return;
			pending = true;
			ctx.compact({ onComplete: () => { pending = false; }, onError: (error) => { pending = false; report(ctx, error); } });
		} catch (error) { pending = false; report(ctx, error); }
	});

	pi.registerCommand("compaction-settings", {
		description: "Open the compaction settings menu, or use 'show' to view the effective policy",
		handler: async (args, ctx) => {
			try {
				const action = args.trim();
				if (action && action !== "edit" && action !== "show") throw new Error("Use /compaction-settings or /compaction-settings show");
				if (action === "show" || (!action && !ctx.hasUI)) {
					ctx.ui.notify(`${globalPath}\nEffective settings for ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"}:\n${JSON.stringify(settings(ctx), null, 2)}`, "info");
					return;
				}
				if (!ctx.hasUI) throw new Error(`Edit ${globalPath} with a text editor in this mode`);
				await withSettingsNavigation(ctx, async ctx => {
					const scope = ctx.isProjectTrusted() ? await ctx.ui.select("Edit compaction settings", ["Global", "This project"]) : "Global";
					if (!scope) return;
					const path = scope === "Global" ? globalPath : join(ctx.cwd, ".pi", "compaction.json");
					const library = new SavedPromptLibrary(() => promptDirectories(ctx), scope === "Global" ? "global" : "project");
					const edited = await editConfig(ctx, readConfig(path), scope, library);
					if (edited === undefined) return;
					// Recheck trust after dialogs before writing project settings.
					if (scope !== "Global" && !ctx.isProjectTrusted()) throw new Error("Project trust is required to save project settings");
					const config = parseConfig(edited);
					library.commit();
					mkdirSync(dirname(path), { recursive: true });
					const temp = `${path}.${randomUUID()}.tmp`;
					writeFileSync(temp, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
					renameSync(temp, path);
					ctx.ui.notify(`Saved ${scope.toLowerCase()} compaction settings. Changes apply at the next compaction check.`, "info");
				});
			} catch (error) { report(ctx, error); }
		},
	});
}
