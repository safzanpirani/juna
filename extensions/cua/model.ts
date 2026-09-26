/**
 * Pure pieces of computer use: which window a name means, what a window's
 * controls are called, and what changed between two reads. No I/O here, so
 * every rule is testable without a desktop.
 */

export interface Win {
	window_id: number;
	pid: number;
	app: string;
	title: string;
	x: number; y: number; width: number; height: number;
	onScreen: boolean;
	z: number;
}

export interface El {
	index: number;
	token?: string;
	role: string;
	label: string;
	value?: string;
	enabled?: boolean;
	selected?: boolean;
	actions: string[];
	/** element_index of the parent row, when the driver reports it. */
	parent?: number;
	/** Desktop-space bounds, when the driver reports them. */
	frame?: { x: number; y: number; w: number; h: number };
	/** Stable across reads while the control keeps its role, label and rank. */
	key: string;
}

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** `list_windows` structured output → windows. Tolerates both shapes the driver ships. */
export function parseWindows(data: any): Win[] {
	const rows: any[] = Array.isArray(data) ? data : data?.windows ?? data?._legacy_windows ?? [];
	return rows.flatMap((row): Win[] => {
		const id = Number(row?.window_id), pid = Number(row?.pid);
		if (!Number.isFinite(id) || !Number.isFinite(pid) || pid <= 0) return [];
		const b = row.bounds && typeof row.bounds === "object" ? row.bounds : row;
		return [{
			window_id: id, pid,
			app: String(row.app_name ?? row.owner_name ?? ""),
			title: String(row.title ?? ""),
			x: num(b.x), y: num(b.y), width: num(b.width), height: num(b.height),
			onScreen: row.is_on_screen !== false && row.minimized !== true,
			z: num(row.z_index),
		}];
	});
}

const bare = (name: string) => name.toLowerCase().replace(/\.(exe|app)$/, "").trim();

/** The driver's own helper windows are never a target. */
const isOwn = (w: Win) => /^cua-driver/i.test(w.app) || /AgentCursorOverlay/i.test(w.title);

/**
 * Resolve a caller's name for a window: a pid, a process name, or a window
 * title; exact beats prefix beats substring. Within the matched process the
 * target is the LARGEST visible window, never the frontmost: a modal is
 * frontmost and small, and anchoring to it is the classic wrong-window bug.
 * A title match selects that window itself, so a dialog can be addressed by
 * its title.
 */
export function resolveWindow(windows: Win[], query: string): { window: Win; others: Win[] } {
	const q = query.trim();
	const pool = windows.filter((w) => !isOwn(w) && w.width > 1 && w.height > 1);
	if (!q) throw new Error("name an app, process, pid, or window title");
	const needle = q.toLowerCase(), name = bare(q);
	const tiers: ((w: Win) => boolean)[] = /^\d+$/.test(q)
		? [(w) => w.pid === Number(q) || w.window_id === Number(q)]
		: [
			(w) => w.title.toLowerCase() === needle,
			(w) => bare(w.app) === name,
			(w) => bare(w.app).startsWith(name),
			(w) => bare(w.app).includes(name),
			(w) => w.title.toLowerCase().includes(needle),
		];
	for (const [tier, matches] of tiers.entries()) {
		const hits = pool.filter(matches);
		if (!hits.length) continue;
		const titleTier = tier === 0 || tier === 4;
		const visible = hits.filter((w) => w.onScreen);
		const candidates = visible.length ? visible : hits;
		const window = titleTier
			? candidates.sort((a, b) => b.z - a.z)[0]!
			: candidates.sort((a, b) => b.width * b.height - a.width * a.height || b.z - a.z)[0]!;
		const others = pool.filter((w) => w.pid === window.pid && w.window_id !== window.window_id && w.onScreen);
		return { window, others };
	}
	const names = [...new Set(pool.filter((w) => w.onScreen).map((w) => bare(w.app) || w.title))].slice(0, 15);
	throw new Error(`no window matches "${q}". On screen: ${names.join(", ") || "nothing"}`);
}

export const shortRole = (role: string) => role.replace(/^AX/, "");

/** `get_window_state` structured output → elements with identity keys. */
export function parseElements(data: any): { elements: El[]; snapshotId?: string; total: number } {
	const rows: any[] = Array.isArray(data?.elements) ? data.elements : [];
	const seen = new Map<string, number>();
	const elements = rows.flatMap((row): El[] => {
		const index = Number(row?.element_index);
		if (!Number.isInteger(index)) return [];
		const role = shortRole(String(row.role ?? ""));
		const label = String(row.label ?? row.title ?? "").replace(/\s+/g, " ").trim();
		const base = `${role}|${label}`;
		const rank = seen.get(base) ?? 0;
		seen.set(base, rank + 1);
		return [{
			index,
			token: typeof row.element_token === "string" ? row.element_token : undefined,
			role, label,
			value: row.value === undefined || row.value === null ? undefined : String(row.value).replace(/\r/g, ""),
			enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
			selected: typeof row.selected === "boolean" ? row.selected : undefined,
			actions: Array.isArray(row.actions) ? row.actions.map(String) : [],
			parent: Number.isInteger(row.parent_index) ? row.parent_index : undefined,
			frame: row.frame && ["x", "y", "w", "h"].every((k) => Number.isFinite(Number(row.frame[k])))
				? { x: Number(row.frame.x), y: Number(row.frame.y), w: Number(row.frame.w), h: Number(row.frame.h) } : undefined,
			key: `${base}|${rank}`,
		}];
	});
	return {
		elements,
		snapshotId: typeof data?.snapshot_id === "string" ? data.snapshot_id : undefined,
		total: Number(data?.total_element_count ?? elements.length) || 0,
	};
}

/** Roles that only group other controls. Unlabelled, they carry nothing. */
const STRUCTURAL = /^(Group|Pane|Custom|Unknown|Layout|Filler|Panel|ScrollArea|SplitGroup|Section|Generic|Separator|Image)$/i;

/** Rows worth a line: anything labelled, valued or actionable, minus empty containers. */
export function visibleRows(elements: El[]): El[] {
	return elements.filter((e) => e.label || (e.value && e.value.trim()) || (e.actions.length && !STRUCTURAL.test(e.role)));
}

/**
 * Session-stable element refs. The same control keeps its ref across reads,
 * so a ref the model saw three turns ago still means that control, and a diff
 * can name what changed. A ref is resolved against a FRESH read at action
 * time, never against a remembered token.
 */
export class Refs {
	private byKey = new Map<string, string>();
	private byRef = new Map<string, { window: number; key: string }>();
	private next = 1;

	ref(window: number, el: El): string {
		const key = `${window}|${el.key}`;
		let ref = this.byKey.get(key);
		if (!ref) {
			ref = `e${this.next++}`;
			this.byKey.set(key, ref);
			this.byRef.set(ref, { window, key: el.key });
		}
		return ref;
	}

	lookup(ref: string): { window: number; key: string } | undefined {
		return this.byRef.get(ref.trim().toLowerCase());
	}
}

const TOGGLE = /CheckBox|RadioButton|Switch|ToggleButton/i;

const quote = (s: string, max = 80) => JSON.stringify(s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function renderRow(ref: string, e: El): string {
	const parts = [ref, e.role];
	if (e.label) parts.push(quote(e.label));
	if (e.value !== undefined && e.value !== "" && e.value !== e.label) parts.push(`= ${quote(e.value, 60)}`);
	if (e.enabled === false) parts.push("(disabled)");
	// A toggle's state must always be stated: "unchecked" rendered as nothing
	// reads as "unknown", and a goal loop will toggle it straight back.
	if (TOGGLE.test(e.role) && e.selected !== undefined) parts.push(e.selected ? "(checked)" : "(unchecked)");
	else if (e.selected) parts.push("(selected)");
	return parts.join(" ");
}

export interface TreeDiff { added: El[]; removed: El[]; changed: { before: El; after: El }[] }

export function diffTrees(before: El[], after: El[]): TreeDiff {
	const old = new Map(before.map((e) => [e.key, e]));
	const now = new Map(after.map((e) => [e.key, e]));
	return {
		added: after.filter((e) => !old.has(e.key)),
		removed: before.filter((e) => !now.has(e.key)),
		changed: after.flatMap((e) => {
			const was = old.get(e.key);
			return was && (was.value !== e.value || was.enabled !== e.enabled || was.selected !== e.selected)
				? [{ before: was, after: e }] : [];
		}),
	};
}

/** Actions that only expose content to read; a row with nothing else is not something to click. */
const READ_ONLY = /^(text|value|scroll|AXValue)$/i;

/** True when a row offers an interaction, not just text to read. */
export const interactive = (e: El) => e.actions.some((a) => !READ_ONLY.test(a));

/** Controls a verb can act on. Keeps a Jev choice to plausible candidates. */
export function actionable(elements: El[], verb: string): El[] {
	const rows = visibleRows(elements).filter((e) => e.enabled !== false);
	const settable = (e: El) => e.actions.some((a) => /set_?value|text|AXValue/i.test(a)) || /Edit|TextField|TextArea|ComboBox|SearchField|Document/i.test(e.role);
	if (verb === "set" || verb === "type") return rows.filter(settable);
	return rows.filter((e) => interactive(e) || /Button|MenuItem|CheckBox|RadioButton|Tab|Link|ListItem|TreeItem|Hyperlink/i.test(e.role));
}

/** Every case-insensitive exact label match, ignoring a trailing colon. */
export function exactLabels(elements: El[], description: string): El[] {
	const want = description.trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/\s*:$/, "");
	return elements.filter((e) => e.label.toLowerCase().replace(/\s*:$/, "") === want);
}

/** An exact, unique, case-insensitive label match: the no-model path. */
export function exactLabel(elements: El[], description: string): El | undefined {
	const hits = exactLabels(elements, description);
	return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The title bar's own "System" menu exists in nearly every window and shares
 * its label with real controls ("System" in Settings). It is never what a
 * label means unless the caller asks for the menu itself.
 */
export function withoutChrome(elements: El[], description: string): El[] {
	if (/menu|title ?bar/i.test(description)) return elements;
	const titleBars = new Set(elements.filter((e) => /^TitleBar$/i.test(e.role)).map((e) => e.index));
	// Windows hangs the system menu off the title bar in classic apps and off
	// the frame window in UWP ones; either way it is a MenuItem named "System".
	return elements.filter((e) => !(e.parent !== undefined && titleBars.has(e.parent))
		&& !(/^MenuItem$/i.test(e.role) && e.label.trim().toLowerCase() === "system"));
}

/** Words that mark an action as hard to undo. Matched on the RAW label. */
export const SENSITIVE = /\b(delete|remove|erase|discard|send|submit|pay|purchase|buy|order|checkout|transfer|publish|post|sign out|log ?out|uninstall|format|reset|overwrite|replace all|shut ?down|restart|empty trash|confirm)\b/i;
