import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi loads the packaged TypeScript entry and registers its hooks and command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compaction-loader-"));
	try {
		const result = await discoverAndLoadExtensions([resolve("src/index.ts")], dir, dir);
		assert.deepEqual(result.errors, []);
		const loaded = result.extensions.find(e => e.resolvedPath === resolve("src/index.ts"));
		assert.ok(loaded);
		assert.ok(loaded.handlers.has("session_before_compact"));
		assert.ok(loaded.handlers.has("agent_settled"));
		assert.ok(loaded.commands.has("compaction-settings"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
