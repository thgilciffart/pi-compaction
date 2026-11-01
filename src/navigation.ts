import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class QuitSettings extends Error {}
export class SaveSettings extends Error {}
export class DiscardSettings extends Error {}

/** Distinguish quitting the settings flow from cancelling its current dialog. */
export async function withSettingsNavigation<T>(ctx: ExtensionContext, run: (ctx: ExtensionContext) => Promise<T>): Promise<T | undefined> {
	let quit = false;
	let save = false;
	let dialogKind: "select" | "input" | "custom" = "select";
	let allowDelete = false;
	let remove = false;
	const unsubscribe = ctx.ui.onTerminalInput(data => {
		if (matchesKey(data, "ctrl+c")) {
			quit = true;
			// Dismiss the active native dialog. Its result then unwinds the flow.
			return { data: "\x1b" };
		}
		if (matchesKey(data, "ctrl+s")) {
			save = true;
			return { data: dialogKind === "select" ? "\x1b" : dialogKind === "custom" ? data : "\r" };
		}
		if (matchesKey(data, "delete") && dialogKind === "select" && allowDelete) {
			remove = true;
			return { data: "\x1b" };
		}
		return undefined;
	});
	async function dialog<R>(kind: typeof dialogKind, open: () => Promise<R>): Promise<R> {
		if (quit) throw new QuitSettings();
		if (save) throw new SaveSettings();
		dialogKind = kind;
		const result = await open();
		if (quit) throw new QuitSettings();
		if (save && kind === "select") throw new SaveSettings();
		return result;
	}
	const navigationContext: ExtensionContext = { ...ctx, ui: {
		...ctx.ui,
		select: async (title, options, opts) => {
			allowDelete = options.includes("Remove policies");
			try {
				const result = await dialog("select", () => ctx.ui.select(title, options, opts));
				if (remove) { remove = false; return "Remove policies"; }
				return result;
			} finally { allowDelete = false; }
		},
		input: (title, placeholder, opts) => dialog("input", () => ctx.ui.input(title, placeholder, opts)),
		editor: (title, prefill) => dialog("input", () => ctx.ui.editor(title, prefill)),
		custom: (factory, options) => dialog("custom", () => ctx.ui.custom(factory, options)),
	} };
	try { return await run(navigationContext); }
	catch (error) { if (!(error instanceof QuitSettings) && !(error instanceof SaveSettings)) throw error; }
	finally { unsubscribe(); }
}
