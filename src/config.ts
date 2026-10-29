import { readFileSync } from "node:fs";

export const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export interface Policy {
	model?: string;
	effort?: typeof efforts[number];
	auto?: { enabled?: boolean; thresholdPercent?: number };
	instructions?: string;
	onError?: "cancel" | "default";
}
export interface Config {
	$schema?: string;
	defaults?: Policy;
	models?: Record<string, Policy>;
	override?: Policy;
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
	keys(p, ["model", "effort", "auto", "instructions", "onError"], path);
	if (p.model !== undefined) {
		if (typeof p.model !== "string") throw new Error(`${path}.model must be a string`);
		if (p.model !== "current") modelParts(p.model);
	}
	if (p.effort !== undefined && !efforts.some(level => level === p.effort)) throw new Error(`${path}.effort must be one of ${efforts.join(", ")}`);
	if (p.instructions !== undefined && typeof p.instructions !== "string") throw new Error(`${path}.instructions must be a string`);
	if (p.onError !== undefined && p.onError !== "cancel" && p.onError !== "default") throw new Error(`${path}.onError must be cancel or default`);
	if (p.auto !== undefined) {
		const auto = object(p.auto, `${path}.auto`);
		keys(auto, ["enabled", "thresholdPercent"], `${path}.auto`);
		if (auto.enabled !== undefined && typeof auto.enabled !== "boolean") throw new Error(`${path}.auto.enabled must be a boolean`);
		if (auto.thresholdPercent !== undefined && (typeof auto.thresholdPercent !== "number" || !Number.isFinite(auto.thresholdPercent) || auto.thresholdPercent <= 0 || auto.thresholdPercent >= 100)) {
			throw new Error(`${path}.auto.thresholdPercent must be greater than 0 and less than 100`);
		}
	}
	return p as Policy;
}
export function parseConfig(value: unknown): Config {
	const c = object(value, "config");
	keys(c, ["$schema", "defaults", "models", "override"], "config");
	if (c.$schema !== undefined && typeof c.$schema !== "string") throw new Error("$schema must be a string");
	for (const key of ["defaults", "override"] as const) if (c[key] !== undefined) policy(c[key], key);
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
	return policies.reduce<Policy>((result, p) => p ? {
		...result, ...p, auto: { ...result.auto, ...p.auto },
	} : result, {});
}
export function resolvePolicy(global: Config, project: Config, model: string): Policy {
	return mergePolicies(global.defaults, project.defaults, global.models?.[model], project.models?.[model], global.override, project.override);
}
export function shouldAutoCompact(p: Policy, percent: number | null | undefined): boolean {
	return p.auto?.enabled !== false && p.auto?.thresholdPercent !== undefined && percent != null && percent >= p.auto.thresholdPercent;
}
