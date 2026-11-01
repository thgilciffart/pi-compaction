import { readFileSync } from "node:fs";

export const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const styles = ["native", "claude-code", "codex", "custom"] as const;
export interface Prompt { system: string; summary: string }
export const savedPromptPattern = /^(global|project)\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export interface Policy {
	style?: typeof styles[number];
	prompt?: Prompt | string;
	model?: string;
	effort?: typeof efforts[number];
	auto?: { enabled?: boolean; thresholdPercent?: number; thresholdTokens?: number };
	instructions?: string;
	onError?: "cancel" | "default";
}
export interface Config {
	$schema?: string;
	defaults?: Policy;
	models?: Record<string, Policy>;
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown setting: ${path}.${key}`);
}
export function modelParts(value: string): [string, string] {
	const slash = value.indexOf("/");
	if (slash < 1 || slash === value.length - 1 || value.trim() !== value || /\s/.test(value)) {
		throw new Error(`Expected provider/model, received ${JSON.stringify(value)}`);
	}
	return [value.slice(0, slash), value.slice(slash + 1)];
}
function policy(value: unknown, path: string): Policy {
	const p = object(value, path);
	keys(p, ["model", "effort", "auto", "instructions", "onError", "style", "prompt"], path);
	if (p.style !== undefined && !styles.some(style => style === p.style)) throw new Error(`${path}.style must be one of ${styles.join(", ")}`);
	if (p.prompt !== undefined) {
		if (typeof p.prompt === "string") {
			if (!savedPromptPattern.test(p.prompt)) throw new Error(`${path}.prompt must be global/name or project/name`);
		} else {
			const prompt = object(p.prompt, `${path}.prompt`);
			keys(prompt, ["system", "summary"], `${path}.prompt`);
			for (const field of ["system", "summary"]) {
				if (typeof prompt[field] !== "string" || !(prompt[field] as string).trim()) throw new Error(`${path}.prompt.${field} must be a non-empty string`);
			}
		}
	}
	if (p.model !== undefined) {
		if (typeof p.model !== "string") throw new Error(`${path}.model must be a string`);
		if (p.model !== "current") modelParts(p.model);
	}
	if (p.effort !== undefined && !efforts.some(level => level === p.effort)) throw new Error(`${path}.effort must be one of ${efforts.join(", ")}`);
	if (p.instructions !== undefined && typeof p.instructions !== "string") throw new Error(`${path}.instructions must be a string`);
	if (p.onError !== undefined && p.onError !== "cancel" && p.onError !== "default") throw new Error(`${path}.onError must be cancel or default`);
	if (p.auto !== undefined) {
		const auto = object(p.auto, `${path}.auto`);
		keys(auto, ["enabled", "thresholdPercent", "thresholdTokens"], `${path}.auto`);
		if (auto.enabled !== undefined && typeof auto.enabled !== "boolean") throw new Error(`${path}.auto.enabled must be a boolean`);
		if (auto.thresholdPercent !== undefined && (typeof auto.thresholdPercent !== "number" || !Number.isFinite(auto.thresholdPercent) || auto.thresholdPercent <= 0 || auto.thresholdPercent >= 100)) {
			throw new Error(`${path}.auto.thresholdPercent must be greater than 0 and less than 100`);
		}
		if (auto.thresholdTokens !== undefined && (typeof auto.thresholdTokens !== "number" || !Number.isSafeInteger(auto.thresholdTokens) || auto.thresholdTokens <= 0)) {
			throw new Error(`${path}.auto.thresholdTokens must be a positive safe integer`);
		}
		if (auto.thresholdPercent !== undefined && auto.thresholdTokens !== undefined) throw new Error(`${path}.auto must specify only one threshold`);
	}
	return p as Policy;
}
export function parseConfig(value: unknown): Config {
	const c = object(value, "config");
	keys(c, ["$schema", "defaults", "models"], "config");
	if (c.$schema !== undefined && typeof c.$schema !== "string") throw new Error("$schema must be a string");
	if (c.defaults !== undefined) policy(c.defaults, "defaults");
	if (c.models !== undefined) {
		for (const [key, value] of Object.entries(object(c.models, "models"))) {
			modelParts(key);
			policy(value, `models.${key}`);
		}
	}
	return c as Config;
}
export function readConfig(path: string): Config {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
export function mergePolicies(...policies: (Policy | undefined)[]): Policy {
	return policies.reduce<Policy>((result, p) => {
		if (!p) return result;
		const auto = { ...result.auto, ...p.auto };
		if (p.auto?.thresholdPercent !== undefined) delete auto.thresholdTokens;
		if (p.auto?.thresholdTokens !== undefined) delete auto.thresholdPercent;
		return { ...result, ...p, auto };
	}, {});
}
export function resolvePolicy(global: Config, project: Config, model: string): Policy {
	const p = mergePolicies(global.defaults, project.defaults, global.models?.[model], project.models?.[model]);
	if (p.style === "custom" && !p.prompt) throw new Error("Custom compaction style requires a saved prompt or prompt.system and prompt.summary");
	return p;
}
export function shouldAutoCompact(p: Policy, percent: number | null | undefined, tokens?: number | null): boolean {
	if (p.auto?.enabled === false) return false;
	if (p.auto?.thresholdTokens !== undefined) return tokens != null && tokens >= p.auto.thresholdTokens;
	return p.auto?.thresholdPercent !== undefined && percent != null && percent >= p.auto.thresholdPercent;
}

export function parseThresholdInput(input: string): { thresholdPercent?: number; thresholdTokens?: number } {
	const text = input.trim().toLowerCase();
	if (!text) return {};
	const percent = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
	if (percent && Number(percent[1]) > 0 && Number(percent[1]) < 100) return { thresholdPercent: Number(percent[1]) };
	const absolute = text.match(/^(\d+(?:\.\d+)?)\s*([km])?(?:\s*tokens?)?$/);
	if (absolute) {
		const tokens = Number(absolute[1]) * (absolute[2] === "k" ? 1000 : absolute[2] === "m" ? 1000000 : 1);
		if (Number.isSafeInteger(tokens) && tokens > 0) return { thresholdTokens: tokens };
	}
	throw new Error("Enter a percentage greater than 0 and less than 100 (e.g. 80%), or a positive whole token count (e.g. 100000 or 100k). Leave blank to use the default threshold.");
}
