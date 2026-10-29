import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editConfig } from "../src/editor.ts";
import extension from "../src/index.ts";

function ui(choices: (string | undefined)[], inputs: (string | undefined)[] = []) {
	const notices: string[] = [];
	const ctx = {
		hasUI: true, isProjectTrusted: () => false,
		model: { provider: "test", id: "chat" },
		modelRegistry: {
			getAvailable: () => [{ provider: "test", id: "summary" }],
			getAll: () => [{ provider: "test", id: "chat" }],
		},
		ui: {
			select: async (_title: string, options: string[]) => {
				assert.ok(choices.length, `Unexpected menu: ${_title}`);
				const choice = choices.shift();
				if (choice === undefined) return;
				const match = options.find(o => o === choice) ?? options.find(o => o.startsWith(`${choice}:`));
				assert.ok(match, `Missing option ${choice} in ${options.join(", ")}`);
				return match;
			},
			input: async () => inputs.shift(),
			editor: async () => inputs.shift(),
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, done: () => { assert.equal(choices.length, 0); assert.equal(inputs.length, 0); } };
}

test("menus edit every policy field without JSON", async () => {
	const f = ui([
		"Defaults", "Model", "Choose a model", "test", "test/summary",
		"Effort", "high", "Automatic compaction", "Off", "Context threshold", "Custom percentage",
		"Summary instructions", "Edit instructions", "On summary failure", "Use Pi defaults", "Back", "Save changes",
	], ["82.5", "Preserve test results"]);
	assert.deepEqual(await editConfig(f.ctx, {}, "Global"), {
		defaults: { model: "test/summary", effort: "high", auto: { enabled: false, thresholdPercent: 82.5 }, instructions: "Preserve test results", onError: "default" },
	});
	f.done();
});

test("inherit removes explicit values while conversation model resets an inherited model", async () => {
	const f = ui(["Defaults", "Model", "Use conversation model", "Effort", "Inherit", "Automatic compaction", "Inherit",
		"Context threshold", "Inherit", "Summary instructions", "Inherit", "On summary failure", "Inherit", "Back", "Save changes"]);
	assert.deepEqual(await editConfig(f.ctx, { defaults: { model: "test/summary", effort: "low", auto: { enabled: false, thresholdPercent: 90 }, instructions: "Keep decisions", onError: "default" } }, "Global"), {
		defaults: { model: "current", auto: {} },
	});
	f.done();
});

test("invalid percentages keep the previous threshold and cancelled input leaves values unchanged", async () => {
	const f = ui(["Defaults", "Context threshold", "Custom percentage", "Context threshold", "Custom percentage", "Effort", undefined, "Back", "Save changes"], ["100", undefined]);
	assert.deepEqual(await editConfig(f.ctx, { defaults: { auto: { thresholdPercent: 75 }, effort: "low" } }, "Global"), {
		defaults: { auto: { thresholdPercent: 75 }, effort: "low" },
	});
	assert.ok(f.notices.some(n => n.includes("greater than 0")));
	f.done();
});

test("model policies can be added, edited, and removed alongside an override", async () => {
	const f = ui(["Policies by conversation model", "Add a model", "test", "test/chat", "Effort", "off", "Back", "Back",
		"Override all models", "Automatic compaction", "On", "Back", "Policies by conversation model", "test/old", "Remove policy", "Back", "Save changes"]);
	assert.deepEqual(await editConfig(f.ctx, { models: { "test/old": { effort: "low" } } }, "Global"), {
		models: { "test/chat": { effort: "off" } }, override: { auto: { enabled: true } },
	});
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
