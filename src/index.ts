import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { compact, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelParts, parseConfig, readConfig, resolvePolicy, shouldAutoCompact, type Policy } from "./config.ts";

export default function compaction(pi: ExtensionAPI) {
	const globalPath = join(getAgentDir(), "compaction.json");
	let pending = false;
	function settings(ctx: ExtensionContext): Policy {
		return resolvePolicy(readConfig(globalPath), ctx.isProjectTrusted() ? readConfig(join(ctx.cwd, ".pi", "compaction.json")) : {},
			ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
	}
	function report(ctx: ExtensionContext, error: unknown) {
		ctx.ui.notify(`Compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	pi.on("session_before_compact", async (event, ctx) => {
		let p: Policy;
		try { p = settings(ctx); } catch (error) { report(ctx, error); return { cancel: true }; }
		const automatic = event.reason !== "manual" || pending;
		if (automatic && p.auto?.enabled === false) return { cancel: true };
		// Overflow recovery must run even when the configured threshold is higher.
		if (event.reason === "threshold" && p.auto?.thresholdPercent !== undefined && !shouldAutoCompact(p, ctx.getContextUsage()?.percent)) {
			return { cancel: true };
		}
		if (!p.model && !p.effort && !p.instructions) return;
		try {
			const model = p.model && p.model !== "current" ? ctx.modelRegistry.find(...modelParts(p.model)) : ctx.model;
			if (!model) throw new Error(`Model unavailable: ${p.model ?? "current"}`);
			if (event.signal.aborted) return { cancel: true };
			const instructions = [p.instructions, event.customInstructions].filter(Boolean).join("\n\n") || undefined;
			// Pi's summarizer preserves split turns, file operations, and summary usage.
			const result = await compact(event.preparation, model, undefined, undefined, instructions, event.signal,
				p.effort ?? pi.getThinkingLevel(), (m, context, options) => ctx.modelRegistry.streamSimple(m, context, options),
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
			if (pi.getSettings().compaction?.enabled === false || !shouldAutoCompact(p, ctx.getContextUsage()?.percent)) return;
			pending = true;
			ctx.compact({ onComplete: () => { pending = false; }, onError: (error) => { pending = false; report(ctx, error); } });
		} catch (error) { pending = false; report(ctx, error); }
	});

	pi.registerCommand("compaction-settings", {
		description: "Show effective compaction settings, or edit the global file with 'edit'",
		handler: async (args, ctx) => {
			try {
				if (args.trim() === "edit") {
					if (!ctx.hasUI) throw new Error(`Edit ${globalPath} with a text editor in this mode`);
					let text = "{}\n";
					try { text = readFileSync(globalPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
					const edited = await ctx.ui.editor("Global compaction settings", text);
					if (edited === undefined) return;
					const config = parseConfig(JSON.parse(edited));
					mkdirSync(dirname(globalPath), { recursive: true });
					const temp = `${globalPath}.${randomUUID()}.tmp`;
					writeFileSync(temp, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
					renameSync(temp, globalPath);
				} else if (args.trim()) throw new Error("Use /compaction-settings or /compaction-settings edit");
				ctx.ui.notify(`${globalPath}\nEffective settings for ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"}:\n${JSON.stringify(settings(ctx), null, 2)}`, "info");
			} catch (error) { report(ctx, error); }
		},
	});
}
