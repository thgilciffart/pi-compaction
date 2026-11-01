import { DynamicBorder, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, matchesKey, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

type View = "Added models" | "Scoped models" | "All models";
export interface ModelPickerOptions {
	added: string[];
	scoped: string[];
	all: string[];
	mode: "add" | "edit";
	names?: Record<string, string>;
	color?: (color: ThemeColor, text: string) => string;
	border?: Component;
	remove?: (models: string[]) => void;
	done: (models: string[] | undefined) => void;
	requestRender: () => void;
}

/** One persistent component keeps the cursor and selections between key presses. */
export class ConversationModelPicker implements Component {
	private views: View[];
	private view = 0;
	private cursors = new Map<View, number>();
	private selected = new Set<string>();
	private message = "";
	private models: Record<View, string[]>;
	private filtered: Record<View, string[]>;
	private searchInput = new Input();
	get focused() { return this.searchInput.focused; }
	set focused(value: boolean) { this.searchInput.focused = value; }
	constructor(private options: ModelPickerOptions) {
		this.views = options.mode === "add" ? ["Scoped models", "All models"] : ["Added models", "Scoped models", "All models"];
		const sorted = (ids: string[]) => [...new Set(ids)].sort();
		this.models = { "Added models": sorted(options.added), "Scoped models": sorted(options.scoped), "All models": sorted(options.all) };
		this.filtered = { ...this.models };
	}
	private get items() { return this.filtered[this.views[this.view]]; }
	private get cursor() { return this.cursors.get(this.views[this.view]) ?? 0; }
	private set cursor(index: number) { this.cursors.set(this.views[this.view], Math.max(0, Math.min(index, this.items.length - 1))); }
	invalidate() { this.searchInput.invalidate(); this.options.border?.invalidate(); }
	private color(color: ThemeColor, text: string) { return this.options.color?.(color, text) ?? text; }
	render(width: number): string[] {
		const items = this.items;
		const start = Math.max(0, Math.min(this.cursor - 6, items.length - 12));
		const scopes: View[] = this.options.mode === "add" ? ["All models", "Scoped models"] : this.views;
		const scope = scopes.map(view => {
			const label = view.replace(" models", "").toLowerCase();
			return !this.options.color && view === this.views[this.view] ? `[${label}]` : this.color(view === this.views[this.view] ? "accent" : "muted", label);
		}).join(this.color("muted", " | "));
		const rows = [
			...(this.options.border ? [...this.options.border.render(width), ""] : []),
			`${this.color("muted", "Scope: ")}${scope}`,
			this.color("dim", `tab scope (${this.views.map(view => view.replace(" models", "").toLowerCase()).join("/")})`),
			"",
			...this.searchInput.render(width),
			"",
			...items.slice(start, start + 12).map((id, offset) => {
				const focused = start + offset === this.cursor;
				const slash = id.indexOf("/");
				return this.color(focused ? "accent" : "text", `${focused ? "→" : " "} ${this.selected.has(id) ? "✓" : " "} ${id.slice(slash + 1)}`) + this.color("muted", ` [${id.slice(0, slash)}]`);
			}),
		];
		if (!items.length) rows.push(this.color("muted", this.searchInput.getValue() ? "  No matching models." : "  No models in this view. Press Tab to switch views."));
		if (items.length > 12) rows.push(this.color("dim", `  (${this.cursor + 1}/${items.length})`));
		const current = items[this.cursor];
		rows.push("", this.color("muted", `  Model Name: ${current ? this.options.names?.[current] ?? current.slice(current.indexOf("/") + 1) : "—"}`),
			this.color("dim", `  ${this.selected.size} selected · ${this.options.mode === "add" ? "Add" : "Edit"} conversation-model policies`), "");
		if (this.message) rows.push(this.color("warning", this.message), "");
		const hint = this.color("dim", `  Space to select and advance · Enter to edit${this.options.remove ? " · Delete to remove policies" : ""} · Ctrl+S to save · Escape/Ctrl+C to cancel`);
		return [...rows.map(row => truncateToWidth(row, width)), ...new Text(hint, 0, 0).render(width),
			...(this.options.border ? ["", ...this.options.border.render(width)] : [])];
	}
	handleInput(data: string) {
		this.message = "";
		if (matchesKey(data, "ctrl+s")) { this.options.done([...this.selected]); return; }
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.options.done(undefined); return; }
		if (matchesKey(data, "delete") && this.options.remove) {
			const candidates = this.selected.size ? [...this.selected] : [this.items[this.cursor]];
			const removed = candidates.filter(id => this.models["Added models"].includes(id));
			if (removed.length) {
				this.options.remove(removed);
				const removedIds = new Set(removed);
				this.models["Added models"] = this.models["Added models"].filter(id => !removedIds.has(id));
				this.filtered["Added models"] = this.filtered["Added models"].filter(id => !removedIds.has(id));
				for (const id of removed) this.selected.delete(id);
				this.cursor = Math.min(this.cursor, Math.max(0, this.items.length - 1));
				this.message = `Removed ${removed.length} ${removed.length === 1 ? "policy" : "policies"}. Save to apply.`;
			} else this.message = "No added policies selected to remove.";
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.view = (this.view + (matchesKey(data, "shift+tab") ? this.views.length - 1 : 1)) % this.views.length;
		} else if (matchesKey(data, "up")) this.cursor--;
		else if (matchesKey(data, "down")) this.cursor++;
		else if (matchesKey(data, "pageUp")) this.cursor -= 12;
		else if (matchesKey(data, "pageDown")) this.cursor += 12;
		else if (matchesKey(data, "home") && !this.searchInput.getValue()) this.cursor = 0;
		else if (matchesKey(data, "end") && !this.searchInput.getValue()) this.cursor = this.items.length - 1;
		else if (matchesKey(data, "space") || data === " ") {
			const id = this.items[this.cursor];
			if (id) {
				if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
				this.cursor++;
			}
		} else if (matchesKey(data, "enter") || data === "\n") {
			if (this.selected.size) { this.options.done([...this.selected]); return; }
			this.message = "Select at least one model with Space.";
		} else {
			const previous = this.searchInput.getValue();
			this.searchInput.handleInput(data);
			const query = this.searchInput.getValue();
			if (query !== previous) {
				for (const view of this.views) {
					this.filtered[view] = query ? fuzzyFilter(this.models[view], query, id => `${id} ${this.options.names?.[id] ?? ""}`) : this.models[view];
					this.cursors.set(view, 0);
				}
			}
		}
		this.options.requestRender();
	}
}

export function chooseConversationModels(ctx: ExtensionContext, added: string[], mode: "add" | "edit", remove?: (models: string[]) => void): Promise<string[] | undefined> {
	const id = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	const scoped = ctx.scopedModels?.length ? ctx.scopedModels.map(entry => id(entry.model)) : ctx.modelRegistry.getAvailable().map(id);
	if (!ctx.scopedModels?.length && ctx.model) scoped.push(id(ctx.model));
	const catalogue = ctx.modelRegistry.getAll();
	const all = [...catalogue.map(id), ...scoped, ...added];
	const named = [...catalogue, ...(ctx.scopedModels ?? []).map(entry => entry.model), ...(ctx.model ? [ctx.model] : [])];
	const names = Object.fromEntries(named.map(model => [id(model), model.name]));
	return ctx.ui.custom((tui, theme, _keybindings, done) => new ConversationModelPicker({
		added, scoped, all, names, mode, done, remove: mode === "edit" ? remove : undefined, color: theme?.fg.bind(theme), border: theme ? new DynamicBorder() : undefined,
		requestRender: () => tui.requestRender(),
	}));
}
