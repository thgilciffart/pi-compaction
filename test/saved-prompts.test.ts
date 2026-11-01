import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSavedPrompts, readSavedPrompt, resolveSavedPrompt, SavedPromptLibrary } from "../src/saved-prompts.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-saved-prompts-"));
	const directories = { global: join(dir, "global"), project: join(dir, "project") };
	for (const path of Object.values(directories)) mkdirSync(path);
	return { directories, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Markdown prompts require a title and body, with optional YAML descriptions", () => {
	const f = fixture();
	try {
		const path = join(f.directories.global, "review.md");
		writeFileSync(path, '---\ntitle: "Code review"\ndescription: |\n  Preserve findings\n  and unresolved risks.\n---\n\nSummarize review findings.\n');
		const prompt = readSavedPrompt("global/review", f.directories);
		assert.equal(prompt.title, "Code review");
		assert.equal(prompt.description, "Preserve findings\nand unresolved risks.");
		assert.equal(prompt.system, "Summarize review findings.");
		writeFileSync(path, "---\ntitle: Review\n---\nBody");
		assert.equal(readSavedPrompt("global/review", f.directories).description, undefined);
		writeFileSync(path, "---\ntitle: Review\ndescription:\n---\nBody");
		assert.equal(readSavedPrompt("global/review", f.directories).description, undefined);
		for (const text of ["No frontmatter", "---\ntitle: 42\n---\nBody", "---\ntitle: X\ndescription: false\n---\nBody", "---\ntitle: X\n---\n ", "---\ntitle: [broken\n---\nBody"]) {
			writeFileSync(path, text);
			assert.throws(() => readSavedPrompt("global/review", f.directories), /review\.md/);
		}
	} finally { f.cleanup(); }
});

test("discovery distinguishes scopes and reports invalid files without hiding valid ones", () => {
	const f = fixture();
	try {
		for (const directory of Object.values(f.directories)) writeFileSync(join(directory, "same.md"), "---\ntitle: Same\n---\nPrompt");
		writeFileSync(join(f.directories.global, "bad.md"), "No title");
		writeFileSync(join(f.directories.global, "ignore.txt"), "ignored");
		const result = listSavedPrompts(f.directories);
		assert.deepEqual(result.prompts.map(p => p.id), ["global/same", "project/same"]);
		assert.equal(result.errors.length, 1);
		assert.equal(listSavedPrompts({ global: f.directories.global }).prompts.length, 1);
		assert.throws(() => readSavedPrompt("project/same", { global: f.directories.global }), /trust/);
		for (const id of ["global/../secret", "project/../../secret", "/absolute", "global/name.md"]) {
			assert.throws(() => readSavedPrompt(id, f.directories), /Invalid saved prompt/);
		}
	} finally { f.cleanup(); }
});

test("staged prompts commit Markdown, preserve IDs on rename, and avoid duplicate filenames", () => {
	const f = fixture();
	try {
		const library = new SavedPromptLibrary(() => f.directories, "global");
		const prompt = library.stage('Review: "carefully"', "", "Prompt body");
		assert.equal(listSavedPrompts(f.directories).prompts.length, 0);
		assert.equal(library.list().prompts.length, 1);
		library.commit();
		assert.equal(readSavedPrompt(prompt.id, f.directories).title, 'Review: "carefully"');
		assert.ok(!readFileSync(join(f.directories.global, "review-carefully.md"), "utf8").includes("description:"));
		assert.equal(library.stage('Review: "carefully"', "", "Other").id, "global/review-carefully-2");
		library.stage("New title", "A description", "Updated body", prompt.id);
		library.commit();
		assert.equal(readSavedPrompt(prompt.id, f.directories).system, "Updated body");
		writeFileSync(join(f.directories.global, "broken.md"), "Invalid prompt");
		assert.equal(library.stage("Broken", "", "New").id, "global/broken-2");
		assert.throws(() => library.stage(" ", "", "text"), /Title/);
		assert.throws(() => library.stage("Name", "", "text", "project/name"), /scope/);
	} finally { f.cleanup(); }
});

test("saved prompts reload on resolution and apply only to custom compaction", () => {
	const f = fixture();
	try {
		const path = join(f.directories.global, "current.md");
		const p = { style: "custom" as const, prompt: "global/current" };
		writeFileSync(path, "---\ntitle: Current\n---\nFirst system");
		assert.equal(resolveSavedPrompt(p, f.directories).prompt?.system, "First system");
		writeFileSync(path, "---\ntitle: Current\n---\nUpdated system");
		assert.equal(resolveSavedPrompt(p, f.directories).prompt?.system, "Updated system");
		assert.doesNotThrow(() => resolveSavedPrompt({ style: "native", prompt: "global/missing" }, f.directories));
		assert.throws(() => resolveSavedPrompt({ ...p, prompt: "global/missing" }, f.directories), /missing\.md/);
		let trusted = true;
		const library = new SavedPromptLibrary(() => ({ global: f.directories.global, project: trusted ? f.directories.project : undefined }), "project");
		library.stage("Project", "", "Body");
		trusted = false;
		assert.throws(() => library.commit(), /trust/);
	} finally { f.cleanup(); }
});
