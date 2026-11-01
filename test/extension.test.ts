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
	let failures = 0;
	let enabled = true;
	let autoCalls = 0;
	let completion: any;
	let usage: { percent: number | null; tokens: number | null } | undefined = { percent: 80, tokens: 80000 };
	const ctx = {
		cwd: project, model, hasUI: false,
		isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
		getContextUsage: () => usage,
		compact: (options: any) => { autoCalls++; completion = options; },
		ui: { notify: (s: string) => notices.push(s) },
		modelRegistry: {
			find: (provider: string, id: string) => provider === "test" && id === "summary" ? model : undefined,
			streamSimple: (m: any, context: any, options: any) => {
				calls.push({ model: m, context, options });
				const failed = failures-- > 0;
				return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "Summary" }], stopReason: failed ? "error" : stopReason,
					errorMessage: failed ? "503 Service Unavailable" : undefined,
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
		failNext: () => { failures = 1; },
		setUsage: (value: typeof usage) => { usage = value; },
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

test("portable styles replace native prompts for initial, updated, and split summaries", async () => {
	for (const style of ["claude-code", "codex", "custom"]) {
		for (const split of [false, true]) {
			for (const prior of [false, true]) {
				const f = fixture({ defaults: { style, prompt: { system: "USER SYSTEM", summary: "USER FORMAT" }, instructions: "Keep decisions" } });
				try {
					if (!prior) delete (f.event.preparation as any).previousSummary;
					f.event.preparation.isSplitTurn = split;
					f.event.preparation.turnPrefixMessages = split ? [{ role: "user", content: "Turn prefix work", timestamp: 1 }] as any : [];
					const result = await f.handlers.session_before_compact(f.event, f.ctx);
					assert.equal(f.calls.length, split ? 2 : 1);
					assert.equal(result.compaction.usage.totalTokens, split ? 30 : 15);
					assert.equal(result.compaction.firstKeptEntryId, "keep");
					assert.deepEqual(result.compaction.details.modifiedFiles, ["src/index.ts"]);
					const history = JSON.stringify(f.calls[0].context);
					assert.ok(history.includes("Fix the bug"));
					assert.equal(history.includes("Prior summary"), prior);
					for (const call of f.calls) {
						const text = JSON.stringify(call.context);
						assert.ok(!text.includes("Use this EXACT format"));
						assert.ok(!text.includes("context summarization assistant"));
						assert.ok(text.includes("Keep decisions") && text.includes("Keep test results"));
						assert.equal(text.includes("USER FORMAT"), style === "custom");
						assert.equal(call.context.messages[0].role, "system");
						if (style === "custom") assert.equal(call.context.messages[0].content, "USER SYSTEM");
					}
					if (split) {
						const prefix = JSON.stringify(f.calls[1].context);
						assert.ok(prefix.includes("Turn prefix work") && prefix.includes("unfinished turn"));
						assert.ok(!prefix.includes("Fix the bug") && !prefix.includes("Prior summary"));
					}
				} finally { f.cleanup(); }
			}
		}
	}
});

test("split turns without new history summarize only the prefix", async () => {
	const f = fixture({ defaults: { style: "codex" } });
	try {
		f.event.preparation.isSplitTurn = true;
		f.event.preparation.messagesToSummarize = [];
		f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Prefix only", timestamp: 1 }] as any;
		const result = await f.handlers.session_before_compact(f.event, f.ctx);
		assert.equal(f.calls.length, 1);
		assert.ok(JSON.stringify(f.calls[0].context).includes("Prefix only"));
		assert.ok(result.compaction.summary.startsWith("Prior summary"));
	} finally { f.cleanup(); }
});

test("native style preserves Pi prompts and resets inherited portable styles", async () => {
	const f = fixture({ defaults: { style: "custom", prompt: { system: "CUSTOM", summary: "FORMAT" }, effort: "low" }, models: { "test/summary": { style: "native" } } });
	try {
		await f.handlers.session_before_compact(f.event, f.ctx);
		const text = JSON.stringify(f.calls[0].context);
		assert.ok(text.includes("context summarization assistant") && text.includes("Use this EXACT format"));
		assert.ok(!text.includes("CUSTOM"));
	} finally { f.cleanup(); }
});

test("retrying a history summary does not consume the split-turn prompt", async () => {
	const f = fixture({ defaults: { style: "codex" } });
	try {
		f.event.preparation.isSplitTurn = true;
		f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Prefix after retry", timestamp: 1 }] as any;
		const piSettings = () => ({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		// Re-register with retries enabled, using the same provider fixture.
		extension({ on: (name: string, fn: any) => { f.handlers[name] = fn; }, registerCommand: () => {},
			getThinkingLevel: () => "medium", getSettings: piSettings } as unknown as ExtensionAPI);
		f.failNext();
		const result = await f.handlers.session_before_compact(f.event, f.ctx);
		assert.equal(f.calls.length, 3);
		assert.equal(f.calls[0].context, f.calls[1].context);
		assert.ok(JSON.stringify(f.calls[2].context).includes("Prefix after retry"));
		assert.equal(result.compaction.usage.totalTokens, 30);
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

test("absolute thresholds trigger at the token boundary and preserve overflow recovery", async () => {
	const f = fixture({ defaults: { auto: { thresholdTokens: 90000 } } });
	try {
		f.handlers.agent_settled({}, f.ctx);
		assert.equal(f.autoCalls(), 0);
		assert.deepEqual(await f.handlers.session_before_compact({ ...f.event, reason: "threshold" }, f.ctx), { cancel: true });
		assert.equal(await f.handlers.session_before_compact({ ...f.event, reason: "overflow" }, f.ctx), undefined);
		assert.equal(await f.handlers.session_before_compact(f.event, f.ctx), undefined);
		f.setUsage({ percent: null, tokens: 90000 });
		assert.equal(await f.handlers.session_before_compact({ ...f.event, reason: "threshold" }, f.ctx), undefined);
		f.handlers.agent_settled({}, f.ctx);
		f.handlers.agent_settled({}, f.ctx);
		assert.equal(f.autoCalls(), 1);
		f.complete();
		f.setUsage({ percent: 99, tokens: null });
		f.handlers.agent_settled({}, f.ctx);
		assert.equal(f.autoCalls(), 1);
		f.setUsage(undefined);
		f.handlers.agent_settled({}, f.ctx);
		assert.equal(f.autoCalls(), 1);
		f.setUsage({ percent: 99, tokens: 100000 });
		f.disable();
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

test("saved Markdown prompts reach compaction, reload edits, and enforce project trust", async () => {
	const f = fixture({ defaults: { style: "custom", prompt: "project/review" } });
	try {
		const directory = join(f.project, ".pi", "compaction-prompts");
		mkdirSync(directory);
		const path = join(directory, "review.md");
		writeFileSync(path, "---\ntitle: Review\n---\nFIRST SYSTEM");
		await f.handlers.session_before_compact(f.event, f.ctx);
		assert.equal(f.calls[0].context.messages[0].content, "FIRST SYSTEM");
		assert.ok(!JSON.stringify(f.calls[0].context).includes("Use this EXACT format"));
		writeFileSync(path, "---\ntitle: Review\n---\nUPDATED SYSTEM");
		await f.handlers.session_before_compact(f.event, f.ctx);
		assert.equal(f.calls[1].context.messages[0].content, "UPDATED SYSTEM");
		f.ctx.isProjectTrusted = () => false;
		assert.deepEqual(await f.handlers.session_before_compact(f.event, f.ctx), { cancel: true });
		assert.equal(f.calls.length, 2);
		assert.ok(f.notices.some(s => s.includes("trust")));
		f.ctx.isProjectTrusted = () => true;
		rmSync(path);
		assert.deepEqual(await f.handlers.session_before_compact(f.event, f.ctx), { cancel: true });
		assert.equal(f.calls.length, 2);
	} finally { f.cleanup(); }
});
