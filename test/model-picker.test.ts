import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseConversationModels, ConversationModelPicker, type ModelPickerOptions } from "../src/model-picker.ts";

function picker(options: Partial<ModelPickerOptions> = {}) {
	let result: string[] | undefined;
	let completed = false;
	const component = new ConversationModelPicker({
		added: ["test/old"], scoped: ["test/a", "test/b"], all: ["test/a", "test/b", "test/c", "test/old"], mode: "add",
		done: value => { result = value; completed = true; }, requestRender() {}, ...options,
	});
	return { component, rows: () => component.render(200).join("\n"), result: () => result, completed: () => completed };
}

test("Space selects and advances without reopening the picker, and Tab retains selections", () => {
	const f = picker();
	assert.ok(f.rows().includes("[scoped]"));
	assert.ok(!f.rows().includes("c [test]"));
	f.component.handleInput(" ");
	assert.ok(f.rows().includes("  ✓ a [test]\n→   b [test]"));
	assert.equal(f.completed(), false);
	f.component.handleInput("\t");
	assert.ok(f.rows().includes("[all]"));
	assert.ok(f.rows().includes("→ ✓ a [test]"));
	f.component.handleInput("\x1b[B");
	f.component.handleInput("\x1b[B");
	f.component.handleInput(" ");
	assert.ok(f.rows().includes("→   old [test]"));
	f.component.handleInput("\t");
	assert.ok(f.rows().includes("→   b [test]"));
	f.component.handleInput("\r");
	assert.deepEqual(f.result(), ["test/a", "test/c"]);
});

test("editing starts with added models and cycles through scoped and all models", () => {
	const f = picker({ mode: "edit" });
	assert.ok(f.rows().includes("[added]"));
	assert.ok(f.rows().includes("old [test]") && !f.rows().includes("a [test]"));
	f.component.handleInput(" ");
	f.component.handleInput("\t");
	assert.ok(f.rows().includes("[scoped]"));
	f.component.handleInput("\t");
	assert.ok(f.rows().includes("[all]"));
	f.component.handleInput("\t");
	assert.ok(f.rows().includes("[added]") && f.rows().includes("✓ old [test]"));
	f.component.handleInput(" ");
	f.component.handleInput("\r");
	assert.equal(f.completed(), false);
	assert.ok(f.rows().includes("Select at least one model"));
	f.component.handleInput("\x1b");
	assert.equal(f.completed(), true);
	assert.equal(f.result(), undefined);
});

test("cursor advances through a scrolling list and supports reverse view cycling", () => {
	const ids = Array.from({ length: 40 }, (_, i) => `test/model-${String(i).padStart(2, "0")}`);
	const f = picker({ scoped: ids, all: ids });
	for (let i = 0; i < 15; i++) f.component.handleInput("\x1b[B");
	assert.ok(f.rows().includes("→   model-15 [test]"));
	f.component.handleInput(" ");
	assert.ok(f.rows().includes("→   model-16 [test]"));
	assert.ok(f.rows().includes("✓ model-15 [test]"));
	f.component.handleInput("\x1b[Z");
	assert.ok(f.rows().includes("[all]"));
	f.component.handleInput("\x1b[Z");
	assert.ok(f.rows().includes("→   model-16 [test]"));
});

test("Ctrl+S can finish an empty model selection without hanging", () => {
	const f = picker({ added: [], scoped: [], all: [], mode: "edit" });
	assert.ok(f.rows().includes("No models"));
	f.component.handleInput("\x13");
	assert.deepEqual(f.result(), []);
	assert.equal(f.completed(), true);
});

test("search matches model names across scopes and preserves selections when cleared", () => {
	const f = picker({ names: { "test/a": "Atlas Reasoner", "test/b": "Beta Chat", "test/c": "Gamma Reasoner" } });
	f.component.focused = true;
	assert.equal(f.component.focused, true);
	f.component.handleInput("Reasoner");
	assert.ok(f.rows().includes("a [test]"));
	assert.ok(!f.rows().includes("b [test]"));
	assert.ok(f.rows().includes("Model Name: Atlas Reasoner"));
	f.component.handleInput(" ");
	f.component.handleInput("\t");
	assert.ok(f.rows().includes("c [test]") && !f.rows().includes("b [test]"));
	f.component.handleInput("\x1b[B");
	f.component.handleInput(" ");
	f.component.handleInput("\x15");
	assert.ok(f.rows().includes("b [test]"));
	assert.ok(f.rows().includes("✓ a [test]") && f.rows().includes("✓ c [test]"));
	f.component.handleInput("\r");
	assert.deepEqual(f.result(), ["test/a", "test/c"]);
});

test("an empty search result cannot select a stale highlighted model", () => {
	const f = picker();
	f.component.handleInput("nonexistent-model-xyz");
	assert.ok(f.rows().includes("No matching models"));
	f.component.handleInput(" ");
	f.component.handleInput("\r");
	assert.equal(f.completed(), false);
	f.component.handleInput("\x03");
	assert.equal(f.completed(), true);
	assert.equal(f.result(), undefined);
});

test("Delete removes the highlighted policy when nothing is checked", () => {
	const removed: string[][] = [];
	const f = picker({ mode: "edit", remove: models => removed.push(models) });
	f.component.handleInput("\x1b[3~");
	assert.deepEqual(removed, [["test/old"]]);
	assert.ok(!f.rows().includes("old [test]"));
	assert.ok(f.rows().includes("Save to apply"));
	f.component.handleInput("\x13");
	assert.deepEqual(f.result(), []);
});

test("Delete removes checked existing policies across views and clears their selection", () => {
	const removed: string[][] = [];
	const f = picker({ mode: "edit", added: ["test/a", "test/old"], remove: models => removed.push(models) });
	f.component.handleInput(" ");
	f.component.handleInput(" ");
	f.component.handleInput("\t");
	f.component.handleInput("\x1b[3~");
	assert.deepEqual(removed, [["test/a", "test/old"]]);
	f.component.handleInput("\x13");
	assert.deepEqual(f.result(), []);
});

test("Delete cannot remove an unadded model from the catalogue", () => {
	const removed: string[][] = [];
	const f = picker({ mode: "edit", remove: models => removed.push(models) });
	f.component.handleInput("\t");
	f.component.handleInput("\x1b[3~");
	assert.deepEqual(removed, []);
	assert.ok(f.rows().includes("a [test]"));
	assert.ok(f.rows().includes("No added policies selected"));
});

test("the picker uses session scoping and falls back to available models when unscoped", async () => {
	for (const scoped of [true, false]) {
		const ctx = {
			model: { provider: "test", id: "current" },
			scopedModels: scoped ? [{ model: { provider: "test", id: "scoped" } }] : [],
			modelRegistry: { getAvailable: () => [{ provider: "test", id: "available" }], getAll: () => [{ provider: "test", id: "all" }] },
			ui: { custom: async (factory: any) => new Promise(resolve => {
				const component = factory({ requestRender() {} }, undefined, undefined, resolve);
				const rows = component.render(200).join("\n");
				assert.ok(rows.includes(scoped ? "scoped [test]" : "available [test]"));
				assert.ok(!rows.includes("all [test]"));
				if (scoped) assert.ok(!rows.includes("available [test]") && !rows.includes("current [test]"));
				component.handleInput("\x1b");
			}) },
		} as unknown as ExtensionContext;
		assert.equal(await chooseConversationModels(ctx, [], "add"), undefined);
	}
});
