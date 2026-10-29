import { strict as assert } from "node:assert";
import { test } from "node:test";
import { modelParts, parseConfig, resolvePolicy, shouldAutoCompact } from "../src/config.ts";

test("model policies inherit individual auto settings and global overrides win", () => {
	const result = resolvePolicy({
		defaults: { model: "a/default", effort: "low", auto: { enabled: true, thresholdPercent: 70 } },
		models: { "a/chat": { effort: "high", auto: { thresholdPercent: 80 } } },
		override: { auto: { enabled: false } },
	}, { defaults: { instructions: "Keep decisions" }, models: { "a/chat": { model: "b/summary" } } }, "a/chat");
	assert.deepEqual(result, { model: "b/summary", effort: "high", instructions: "Keep decisions", auto: { enabled: false, thresholdPercent: 80 } });
	assert.equal(resolvePolicy({ defaults: { effort: "low" } }, {}, "unknown/model").effort, "low");
});

test("configuration rejects typos, invalid levels, and unsafe thresholds", () => {
	for (const config of [null, [], { default: {} }, { defaults: { effort: "max" } }, { defaults: { auto: { enabled: "false" } } },
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
