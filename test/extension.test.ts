import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

function fixture(config: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "pi-compaction-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const project = join(dir, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(dir, "compaction.json"), JSON.stringify(config));
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const calls: any[] = [];
	const notices: string[] = [];
	const model = { provider: "test", id: "summary", api: "openai-responses", reasoning: true, contextWindow: 100000, maxTokens: 8192 };
	let stopReason = "stop";
	let enabled = true;
	let autoCalls = 0;
	let completion: any;
	const ctx = {
		cwd: project, model, hasUI: false,
		isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => ({ percent: 80 }),
		compact: (options: any) => { autoCalls++; completion = options; },
		ui: { notify: (s: string) => notices.push(s) },
		modelRegistry: {
			find: (provider: string, id: string) => provider === "test" && id === "summary" ? model : undefined,
			streamSimple: (m: any, context: any, options: any) => {
				calls.push({ model: m, context, options });
				return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Summary" }], stopReason,
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) };
			},
		},
	};
	extension({ on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: () => {},
		getThinkingLevel: () => "medium", getSettings: () => ({ compaction: { enabled }, retry: { enabled: false } }),
	} as unknown as ExtensionAPI);
	const event = {
		reason: "manual", signal: new AbortController().signal, customInstructions: "Keep test results",
		preparation: { firstKeptEntryId: "keep", tokensBefore: 50000, messagesToSummarize: [{ role: "user", content: "Fix the bug", timestamp: 0 }],
			turnPrefixMessages: [], isSplitTurn: false, previousSummary: "Prior summary", fileOps: { read: new Set(["README.md"]), written: new Set(["src/index.ts"]), edited: new Set() } },
	};
	return { ctx, event, calls, notices, handlers, project,
		setStop: (s: string) => { stopReason = s; }, disable: () => { enabled = false; },
		autoCalls: () => autoCalls, complete: () => completion.onComplete(),
		cleanup: () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); },
	};
}

test("custom compaction uses Pi's summarizer with model, effort, instructions, and file operations", async () => {
	const f = fixture({ defaults: { model: "test/summary", effort: "high", instructions: "Keep decisions" } });
	try {
		const result = await f.handlers.session_before_compact(f.event, f.ctx);
		assert.equal(result.compaction.firstKeptEntryId, "keep");
		assert.equal(result.compaction.tokensBefore, 50000);
		assert.deepEqual(result.compaction.details.modifiedFiles, ["src/index.ts"]);
		assert.equal(result.compaction.usage.totalTokens, 15);
		assert.equal(f.calls[0].model.id, "summary");
		assert.equal(f.calls[0].options.reasoning, "high");
		assert.equal(f.calls[0].options.signal, f.event.signal);
		assert.equal(f.calls[0].options.cacheRetention, "none");
		const prompt = JSON.stringify(f.calls[0].context);
		for (const text of ["Keep decisions", "Keep test results", "Prior summary"]) assert.ok(prompt.includes(text));
	} finally { f.cleanup(); }
});

test("split turns retain both summaries and combine usage", async () => {
	const f = fixture({ defaults: { effort: "off" } });
	try {
		f.event.preparation.isSplitTurn = true;
		f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Continue", timestamp: 1 }] as any;
		const result = await f.handlers.session_before_compact(f.event, f.ctx);
		assert.equal(f.calls.length, 2);
		assert.equal(result.compaction.usage.totalTokens, 30);
		assert.ok(result.compaction.summary.includes("Turn Context"));
		assert.equal(f.calls[0].options.reasoning, undefined);
	} finally { f.cleanup(); }
});

test("automatic disable keeps manual compaction and cancels overflow", async () => {
	const f = fixture({ defaults: { auto: { enabled: false } } });
	try {
		assert.equal(await f.handlers.session_before_compact(f.event, f.ctx), undefined);
		assert.deepEqual(await f.handlers.session_before_compact({ ...f.event, reason: "overflow" }, f.ctx), { cancel: true });
	} finally { f.cleanup(); }
});

test("later thresholds veto native threshold compaction but preserve overflow recovery", async () => {
	const f = fixture({ defaults: { auto: { thresholdPercent: 90 } } });
	try {
		assert.deepEqual(await f.handlers.session_before_compact({ ...f.event, reason: "threshold" }, f.ctx), { cancel: true });
		assert.equal(await f.handlers.session_before_compact({ ...f.event, reason: "overflow" }, f.ctx), undefined);
	} finally { f.cleanup(); }
});

test("early automatic compaction runs once and respects Pi's master switch and aborts", () => {
	const f = fixture({ defaults: { auto: { thresholdPercent: 70 } } });
	try {
		f.handlers.agent_settled({ aborted: true }, f.ctx);
		assert.equal(f.autoCalls(), 0);
		f.handlers.agent_settled({}, f.ctx);
		f.handlers.agent_settled({}, f.ctx);
		assert.equal(f.autoCalls(), 1);
		f.complete(); f.disable();
		f.handlers.agent_settled({}, f.ctx);
		assert.equal(f.autoCalls(), 1);
	} finally { f.cleanup(); }
});

test("partial summaries cancel and fallback requires explicit configuration", async () => {
	for (const fallback of [false, true]) {
		const f = fixture({ defaults: { effort: "low", onError: fallback ? "default" : "cancel" } });
		try {
			f.setStop("length");
			assert.deepEqual(await f.handlers.session_before_compact(f.event, f.ctx), fallback ? undefined : { cancel: true });
			assert.ok(f.notices.some(s => s.includes("incomplete")));
		} finally { f.cleanup(); }
	}
});

test("untrusted project configuration cannot change the compaction model", async () => {
	const f = fixture({});
	try {
		writeFileSync(join(f.project, ".pi", "compaction.json"), JSON.stringify({ defaults: { model: "missing/model" } }));
		f.ctx.isProjectTrusted = () => false;
		assert.equal(await f.handlers.session_before_compact(f.event, f.ctx), undefined);
		f.ctx.isProjectTrusted = () => true;
		assert.deepEqual(await f.handlers.session_before_compact(f.event, f.ctx), { cancel: true });
	} finally { f.cleanup(); }
});
