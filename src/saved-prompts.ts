import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { savedPromptPattern, type Policy, type Prompt } from "./config.ts";

export interface PromptDirectories { global: string; project?: string }
export interface SavedPrompt { id: string; title: string; description?: string; system: string }
export type ResolvedPolicy = Omit<Policy, "prompt"> & { prompt?: Prompt };

/** Stage Markdown edits alongside the settings editor's unsaved config. */
export class SavedPromptLibrary {
	private changes = new Map<string, SavedPrompt>();
	constructor(private directories: () => PromptDirectories, readonly scope: "global" | "project") {}
	list() {
		const { prompts, errors } = listSavedPrompts(this.directories());
		const all = new Map(prompts.map(prompt => [prompt.id, prompt]));
		for (const [id, prompt] of this.changes) all.set(id, prompt);
		return { prompts: [...all.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)), errors };
	}
	stage(title: string, description: string, system: string, id?: string): SavedPrompt {
		if (!title.trim() || !system.trim()) throw new Error("Title and system prompt must contain text");
		if (!id) {
			const stem = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "prompt";
			const ids = new Set(this.list().prompts.map(prompt => prompt.id));
			// Include malformed existing files so creation never overwrites them.
			const directory = this.directories()[this.scope];
			if (!directory) throw new Error("Project trust is required to save prompts");
			try { for (const name of readdirSync(directory)) ids.add(`${this.scope}/${name.replace(/\.md$/, "")}`); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			id = `${this.scope}/${stem}`;
			for (let suffix = 2; ids.has(id); suffix++) id = `${this.scope}/${stem}-${suffix}`;
		}
		if (!savedPromptPattern.test(id) || !id.startsWith(`${this.scope}/`)) throw new Error("Edit prompts in their own settings scope");
		const prompt = { id, title: title.trim(), description: description.trim() || undefined, system: system.trim() };
		this.changes.set(id, prompt);
		return prompt;
	}
	commit() {
		for (const prompt of this.changes.values()) {
			const directory = this.directories()[this.scope];
			if (!directory) throw new Error("Project trust is required to save prompts");
			mkdirSync(directory, { recursive: true });
			const path = join(directory, `${prompt.id.split("/")[1]}.md`);
			const text = `---\ntitle: ${JSON.stringify(prompt.title)}\n${prompt.description ? `description: ${JSON.stringify(prompt.description)}\n` : ""}---\n\n${prompt.system}\n`;
			const temp = `${path}.${randomUUID()}.tmp`;
			writeFileSync(temp, text, { mode: 0o600 });
			renameSync(temp, path);
		}
		this.changes.clear();
	}
}

export function readSavedPrompt(id: string, directories: PromptDirectories): SavedPrompt {
	if (!savedPromptPattern.test(id)) throw new Error(`Invalid saved prompt: ${id}`);
	const [scope, name] = id.split("/");
	const directory = directories[scope as keyof PromptDirectories];
	if (!directory) throw new Error(`Project trust is required to load saved prompt ${id}`);
	const path = join(directory, `${name}.md`);
	try {
		const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error("Frontmatter must be an object");
		if (typeof frontmatter.title !== "string" || !frontmatter.title.trim()) throw new Error("title must be a non-empty string");
		if (frontmatter.description != null && typeof frontmatter.description !== "string") throw new Error("description must be a string");
		if (!body.trim()) throw new Error("System prompt body must contain text");
		return { id, title: frontmatter.title.trim(), description: typeof frontmatter.description === "string" ? frontmatter.description.trim() || undefined : undefined, system: body.trim() };
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function listSavedPrompts(directories: PromptDirectories): { prompts: SavedPrompt[]; errors: string[] } {
	const prompts: SavedPrompt[] = [];
	const errors: string[] = [];
	for (const scope of ["global", "project"] as const) {
		const directory = directories[scope];
		if (!directory) continue;
		let names: string[];
		try { names = readdirSync(directory); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".md")) continue;
			try { prompts.push(readSavedPrompt(`${scope}/${name.slice(0, -3)}`, directories)); }
			catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
		}
	}
	return { prompts, errors };
}

export function resolveSavedPrompt(p: Policy, directories: PromptDirectories): ResolvedPolicy {
	const { prompt, ...rest } = p;
	if (typeof prompt !== "string") return { ...rest, ...(prompt === undefined ? {} : { prompt }) };
	if (p.style !== "custom") return rest;
	const saved = readSavedPrompt(prompt, directories);
	return { ...rest, prompt: { system: saved.system,
		summary: "Summarize the supplied context using the format and priorities in the system prompt. Output only the summary." } };
}
