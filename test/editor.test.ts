import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { editConfig } from "../src/editor.ts";
import extension from "../src/index.ts";
import { readSavedPrompt, SavedPromptLibrary } from "../src/saved-prompts.ts";
import { withSettingsNavigation } from "../src/navigation.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ConversationModelPicker } from "../src/model-picker.ts";

initTheme("dark", false);

function ui(choices: (string | undefined)[], inputs: (string | undefined)[] = []) {
	const notices: string[] = [];
	const editorPrefills: (string | undefined)[] = [];
	const menus: { title: string; options: string[] }[] = [];
	const listeners = new Set<TerminalInputHandler>();
	function input(value: string | undefined) {
		if (value === "\x1b[3~") {
			for (const listener of listeners) assert.equal(listener(value)?.data, "\x1b");
			return undefined;
		}
		if (value === "\x13" || value?.startsWith("SAVE:")) {
			for (const listener of listeners) assert.ok(listener("\x13")?.data);
			return value === "\x13" ? undefined : value.slice(5);
		}
		if (value !== "\x03" && value !== "\x1b[99;5u") return value;
		for (const listener of listeners) assert.equal(listener(value)?.data, "\x1b");
		return undefined;
	}
	const ctx = {
		hasUI: true, isProjectTrusted: () => false,
		model: { provider: "test", id: "chat" },
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [{ provider: "test", id: "summary" }],
			getAll: () => [{ provider: "test", id: "chat" }],
		},
		ui: {
			onTerminalInput: (handler: TerminalInputHandler) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
			select: async (_title: string, options: string[]) => {
				menus.push({ title: _title, options: [...options] });
				assert.ok(choices.length, `Unexpected menu: ${_title}`);
				const choice = input(choices.shift());
				if (choice === undefined) return;
				const match = options.find(o => o === choice || o === `${choice} *`) ?? options.find(o => o.startsWith(`${choice}:`));
				assert.ok(match, `Missing option ${choice} in ${options.join(", ")}`);
				return match;
			},
			input: async () => input(inputs.shift()),
			editor: async (_title: string, prefill?: string) => {
				editorPrefills.push(prefill);
				const value = input(inputs.shift());
				return value === "KEEP_VALUE" ? prefill : value;
			},
			custom: async (factory: any) => new Promise(resolve => {
				const component = factory({ requestRender() {} }, undefined, undefined, resolve);
				if (component instanceof ConversationModelPicker) {
					const script = choices.shift();
					if (!script || script === "PICK_CANCEL") { component.handleInput("\x1b"); return; }
					assert.ok(script.startsWith("PICK:") || script.startsWith("SAVE_PICK:") || script.startsWith("DELETE_PICK:"), `Unexpected picker action: ${script}`);
					while (!component.render(200)[0].includes("[all]")) component.handleInput("\t");
					for (const id of script.slice(script.indexOf(":") + 1).split(",").filter(Boolean)) {
						component.handleInput("\x1b[H");
						let steps = 0;
						const slash = id.indexOf("/");
						while (!component.render(200).some(row => row.startsWith("→ ") && row.endsWith(` ${id.slice(slash + 1)} [${id.slice(0, slash)}]`))) {
							assert.ok(steps++ < 100, `Model missing from picker: ${id}`);
							component.handleInput("\x1b[B");
						}
						component.handleInput(" ");
					}
					if (script.startsWith("DELETE_PICK:")) {
						component.handleInput("\x1b[3~");
						component.handleInput("\x1b");
					} else if (script.startsWith("SAVE_PICK:")) {
						for (const listener of listeners) assert.equal(listener("\x13")?.data, "\x13");
						component.handleInput("\x13");
					} else component.handleInput("\r");
					return;
				}
				const value = input(inputs.shift());
				if (value === undefined) component.handleInput("\x1b");
				else {
					if (value !== "KEEP_VALUE") {
						component.handleInput("\x01");
						component.handleInput("\x0b");
						component.handleInput(value);
					}
					component.handleInput("\r");
				}
				component.dispose();
			}),
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, editorPrefills, menus, done: () => { assert.equal(choices.length, 0); assert.equal(inputs.length, 0); assert.equal(listeners.size, 0); } };
}

function promptLibrary(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-editor-library-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return new SavedPromptLibrary(() => ({ global: join(dir, "prompts") }), "global");
}

test("Ctrl+C quits the entire flow from menus, inputs, and editors", async () => {
	for (const [choices, inputs] of [
		[["\x03"], []],
		[["Defaults", "Effort", "high", "Effort", "\x1b[99;5u"], []],
		[["Defaults", "Context threshold"], ["\x03"]],
	]) {
		const f = ui(choices, inputs);
		const original = { defaults: { effort: "low" as const } };
		assert.equal(await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, original, "Global")), undefined);
		assert.deepEqual(original, { defaults: { effort: "low" } });
		f.done();
	}
});

test("Escape returns through nested menus and preserves pending edits", async () => {
	const f = ui(["Defaults", "Effort", "high", "Effort", undefined,
		"Model", "Choose a model", "test", undefined, undefined, undefined, "Save changes"]);
	const result = await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, {}, "Global"));
	assert.equal(result?.defaults?.effort, "high");
	f.done();
});

test("navigation removes its terminal listener after errors", async () => {
	const f = ui([]);
	await assert.rejects(withSettingsNavigation(f.ctx, async () => { throw new Error("UI failed"); }), /UI failed/);
	f.done();
});

test("Ctrl+S saves from menus, threshold inputs, model pickers, and batch edits", async () => {
	for (const [choices, inputs, expected] of [
		[["Defaults", "Effort", "high", "\x13"], [], { defaults: { effort: "high" } }],
		[["Defaults", "Context threshold"], ["SAVE:100k"], { defaults: { auto: { thresholdTokens: 100000 } } }],
		[["Policies by conversation model", "Add models", "SAVE_PICK:test/chat"], [], { models: { "test/chat": {} } }],
		[["Policies by conversation model", "Edit models", "PICK:test/chat", "Effort", "high", "\x13"], [], { models: { "test/chat": { effort: "high" } } }],
		[["Policies by conversation model", "Edit models", "SAVE_PICK:"], [], {}],
	] as const) {
		const f = ui([...choices], [...inputs]);
		assert.deepEqual(await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, {}, "Global")), expected);
		f.done();
	}
});

test("Ctrl+S commits saved Markdown prompt edits through the command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-settings-save-key-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		let command: any;
		extension({ on: () => {}, registerCommand: (_name: string, c: any) => { command = c; } } as unknown as ExtensionAPI);
		const f = ui(["Saved prompts", "Create a prompt"], ["Review", "", "SAVE:Keep review findings"]);
		await command.handler("", f.ctx);
		assert.equal(readSavedPrompt("global/review", { global: join(dir, "compaction-prompts") }).system, "Keep review findings");
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "compaction.json"), "utf8")), {});
		f.done();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Ctrl+C after staging a Markdown prompt exits the command without writing files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompt-quit-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		let command: any;
		extension({ on: () => {}, registerCommand: (_name: string, c: any) => { command = c; } } as unknown as ExtensionAPI);
		const f = ui(["Saved prompts", "Create a prompt", "\x03"], ["Draft", "", "Draft body"]);
		await command.handler("", f.ctx);
		assert.equal(existsSync(join(dir, "compaction-prompts")), false);
		assert.equal(existsSync(join(dir, "compaction.json")), false);
		assert.deepEqual(f.notices, []);
		f.done();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("menus edit every policy field without JSON", async () => {
	const f = ui([
		"Defaults", "Model", "Choose a model", "test", "test/summary",
		"Effort", "high", "Automatic compaction", "Off", "Context threshold",
		"Summary instructions", "Edit instructions", "On summary failure", "Use Pi defaults", "Back", "Save changes",
	], ["82.5%", "Preserve test results"]);
	assert.deepEqual(await editConfig(f.ctx, {}, "Global"), {
		defaults: { model: "test/summary", effort: "high", auto: { enabled: false, thresholdPercent: 82.5 }, instructions: "Preserve test results", onError: "default" },
	});
	f.done();
});

test("style picker supports presets, saved prompts, and inheritance", async t => {
	for (const [label, style] of [["Native Pi", "native"], ["Claude Code-style", "claude-code"], ["Codex-style", "codex"]]) {
		const f = ui(["Defaults", "Compaction style", label, "Back", "Save changes"]);
		assert.equal((await editConfig(f.ctx, {}, "Global"))?.defaults?.style, style);
		f.done();
	}
	const f = ui(["Defaults", "Compaction style", "Saved prompt", "Create a prompt", "Back", "Save changes"], ["My prompt", "", "My system prompt"]);
	const config = await editConfig(f.ctx, {}, "Global", promptLibrary(t));
	assert.deepEqual(config?.defaults, { style: "custom", prompt: "global/my-prompt" });
	f.done();
	const g = ui(["Defaults", "Compaction style", "Inherit", "Back", "Save changes"]);
	assert.equal((await editConfig(g.ctx, config!, "Project"))?.defaults?.style, undefined);
	g.done();
});

test("cancelled or empty saved prompt creation leaves the selected style unchanged", async t => {
	for (const inputs of [[undefined], ["Title", undefined], ["Title", "", undefined], [" ", "", "body"], ["Title", "", " "]]) {
		const f = ui(["Defaults", "Compaction style", "Saved prompt", "Create a prompt", "Back", "Save changes"], inputs);
		assert.deepEqual((await editConfig(f.ctx, { defaults: { style: "codex" } }, "Global", promptLibrary(t)))?.defaults, { style: "codex" });
		f.done();
	}
});

test("declining prompt creation keeps the existing style", async t => {
	const f = ui(["Defaults", "Compaction style", "Saved prompt", "Back", "Back", "Save changes"]);
	const library = promptLibrary(t);
	assert.deepEqual((await editConfig(f.ctx, { defaults: { style: "codex" } }, "Global", library))?.defaults, { style: "codex" });
	assert.equal(library.list().prompts.length, 0);
	f.done();
});

test("saved prompt edits prefill title, description, and body and allow clearing descriptions", async t => {
	const library = promptLibrary(t);
	library.stage("Review", "Keep findings", "Existing body");
	library.commit();
	const f = ui(["Saved prompts", "Review [global/review]: Keep findings", "Back", "Save changes"], ["KEEP_VALUE", "KEEP_VALUE", "KEEP_VALUE"]);
	await editConfig(f.ctx, {}, "Global", library);
	library.commit();
	assert.deepEqual(library.list().prompts[0], { id: "global/review", title: "Review", description: "Keep findings", system: "Existing body" });
	assert.deepEqual(f.editorPrefills, ["Existing body"]);
	f.done();
	const g = ui(["Saved prompts", "Review [global/review]: Keep findings", "Back", "Save changes"], ["KEEP_VALUE", "", "KEEP_VALUE"]);
	await editConfig(g.ctx, {}, "Global", library);
	library.commit();
	assert.equal(library.list().prompts[0].description, undefined);
	assert.equal(library.list().prompts[0].title, "Review");
	g.done();
});

test("Ctrl+C during saved prompt creation quits without staging a prompt", async t => {
	for (const inputs of [["\x03"], ["Title", "\x03"], ["Title", "", "\x03"]]) {
		const library = promptLibrary(t);
		const f = ui(["Defaults", "Compaction style", "Saved prompt", "Create a prompt"], inputs);
		assert.equal(await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, {}, "Global", library)), undefined);
		assert.equal(library.list().prompts.length, 0);
		f.done();
	}
});

test("inherit removes explicit values while conversation model resets an inherited model", async () => {
	const f = ui(["Defaults", "Model", "Use conversation model", "Effort", "Inherit", "Automatic compaction", "Inherit",
		"Context threshold", "Summary instructions", "Inherit", "On summary failure", "Inherit", "Back", "Save changes"], [""]);
	assert.deepEqual(await editConfig(f.ctx, { defaults: { model: "test/summary", effort: "low", auto: { enabled: false, thresholdPercent: 90 }, instructions: "Keep decisions", onError: "default" } }, "Project"), {
		defaults: { model: "current", auto: {} },
	});
	f.done();
});

test("global defaults reset fields using explicit default choices", async () => {
	const f = ui(["Defaults", "Model", "Use conversation model", "Effort", "Use conversation effort", "Automatic compaction", "Use Pi setting",
		"Context threshold", "Summary instructions", "No additional instructions", "On summary failure", "Cancel compaction",
		"Compaction style", "Native Pi", "Back", "Save changes"], [""]);
	assert.deepEqual(await editConfig(f.ctx, { defaults: { model: "test/summary", effort: "high", auto: { enabled: false, thresholdPercent: 90 },
		instructions: "Keep decisions", onError: "default", style: "codex" } }, "Global"), {
		defaults: { model: "current", auto: {}, onError: "cancel", style: "native" },
	});
	f.done();
});

test("invalid percentages keep the previous threshold and cancelled input leaves values unchanged", async () => {
	const f = ui(["Defaults", "Context threshold", "Context threshold", "Effort", undefined, "Back", "Save changes"], ["100%", undefined]);
	assert.deepEqual(await editConfig(f.ctx, { defaults: { auto: { thresholdPercent: 75 }, effort: "low" } }, "Global"), {
		defaults: { auto: { thresholdPercent: 75 }, effort: "low" },
	});
	assert.ok(f.notices.some(n => n.includes("greater than 0")));
	f.done();
});

test("threshold input switches between tokens and percent, and blank clears both", async () => {
	const initial = { defaults: { auto: { enabled: false, thresholdPercent: 75 } } };
	const f = ui(["Defaults", "Context threshold: 75%", "Context threshold: 100000 tokens", "Back", "Save changes"], ["100k", "85%"]);
	assert.deepEqual((await editConfig(f.ctx, initial, "Global"))?.defaults?.auto, { enabled: false, thresholdPercent: 85 });
	f.done();
	const g = ui(["Defaults", "Context threshold", "Back", "Save changes"], [""]);
	assert.deepEqual((await editConfig(g.ctx, { defaults: { auto: { thresholdTokens: 100000 } } }, "Global"))?.defaults?.auto, {});
	g.done();
});

test("batch threshold input replaces both units and preserves automatic compaction switches", async () => {
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat,test/old",
		"Context threshold: Mixed", "Back", "Back", "Save changes"], ["100000"]);
	const result = await editConfig(f.ctx, { models: {
		"test/chat": { auto: { enabled: false, thresholdTokens: 90000 } },
		"test/old": { auto: { enabled: true, thresholdPercent: 85 } },
	} }, "Global");
	assert.deepEqual(result?.models?.["test/chat"].auto, { enabled: false, thresholdTokens: 100000 });
	assert.deepEqual(result?.models?.["test/old"].auto, { enabled: true, thresholdTokens: 100000 });
	f.done();
});

test("model policies can be added, edited, and removed", async () => {
	const f = ui(["Policies by conversation model", "Add models", "PICK:test/chat", "Effort", "off", "Back", "Back",
		"Policies by conversation model", "Edit models", "PICK:test/old", "Remove policies", "Back", "Save changes"]);
	assert.deepEqual(await editConfig(f.ctx, { models: { "test/old": { effort: "low" } } }, "Global"), {
		models: { "test/chat": { effort: "off" } },
	});
	f.done();
});

test("Delete in the picker removes policies only from the pending configuration", async () => {
	const initial = { models: { "test/chat": {}, "test/old": { effort: "low" as const } } };
	const f = ui(["Policies by conversation model", "Edit models", "DELETE_PICK:test/old", "Back", "Save changes"]);
	assert.deepEqual(await editConfig(f.ctx, initial, "Global"), { models: { "test/chat": {} } });
	assert.equal(initial.models["test/old"].effort, "low");
	f.done();
});

test("Delete in a policy editor removes all edited models and can be saved or discarded", async () => {
	for (const save of [true, false]) {
		const initial = { models: { "test/chat": {}, "test/old": { effort: "low" as const } } };
		const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat,test/old", "\x1b[3~", "Back", save ? "Save changes" : "Discard changes"]);
		const result = await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, initial, "Global"));
		assert.deepEqual(result, save ? { models: {} } : undefined);
		assert.equal(initial.models["test/old"].effort, "low");
		f.done();
	}
});

test("batch edits preserve unrelated values and apply inheritance across mixed policies", async () => {
	const initial = { models: {
		"test/one": { effort: "low" as const, auto: { enabled: false, thresholdPercent: 60 }, style: "custom" as const, prompt: "global/one" },
		"other/two": { effort: "high" as const, auto: { enabled: true, thresholdPercent: 90 }, style: "custom" as const, prompt: "global/two" },
		"test/untouched": { effort: "medium" as const },
	} };
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/one,other/two", "Effort: Mixed", "Inherit",
		"Context threshold: Mixed", "Compaction style", "Native Pi", "Back", "Back", "Save changes"], ["80%"]);
	const result = await editConfig(f.ctx, initial, "Global");
	assert.deepEqual(result?.models, {
		"test/one": { auto: { enabled: false, thresholdPercent: 80 }, style: "native", prompt: "global/one" },
		"other/two": { auto: { enabled: true, thresholdPercent: 80 }, style: "native", prompt: "global/two" },
		"test/untouched": { effort: "medium" },
	});
	assert.equal(initial.models["test/one"].effort, "low");
	f.done();
});

test("batch selection can edit a new model policy from the all-model view", async t => {
	const library = promptLibrary(t);
	library.stage("Shared", "", "Shared system");
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat", "Compaction style", "Saved prompt", "Shared [global/shared]", "Back", "Back", "Save changes"]);
	const result = await editConfig(f.ctx, { models: { "test/old": { effort: "low" } } }, "Global", library);
	assert.deepEqual(result?.models, {
		"test/old": { effort: "low" },
		"test/chat": { style: "custom", prompt: "global/shared" },
	});
	f.done();
});

test("batch edits can remove auto fields even when the first model already inherits them", async () => {
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat,test/old",
		"Automatic compaction: Mixed", "Inherit", "Context threshold: Mixed", "Compaction style", "Native Pi", "Back", "Back", "Save changes"], [""]);
	const result = await editConfig(f.ctx, { models: { "test/old": { auto: { enabled: false, thresholdPercent: 85 } } } }, "Global");
	assert.deepEqual(result?.models?.["test/old"].auto, {});
	assert.equal(result?.models?.["test/chat"].auto, undefined);
	assert.equal(result?.models?.["test/old"].style, "native");
	f.done();
});

test("cancelling selection adds nothing, while entering an unadded model editor adds it", async () => {
	for (const [choices, expected] of [
		[["Policies by conversation model", "Edit models", "PICK_CANCEL", "Back", "Save changes"], {}],
		[["Policies by conversation model", "Edit models", "PICK:test/chat", "Effort", undefined, "Back", "Back", "Save changes"], { models: { "test/chat": {} } }],
	] as const) {
		const f = ui([...choices]);
		assert.deepEqual(await editConfig(f.ctx, {}, "Global"), expected);
		f.done();
	}
});

test("multi-model Save changes and Ctrl+S include unadded models even without field changes", async () => {
	for (const save of ["Save changes", "\x13"]) {
		const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat,test/old", save]);
		const result = await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, { models: { "test/old": { effort: "low" } } }, "Global"));
		assert.deepEqual(result?.models, { "test/chat": {}, "test/old": { effort: "low" } });
		f.done();
	}
});

test("multi-model Save changes applies edited fields before returning settings", async () => {
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat,test/old", "Effort", "high", "Save changes"]);
	const result = await editConfig(f.ctx, { models: { "test/old": { auto: { enabled: false } } } }, "Global");
	assert.deepEqual(result?.models, { "test/chat": { effort: "high" }, "test/old": { auto: { enabled: false }, effort: "high" } });
	assert.ok(f.menus.some(menu => menu.options.includes("Effort: high *")));
	f.done();
});

test("policy Discard changes closes settings and discards new model entries and prior edits", async () => {
	const initial = { defaults: { effort: "low" as const } };
	const f = ui(["Defaults", "Effort", "high", "Back", "Policies by conversation model", "Edit models", "PICK:test/chat",
		"Effort", "low", "Discard changes"]);
	assert.equal(await editConfig(f.ctx, initial, "Global"), undefined);
	assert.deepEqual(initial, { defaults: { effort: "low" } });
	f.done();
});

test("dirty markers persist when reopening a policy and clear when its value is restored", async () => {
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat", "Effort", "high", "Back",
		"Edit models", "PICK:test/chat", "Effort: high *", "low", "Back", "Back", "Save changes"]);
	await editConfig(f.ctx, { models: { "test/chat": { effort: "low" } } }, "Global");
	const lastPolicyMenu = f.menus.filter(menu => menu.title === "Edit 1 conversation models").at(-1);
	assert.ok(lastPolicyMenu?.options.includes("Effort: low"));
	assert.ok(!lastPolicyMenu?.options.includes("Effort: low *"));
	assert.deepEqual(f.menus.at(-2)?.options, ["Add models", "Edit models", "Back"]);
	f.done();
});

test("Ctrl+C discards batch policy edits", async () => {
	const f = ui(["Policies by conversation model", "Edit models", "PICK:test/chat,test/old",
		"Effort", "high", "\x03"]);
	const initial = { models: { "test/old": { effort: "low" as const } } };
	assert.equal(await withSettingsNavigation(f.ctx, ctx => editConfig(ctx, initial, "Global")), undefined);
	assert.equal(initial.models["test/old"].effort, "low");
	f.done();
});

test("discard and Escape leave the original config unchanged", async () => {
	for (const exit of ["Discard changes", undefined]) {
		const original = { defaults: { effort: "low" as const } };
		const f = ui(["Defaults", "Effort", "high", "Back", exit]);
		assert.equal(await editConfig(f.ctx, original, "Global"), undefined);
		assert.deepEqual(original, { defaults: { effort: "low" } });
		f.done();
	}
});

test("the command saves global or trusted project settings and defaults to the menu", async () => {
	for (const project of [false, true]) {
		const dir = mkdtempSync(join(tmpdir(), "pi-compaction-editor-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			let command: any;
			extension({ on: () => {}, registerCommand: (_name: string, c: any) => { command = c; } } as unknown as ExtensionAPI);
			const f = ui([...(project ? ["This project"] : []), "Defaults", "Effort", "minimal", "Back", "Save changes"]);
			f.ctx.cwd = join(dir, "project");
			f.ctx.isProjectTrusted = () => project;
			await command.handler("", f.ctx);
			const path = project ? join(f.ctx.cwd, ".pi", "compaction.json") : join(dir, "compaction.json");
			assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { defaults: { effort: "minimal" } });
			if (project) assert.equal(existsSync(join(dir, "compaction.json")), false);
			assert.ok(f.notices.some(n => n.startsWith("Saved")));
			f.done();
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("settings create, edit, select, and save Markdown prompts with optional descriptions", async () => {
	for (const project of [false, true]) {
		const dir = mkdtempSync(join(tmpdir(), "pi-prompt-editor-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			let command: any;
			extension({ on: () => {}, registerCommand: (_name: string, c: any) => { command = c; } } as unknown as ExtensionAPI);
			const scope = project ? "project" : "global";
			const id = `${scope}/review`;
			const f = ui([...(project ? ["This project"] : []), "Saved prompts", "Create a prompt", `Review [${id}]`, "Back",
				"Defaults", "Compaction style", "Saved prompt", `Review renamed [${id}]: Keep errors`, "Back", "Save changes"],
			["Review", "", "Original body", "Review renamed", "Keep errors", "Updated system"]);
			f.ctx.cwd = join(dir, "project");
			f.ctx.isProjectTrusted = () => project;
			await command.handler("", f.ctx);
			const directory = project ? join(f.ctx.cwd, ".pi") : dir;
			const saved = readSavedPrompt(id, { global: join(dir, "compaction-prompts"), project: join(f.ctx.cwd, ".pi", "compaction-prompts") });
			assert.equal(saved.title, "Review renamed");
			assert.equal(saved.description, "Keep errors");
			assert.equal(saved.system, "Updated system");
			assert.equal(JSON.parse(readFileSync(join(directory, "compaction.json"), "utf8")).defaults.prompt, id);
			f.done();
		} finally { process.env.PI_CODING_AGENT_DIR = previous; if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; rmSync(dir, { recursive: true, force: true }); }
	}
});

test("discard and cancelled prompt editors do not write Markdown files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompt-discard-"));
	try {
		const library = new SavedPromptLibrary(() => ({ global: join(dir, "prompts") }), "global");
		const f = ui(["Saved prompts", "Create a prompt", "Back", "Discard changes"], ["Draft", "", "Draft body"]);
		assert.equal(await editConfig(f.ctx, {}, "Global", library), undefined);
		assert.equal(existsSync(join(dir, "prompts")), false);
		f.done();
		for (const inputs of [[undefined], ["Title", undefined], ["Title", "", undefined]]) {
			const library = new SavedPromptLibrary(() => ({ global: join(dir, "prompts") }), "global");
			const g = ui(["Saved prompts", "Create a prompt", "Back", "Save changes"], inputs);
			await editConfig(g.ctx, {}, "Global", library);
			library.commit();
			assert.equal(library.list().prompts.length, 0);
			assert.equal(existsSync(join(dir, "prompts")), false);
			g.done();
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
