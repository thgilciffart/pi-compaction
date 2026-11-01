import { strict as assert } from "node:assert";
import { test } from "node:test";
import { modelParts, parseConfig, parseThresholdInput, resolvePolicy, shouldAutoCompact } from "../src/config.ts";

test("model policies take precedence over defaults and inherit individual auto settings", () => {
	const result = resolvePolicy({
		defaults: { model: "a/default", effort: "low", auto: { enabled: true, thresholdPercent: 70 } },
		models: { "a/chat": { effort: "high", auto: { thresholdPercent: 80 } } },
	}, { defaults: { instructions: "Keep decisions", effort: "medium", auto: { enabled: false } }, models: { "a/chat": { model: "b/summary" } } }, "a/chat");
	assert.deepEqual(result, { model: "b/summary", effort: "high", instructions: "Keep decisions", auto: { enabled: false, thresholdPercent: 80 } });
	assert.equal(resolvePolicy({ defaults: { effort: "low" } }, {}, "unknown/model").effort, "low");
});

test("configuration rejects typos, invalid levels, and unsafe thresholds", () => {
	for (const config of [null, [], { default: {} }, { override: {} }, { defaults: { effort: "max" } }, { defaults: { auto: { enabled: "false" } } },
		{ defaults: { auto: { thresholdPercent: 100 } } }, { defaults: { auto: { thresholdPercent: 0 } } },
		{ defaults: { auto: { thresholdPercent: NaN } } }, { defaults: { model: "no-provider" } }, { models: { "*": {} } }]) {
		assert.throws(() => parseConfig(config));
	}
	assert.deepEqual(modelParts("openrouter/vendor/model"), ["openrouter", "vendor/model"]);
	assert.doesNotThrow(() => parseConfig({ defaults: { model: "current", effort: "off" } }));
});

test("automatic threshold includes its boundary and ignores unknown usage", () => {
	const p = { auto: { thresholdPercent: 75 } };
	assert.equal(shouldAutoCompact(p, 74.9), false);
	assert.equal(shouldAutoCompact(p, 75), true);
	assert.equal(shouldAutoCompact(p, null), false);
	assert.equal(shouldAutoCompact({ auto: { enabled: false, thresholdPercent: 75 } }, 99), false);
});

test("threshold input accepts percentages and absolute tokens with unambiguous units", () => {
	for (const [input, expected] of [
		["80%", { thresholdPercent: 80 }], [" 82.5 % ", { thresholdPercent: 82.5 }],
		["100000", { thresholdTokens: 100000 }], ["100k", { thresholdTokens: 100000 }],
		["1.5M tokens", { thresholdTokens: 1500000 }], ["80", { thresholdTokens: 80 }], [" ", {}],
	] as const) assert.deepEqual(parseThresholdInput(input), expected);
	for (const input of ["0", "0%", "100%", "101%", "-1", "1.5", "Infinity", "1e5", "NaN", "many", "9007199254740992"]) {
		assert.throws(() => parseThresholdInput(input));
	}
});

test("absolute thresholds validate and replace inherited percentage thresholds in either direction", () => {
	for (const auto of [{ thresholdTokens: 0 }, { thresholdTokens: -1 }, { thresholdTokens: 1.5 },
		{ thresholdTokens: Infinity }, { thresholdTokens: Number.MAX_SAFE_INTEGER + 1 }, { thresholdTokens: "100k" },
		{ thresholdTokens: 100000, thresholdPercent: 80 }]) {
		assert.throws(() => parseConfig({ defaults: { auto } }));
	}
	assert.doesNotThrow(() => parseConfig({ defaults: { auto: { thresholdTokens: 100000 } } }));
	const global = { defaults: { auto: { enabled: true, thresholdPercent: 75 } } };
	const project = { defaults: { auto: { thresholdTokens: 90000 } }, models: { "test/chat": { auto: { thresholdPercent: 85 } } } };
	assert.deepEqual(resolvePolicy(global, project, "test/other").auto, { enabled: true, thresholdTokens: 90000 });
	assert.deepEqual(resolvePolicy(global, project, "test/chat").auto, { enabled: true, thresholdPercent: 85 });
	const p = { auto: { thresholdTokens: 90000 } };
	assert.equal(shouldAutoCompact(p, 99, 89999), false);
	assert.equal(shouldAutoCompact(p, null, 90000), true);
	assert.equal(shouldAutoCompact(p, 99, null), false);
	assert.equal(shouldAutoCompact({ auto: { ...p.auto, enabled: false } }, 99, 100000), false);
});

test("styles validate custom prompts after policy inheritance", () => {
	for (const p of [{ style: "unknown" }, { prompt: {} }, { prompt: { system: " ", summary: "x" } },
		{ prompt: { system: "x", summary: 42 } }, { prompt: { system: "x", summary: "y", typo: true } }]) {
		assert.throws(() => parseConfig({ defaults: p }));
	}
	assert.throws(() => resolvePolicy({ defaults: { style: "custom" } }, {}, "a/chat"), /requires/);
	const prompt = { system: "Custom system", summary: "Custom format" };
	assert.equal(resolvePolicy({ defaults: { prompt } }, { defaults: { style: "custom" } }, "a/chat").prompt, prompt);
	assert.equal(resolvePolicy({ defaults: { style: "custom", prompt } }, { models: { "a/chat": { style: "native" } } }, "a/chat").style, "native");
	assert.doesNotThrow(() => parseConfig({ defaults: { style: "custom", prompt: "global/review" } }));
	for (const prompt of ["", "review", "global/../review", "project/review.md"]) {
		assert.throws(() => parseConfig({ defaults: { prompt } }));
	}
});
