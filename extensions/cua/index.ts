/**
 * Opt-in computer use for juna (`juna --cua`), on the machine juna runs on.
 *
 * Accessibility first. `ui_look` reads a window's controls as one short line
 * each, with refs that stay stable across reads. `ui_act` acts on one control
 * by ref, exact label, or description (Jev picks), and reports what changed in
 * the tree instead of returning a screenshot. `ui_do` runs a whole small UI
 * outcome in one tool call: each step is one batched Jev request, so the
 * calling model spends one turn, not one per click. Screenshots are opt-in.
 *
 * cua-driver does the observing and the input, over one persistent MCP session
 * (see driver.ts). Jev picks among controls code listed; code owns every stop
 * condition, including the gate on actions that are hard to undo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { askJev, JevError, loadConfig, type JevConfig } from "../jev.ts";
import { expectRequest, likelihood, pickRequest, shortlist, stepRequest, type Choice, type Noul } from "./decide.ts";
import { Driver, DriverError, type DriverReply } from "./driver.ts";
import { decideFocus, dropMirrors, focusRequest, foldCells, hiddenNote, type Row } from "./focus.ts";
import {
	actionable, diffTrees, exactLabel, exactLabels, interactive, parseElements, withoutChrome, parseWindows, Refs, renderRow, resolveWindow, SENSITIVE, visibleRows,
	type El, type Win,
} from "./model.ts";

/** The prompt block, fixed for the whole launch so the cached prefix never changes. */
export function cuaInstructions(env: NodeJS.ProcessEnv = process.env): string {
	const where = env.JUNA_CUA_COMMAND?.trim()
		? "The desktop you operate is a DIFFERENT machine from the one your shell runs on: bash, files and local apps are on this machine, and only the ui_* tools reach the desktop. Never launch the target app with bash."
		: "The desktop you operate is this machine's.";
	return CUA_INSTRUCTIONS.replace("<juna_cua>\n", `<juna_cua>\n${where}\n`);
}

export const CUA_INSTRUCTIONS = `
<juna_cua>
Desktop apps are yours to operate. A model turn costs seconds and a UI action well under one, so spend turns only on decisions. Desktop tasks need no skill lookup: go straight to the ui_* tools.
- To start an app or open a website, use ui_act do=open: app is the app to launch ("Google Chrome"), target an optional URL to open in it. The result names the window to address next, and then can continue in it.
- Plan the whole UI task, then send it in as few calls as possible: one ui_act with then for steps you can name (later steps may target controls earlier ones reveal), ui_do for a short goal whose steps you cannot. Calls on different windows go in the same response.
- When the task names controls, act on them by label at once; ui_look is for when you do not know the names. Its list is focused on the task; all=true shows everything. Ask for image=true only when the controls cannot show what you need.
- type or key with no target goes to the window's focused control, such as a rename box that just opened.
- Results report what changed. Pass look=true when you will need the resulting window, to report it or choose the next step; never spend a turn on ui_look just to confirm.
- When an app cannot take background input at all, the action retries in the foreground by itself. If a result still says the app ignored background input, retry with foreground=true (takes focus). Send/delete/pay/submit stops for confirmation; pass confirm=true only when the user asked for that outcome.
</juna_cua>`;

const MAX_ROWS = Number(process.env.JUNA_CUA_MAX_ROWS) || 200;
const MIN_CONFIDENCE = Number(process.env.JUNA_CUA_MIN_CONFIDENCE) || 0.6;
const IMAGE_DIMENSION = Number(process.env.JUNA_CUA_IMAGE_DIMENSION) || 1280;
const MAX_DIFF_LINES = 25;
// A plain string enum: a union of literals serializes one {const} object per verb.
const VERBS = Type.Unsafe<Verb>({ type: "string", enum: ["open", "click", "double", "right", "set", "type", "key", "scroll_up", "scroll_down", "menu"] });

type Verb = "open" | "click" | "double" | "right" | "set" | "type" | "key" | "scroll_up" | "scroll_down" | "menu";

interface Read { window: Win; others: Win[]; elements: El[]; total: number; degraded: boolean; partial?: boolean }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The driver refused before delivering anything because this window class
 *  cannot take background input at all (Chrome's key combos, for example).
 *  Nothing landed, so retrying in the foreground cannot deliver twice. */
export function needsForeground(reply: DriverReply): boolean {
	const d = reply.data ?? {};
	return d.escalation?.reason === "background_unavailable" || d.code === "background_unavailable"
		|| /Background delivery is not available/i.test(reply.text);
}

/** A reply that says the input never landed, even though the call succeeded. */
export function refusal(reply: DriverReply): string | undefined {
	const d = reply.data ?? {};
	if (reply.isError) return reply.text.split("\n")[0] || "the driver returned an error";
	if (["refused", "error", "failed"].includes(d.status)) return d.refusal?.message ?? `the driver reported ${d.status}`;
	const reason = d.escalation?.reason;
	if (reason === "delivery_failed" || reason === "background_unavailable")
		return "the app ignored background input; retry with foreground=true";
	return undefined;
}

export interface Step { do: Verb; target?: string; text?: string; key?: string; x?: number; y?: number }

export class Desktop {
	readonly refs = new Refs();
	/** The last window list and the last read of each window. An action starts
	 *  from these instead of reading again; a stale handle is rejected by the
	 *  driver before any input lands, and the action then refreshes once. */
	private seen?: { windows: Win[]; at: number };
	private lastRead = new Map<number, Read>();
	/** The user's current request: what every focus judgement is measured against. */
	task = "";
	/** A remark from the last locate, such as which of several same-labelled controls it took. */
	note = "";

	constructor(readonly driver: Driver, readonly jev: JevConfig, private readonly ask = askJev, readonly cursor = false) {}

	async windows(signal?: AbortSignal): Promise<Win[]> {
		const reply = await this.driver.call("list_windows", {}, signal);
		if (reply.isError) throw new Error(`list_windows failed: ${reply.text}`);
		const windows = parseWindows(reply.data);
		this.seen = { windows, at: Date.now() };
		return windows;
	}

	/** The state an action starts from: the remembered read when it is recent, else a fresh one. */
	async current(app: string, signal?: AbortSignal): Promise<{ read: Read; cached: boolean }> {
		const maxAge = Number(process.env.JUNA_CUA_REUSE_MS) || 30_000;
		if (this.seen && Date.now() - this.seen.at < maxAge) {
			try {
				const { window } = resolveWindow(this.seen.windows, app);
				const read = this.lastRead.get(window.window_id);
				if (read) return { read, cached: true };
			} catch { /* not in the remembered list: read fresh */ }
		}
		return { read: await this.read(app, undefined, signal), cached: false };
	}

	async read(app: string, find?: string, signal?: AbortSignal): Promise<Read> {
		const { window, others } = resolveWindow(await this.windows(signal), app);
		return this.readWindow(window, others, find, signal);
	}

	async readWindow(window: Win, others: Win[], find?: string, signal?: AbortSignal): Promise<Read> {
		const args: Record<string, unknown> = { pid: window.pid, window_id: window.window_id, include_screenshot: false };
		if (find) args.query = find;
		let reply = await this.driver.call("get_window_state", args, signal);
		// A big tree (MMC, Explorer, Electron) can time out the full walk. The
		// driver's own advice is a bounded walk, so take it once, and say the
		// list is partial rather than failing the read.
		let partial = false;
		if (reply.isError && /timed out|unresponsive/i.test(reply.text)) {
			reply = await this.driver.call("get_window_state", { ...args, max_elements: Number(process.env.JUNA_CUA_BOUNDED_ELEMENTS) || 200 }, signal);
			partial = !reply.isError;
		}
		if (reply.isError) throw new Error(`reading ${window.app || window.title} failed: ${reply.text.split("\n")[0]}`);
		const { elements, total } = parseElements(reply.data);
		const read: Read = { window, others, elements, total, partial, degraded: reply.data?.degraded === true || total === 0 };
		if (!find) this.lastRead.set(window.window_id, read);
		return read;
	}

	async image(window: Win, signal?: AbortSignal) {
		const reply = await this.driver.call("get_window_state", {
			pid: window.pid, window_id: window.window_id, include_accessibility_tree: false, max_dimension: IMAGE_DIMENSION,
		}, signal);
		return reply.images[0];
	}

	title(w: Win): string {
		return `${w.app || "app"} "${w.title}" (pid ${w.pid}, window ${w.window_id})`;
	}

	/**
	 * A window's state as the model reads it: title, then one row per control.
	 * Mirror rows are dropped for free. A window past JUNA_CUA_FOCUS_MIN_ROWS
	 * gets one Noul per row against the task, and only rows Jev is confident are
	 * unneeded are hidden, with a footer saying what went. Fails open.
	 */
	async present(read: Read, context = "", all = false, signal?: AbortSignal): Promise<string[]> {
		const id = read.window.window_id;
		let rows: Row[] = dropMirrors(visibleRows(read.elements).map((el) => {
			const ref = this.refs.ref(id, el);
			return { ref, el, line: renderRow(ref, el) };
		}));
		if (!all) rows = foldCells(rows);
		let note = "";
		const minRows = Number(process.env.JUNA_CUA_FOCUS_MIN_ROWS) || 40;
		if (!all && this.jev.apiKey && rows.length > minRows) {
			try {
				const task = [this.task, context].filter(Boolean).join("\nRight now: ");
				const shards: Row[][] = [];
				for (let i = 0; i < rows.length; i += 50) shards.push(rows.slice(i, i + 50));
				const answers = await Promise.all(shards.map((shard) => this.ask1(focusRequest(this.jev.model, task, this.title(read.window), shard), signal)));
				const keep = shards.flatMap((shard, i) => decideFocus(shard, answers[i] as any, Number(process.env.JUNA_CUA_FOCUS_FLOOR) || 0.15));
				const hidden = rows.filter((_r, i) => !keep[i]);
				if (hidden.length && hidden.length < rows.length) { note = hiddenNote(hidden); rows = rows.filter((_r, i) => keep[i]); }
			} catch { /* fail open: show everything */ }
		}
		const lines = rows.map((r) => r.line);
		return [this.title(read.window) + (read.partial ? " [partial tree: the full walk timed out; use find to reach deeper controls]" : ""), ...lines.slice(0, MAX_ROWS),
			...(lines.length > MAX_ROWS ? [`(${lines.length - MAX_ROWS} more; narrow with ui_look find)`] : []), ...(note ? [note] : [])];
	}

	/** The unfocused full state, for tests and for callers that must see everything. */
	snapshot(read: Read): string[] {
		const rows = dropMirrors(visibleRows(read.elements).map((el) => { const ref = this.refs.ref(read.window.window_id, el); return { ref, el, line: renderRow(ref, el) }; }));
		return [this.title(read.window), ...rows.map((r) => r.line).slice(0, MAX_ROWS)];
	}

	rows(read: Read): string[] {
		return visibleRows(read.elements).map((el) => renderRow(this.refs.ref(read.window.window_id, el), el));
	}

	async ask1(body: Record<string, unknown>, signal?: AbortSignal) {
		return (await this.ask(body, this.jev, signal)).answers ?? {};
	}

	/** One control, by ref, exact label, or (with a Jev key) description. */
	async locate(read: Read, target: string, verb: Verb, signal?: AbortSignal): Promise<El> {
		this.note = "";
		// Models often paste a whole row ("e22 Edit \"Search for :\"") as the target; its leading ref is what they mean.
		const ref = this.refs.lookup(/^(e\d+)\b/i.exec(target.trim())?.[1] ?? target);
		if (ref) {
			if (ref.window !== read.window.window_id)
				throw new Error(`${target} belongs to another window; call ui_look for this one`);
			const el = read.elements.find((e) => e.key === ref.key);
			if (!el) throw new Error(`${target} is no longer on screen; call ui_look again`);
			return el;
		}
		if (/^e\d+$/i.test(target.trim())) throw new Error(`${target} is not a ref from this session; call ui_look`);
		const pool = withoutChrome(actionable(read.elements, verb), target);
		// Text input only ever resolves to an editable control. Other verbs may
		// fall back to any visible row with that exact label.
		const exact = exactLabel(pool, target)
			?? (verb === "set" || verb === "type" ? undefined : exactLabel(withoutChrome(visibleRows(read.elements), target), target));
		if (exact) return exact;
		// Several controls carry exactly this label: Jev chooses among those
		// alone, which is a far easier question than choosing among everything.
		let tied = exactLabels(pool, target);
		// A plain label inside a clickable row ("About" the Text inside "About" the
		// ListItem) is never the thing to click when the row itself is tied too.
		if (["click", "double", "right"].includes(verb) && tied.some(interactive)) tied = tied.filter(interactive);
		if (tied.length === 1) return tied[0]!;
		if (!this.jev.apiKey) throw new Error(`${tied.length > 1 ? `${tied.length} controls are labelled` : "no control labelled"} "${target}". Use a ref from ui_look, or set a TypeSafe key for descriptions`);
		const candidates = tied.length > 1
			? tied.map((el) => ({ ref: this.refs.ref(read.window.window_id, el), el }))
			: shortlist(pool.map((el) => ({ ref: this.refs.ref(read.window.window_id, el), el })), target);
		if (!candidates.length) throw new Error("this window lists no controls that can take that action");
		const answer = (await this.ask1(pickRequest(this.jev.model, this.title(read.window), verb, target, candidates, this.task), signal)).target as Choice | undefined;
		const pick = candidates.find((c) => c.ref === answer?.choice);
		// Every tie carries the exact label the caller named. When Jev cannot
		// separate them and exactly one is selected, that is the one in play:
		// the list item being renamed, the page the sidebar already shows.
		const selected = tied.filter((e) => e.selected);
		if ((!pick || (answer?.confidence ?? 0) < MIN_CONFIDENCE) && tied.length > 1 && selected.length === 1) {
			this.note = `${tied.length} controls are labelled "${target}"; took the selected one. Others: ${tied.filter((e) => e !== selected[0]).map((e) => renderRow(this.refs.ref(read.window.window_id, e), e)).join(", ")}`;
			return selected[0]!;
		}
		if (!pick || (answer?.confidence ?? 0) < MIN_CONFIDENCE) {
			const top = Object.entries(answer?.probabilities ?? {}).filter(([id]) => id !== "none")
				.sort((a, b) => b[1] - a[1]).slice(0, 5)
				.map(([id]) => candidates.find((c) => c.ref === id)).filter(Boolean)
				.map((c) => renderRow(c!.ref, c!.el));
			throw new Error(`not sure which control "${target}" means${top.length ? `. Closest:\n${top.join("\n")}\nRetry with a ref.` : ""}`);
		}
		return pick.el;
	}

	/** Deliver one input. Returns a refusal reason, or undefined when the driver accepted it. */
	async perform(read: Read, verb: Verb, el: El | undefined, p: { text?: string; key?: string; x?: number; y?: number; foreground?: boolean; path?: string[] }, signal?: AbortSignal): Promise<string | undefined> {
		return (await this.deliver(read, verb, el, p, signal)).refused;
	}

	/** `rejected` means the driver refused the request itself (isError), so no input landed. */
	async deliver(read: Read, verb: Verb, el: El | undefined, p: { text?: string; key?: string; x?: number; y?: number; foreground?: boolean; path?: string[] }, signal?: AbortSignal): Promise<{ refused?: string; rejected: boolean; foregroundOnly?: boolean }> {
		const base: Record<string, unknown> = { pid: read.window.pid, window_id: read.window.window_id };
		if (p.foreground) base.delivery_mode = "foreground";
		const at = el?.token ? { element_token: el.token } : p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : {};
		let tool: string, args: Record<string, unknown>;
		switch (verb) {
			case "click": tool = "click"; args = { ...base, ...at }; break;
			case "double": tool = "double_click"; args = { ...base, ...at }; break;
			case "right": tool = "right_click"; args = { ...base, ...at }; break;
			case "set": tool = "set_value"; args = { pid: base.pid, window_id: base.window_id, ...at, value: p.text ?? "" }; break;
			case "type": tool = "type_text"; args = { ...base, ...at, text: p.text ?? "" }; break;
			case "scroll_up": case "scroll_down": tool = "scroll"; args = { ...base, ...at, direction: verb === "scroll_up" ? "up" : "down", amount: 5 }; break;
			case "open": throw new Error("open is not an input on a window; use ui_act do=open");
			case "menu": tool = "invoke_menu"; args = { pid: base.pid, window_id: base.window_id, path: p.path ?? [] }; break;
			case "key": {
				const keys = (p.key ?? "").split("+").map((k) => k.trim().toLowerCase()).filter(Boolean);
				if (!keys.length) throw new Error("key needs a key name, e.g. enter or cmd+s");
				tool = keys.length > 1 ? "hotkey" : "press_key";
				args = { ...base, ...at, ...(keys.length > 1 ? { keys } : { key: keys[0] }) };
				break;
			}
		}
		if (!("element_token" in args) && !("x" in args) && ["click", "double_click", "right_click", "set_value"].includes(tool))
			throw new Error(`${verb} needs a target (ref, label or description) or x,y`);
		// Foreground input lands on whatever is on top at that point, so the
		// target window must be on top first. Maximizing through accessibility
		// does not raise a window; another window can cover it the whole time.
		if (p.foreground) {
			const raised = await this.driver.call("bring_to_front", { pid: read.window.pid, window_id: read.window.window_id }, signal);
			if (raised.isError || raised.data?.landed_on_target === false)
				return { refused: `could not bring ${read.window.title || read.window.app} to the front: ${raised.text.split("\n")[0] || "another window kept focus"}`, rejected: true };
		}
		if (this.cursor) await this.pointAt(read, el, p, signal);
		const reply = await this.driver.call(tool, args, signal);
		return { refused: refusal(reply), rejected: reply.isError, foregroundOnly: needsForeground(reply) };
	}

	/**
	 * Aim the visible overlay cursor at the input's target. Accessibility input
	 * has no screen point of its own, so the overlay would never move. Cosmetic:
	 * the driver animates it without blocking, and a failure changes nothing.
	 */
	private async pointAt(read: Read, el: El | undefined, p: { x?: number; y?: number }, signal?: AbortSignal): Promise<void> {
		const w = read.window;
		// Keys and typing with no target go to whatever has focus: point at the
		// selected control when there is one, else the middle of the window.
		const target = el ?? read.elements.find((e) => e.selected && e.frame && e.frame.w > 0);
		const point = target?.frame && target.frame.w > 0
			? { x: Math.round(target.frame.x + target.frame.w / 2 - w.x), y: Math.round(target.frame.y + target.frame.h / 2 - w.y) }
			: p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y }
			: { x: Math.round(w.width / 2), y: Math.round(w.height / 2) };
		if (!point || point.x < 0 || point.y < 0 || point.x >= w.width || point.y >= w.height) return;
		await this.driver.call("move_cursor", { pid: w.pid, window_id: w.window_id, x: point.x, y: point.y, scope: "window" }, signal).catch(() => {});
	}

	/** What an action did, as a few lines: tree changes plus windows that opened or closed. */
	async observe(before: Read, signal?: AbortSignal): Promise<{ after: Read; lines: string[] }> {
		// Read at once, and wait only while nothing has changed yet: most
		// accessibility actions complete synchronously, so a fixed settle mostly
		// buys nothing. JUNA_CUA_SETTLE_MS caps how long a quiet window is watched.
		const settle = Number(process.env.JUNA_CUA_SETTLE_MS) || 350;
		const started = Date.now();
		await sleep(40);
		for (;;) {
			const seen = await this.observeOnce(before, signal);
			const quiet = seen.lines.length === 1 && seen.lines[0] === "no change in the window's controls";
			if (!quiet || Date.now() - started >= settle) return seen;
			await sleep(Math.min(120, settle - (Date.now() - started)));
		}
	}

	private async observeOnce(before: Read, signal?: AbortSignal): Promise<{ after: Read; lines: string[] }> {
		const windows = await this.windows(signal);
		const mine = windows.filter((w) => w.pid === before.window.pid && w.onScreen);
		const lines: string[] = [];
		for (const w of mine) if (w.window_id !== before.window.window_id && !before.others.some((o) => o.window_id === w.window_id))
			lines.push(`new window: "${w.title}" (address it as app="${w.title || w.window_id}")`);
		for (const o of before.others) if (!mine.some((w) => w.window_id === o.window_id)) lines.push(`closed window: "${o.title}"`);
		const still = windows.find((w) => w.window_id === before.window.window_id);
		if (!still) return { after: { ...before, elements: [], total: 0 }, lines: [...lines, "the window closed"] };
		const after = await this.readWindow(still, mine.filter((w) => w.window_id !== still.window_id), undefined, signal);
		const diff = diffTrees(before.elements, after.elements);
		const id = after.window.window_id;
		const change: string[] = [
			...diff.added.filter((e) => visibleRows([e]).length).map((e) => `+ ${renderRow(this.refs.ref(id, e), e)}`),
			...diff.changed.map(({ after: e }) => `~ ${renderRow(this.refs.ref(id, e), e)}`),
			...diff.removed.filter((e) => visibleRows([e]).length).map((e) => `- ${renderRow(this.refs.ref(id, e), e)}`),
		];
		lines.push(...change.slice(0, MAX_DIFF_LINES));
		if (change.length > MAX_DIFF_LINES) lines.push(`(${change.length - MAX_DIFF_LINES} more changes; ui_look to see the window)`);
		if (!lines.length) lines.push("no change in the window's controls");
		return { after, lines };
	}

	/**
	 * Start an app, or open a URL in one (or in the default browser). Returns the
	 * window to address next: a window that appeared, else the launched
	 * process's largest window, since a running browser opens a tab in place.
	 */
	async open(app: string, url: string | undefined, signal?: AbortSignal): Promise<{ window?: Win; lines: string[] }> {
		const before = new Set((await this.windows(signal)).map((w) => w.window_id));
		const browser = !app || /^(browser|default|default browser)$/i.test(app.trim());
		const args: Record<string, unknown> = url
			? (browser ? { urls: [url] } : { name: app, additional_arguments: [url] })
			: { name: app };
		const reply = await this.driver.call("launch_app", args, signal);
		if (reply.isError) throw new Error(`could not open ${app || url}: ${reply.text.split("\n")[0]}`);
		const pid = Number(reply.data?.pid) || undefined;
		const deadline = Date.now() + (Number(process.env.JUNA_CUA_OPEN_WAIT_MS) || 6000);
		let window: Win | undefined;
		for (;;) {
			const now = (await this.windows(signal)).filter((w) => w.onScreen && w.width > 1 && !/^cua-driver/i.test(w.app));
			const fresh = now.filter((w) => !before.has(w.window_id));
			const own = pid ? now.filter((w) => w.pid === pid) : [];
			window = [...(fresh.length ? fresh : own)].sort((a, b) => b.width * b.height - a.width * a.height)[0];
			if (window || Date.now() > deadline) break;
			await sleep(250);
		}
		const what = url ? `${url}${browser ? "" : ` in ${app}`}` : app;
		if (!window) return { lines: [`opened ${what}; no window has appeared yet (ui_look lists windows)`] };
		return { window, lines: [`opened ${what}: ${this.title(window)}`, `address it as app=${JSON.stringify(window.title || window.app)}`] };
	}

	/** One ui_act step from a known state. A stale remembered state is refreshed once. */
	async step(app: string, start: { read: Read; cached: boolean }, step: Step, opts: { confirm?: boolean; foreground?: boolean }, signal?: AbortSignal):
		Promise<{ after?: Read; lines: string[]; stopped: boolean }> {
		let { read, cached } = start;
		for (;;) {
			const el = step.target && step.do !== "menu" ? await this.locate(read, step.target, step.do, signal).catch((error) => {
				if (cached) return undefined;
				throw error;
			}) : undefined;
			if (step.target && step.do !== "menu" && !el) { ({ read, cached } = { read: await this.read(app, undefined, signal), cached: false }); continue; }
			const label = el ? renderRow(this.refs.ref(read.window.window_id, el), el) : step.target ?? step.key ?? "";
			if (el && SENSITIVE.test(el.label) && !opts.confirm && (step.do === "click" || step.do === "double"))
				return { lines: [`not done: ${label} looks hard to undo. Call again with confirm=true if the user asked for this.`], stopped: true };
			const input = {
				text: step.text, key: step.key, x: step.x, y: step.y, foreground: opts.foreground,
				path: step.do === "menu" ? (step.target ?? "").split(/\s*(?:>|›)\s*/).filter(Boolean) : undefined,
			};
			let { refused, rejected, foregroundOnly } = await this.deliver(read, step.do, el, input, signal);
			// The driver says this window cannot take background input at all and
			// nothing was delivered: retry at once instead of spending a model turn.
			let escalated = false;
			if (foregroundOnly && !opts.foreground && !["0", "false", "no"].includes((process.env.JUNA_CUA_AUTO_FOREGROUND ?? "").toLowerCase())) {
				({ refused, rejected, foregroundOnly } = await this.deliver(read, step.do, el, { ...input, foreground: true }, signal));
				escalated = true;
			}
			if (rejected && cached && !escalated) { read = await this.read(app, undefined, signal); cached = false; continue; }
			if (refused) return { lines: [`not done: ${step.do} ${label}: ${refused}`], stopped: true };
			const { after, lines } = await this.observe(read, signal);
			const note = [...(this.note ? [`(${this.note})`] : []), ...(escalated ? ["(sent in the foreground: this app takes no background input)"] : [])];
			return { after, lines: [`${step.do} ${label}`.trim(), ...note, ...lines], stopped: false };
		}
	}

	/** One small outcome, one batched Jev request per step. Code owns every stop. */
	async achieve(params: { app: string; goal: string; text?: string; steps?: number; confirm?: boolean; look?: boolean }, signal?: AbortSignal): Promise<string> {
		if (!this.jev.apiKey) throw new Error("ui_do needs a TypeSafe key; use ui_look and ui_act instead");
		const limit = Math.min(12, Math.max(1, Math.floor(params.steps ?? 6)));
		const history: string[] = [];
		const start = await this.read(params.app, undefined, signal);
		let read = start;
		// The reply carries the window's net change, so reporting the outcome
		// needs no further ui_look turn.
		let lookLines: string[] = [];
		const finish = (status: string, detail = "") => {
			const id = read.window.window_id;
			const changes = diffTrees(start.elements, read.elements);
			const rows = [
				...changes.added.filter((e) => visibleRows([e]).length).map((e) => `+ ${renderRow(this.refs.ref(id, e), e)}`),
				...changes.changed.map(({ after: e }) => `~ ${renderRow(this.refs.ref(id, e), e)}`),
				...changes.removed.filter((e) => visibleRows([e]).length).map((e) => `- ${renderRow(this.refs.ref(id, e), e)}`),
			];
			return [`${status}${detail ? `: ${detail}` : ""}`, ...history.map((h, i) => `${i + 1}. ${h}`),
				rows.length ? "net change since the start:" : "no controls changed since the start",
				...rows.slice(0, MAX_DIFF_LINES),
				...(rows.length > MAX_DIFF_LINES ? [`(${rows.length - MAX_DIFF_LINES} more)`] : []),
				...(params.look ? ["", ...lookLines] : [])].join("\n");
		};
		const done = async (status: string, detail = "") => {
			if (params.look) lookLines = await this.present(read, params.goal, false, signal).catch(() => this.snapshot(read));
			return finish(status, detail);
		};
		let lastAction = "";
		for (let step = 0; step < limit; step++) {
			signal?.throwIfAborted();
			const id = read.window.window_id;
			const rows = visibleRows(read.elements);
			const candidates = shortlist(actionable(read.elements, "click").concat(actionable(read.elements, "set"))
				.filter((el, i, all) => all.indexOf(el) === i)
				.map((el) => ({ ref: this.refs.ref(id, el), el })), params.goal);
			let answers: Record<string, any>;
			try {
				answers = await this.ask1(stepRequest(this.jev.model, params.goal, params.text, this.title(read.window),
					rows.slice(0, 150).map((el) => renderRow(this.refs.ref(id, el), el)).join("\n"), history, candidates), signal);
			} catch (error) {
				return await done("stuck", `Jev failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const action = answers.action as Choice | undefined, target = answers.target as Choice | undefined;
			// Two independent answers must agree before claiming success: the
			// done probability, and either its own strength or the chosen action.
			const met = (answers.done as Noul | undefined)?.noul ?? 0;
			if (met >= 0.85 || (met >= 0.5 && action?.choice === "done" && (action.confidence ?? 0) >= MIN_CONFIDENCE))
				return await done("done", `goal met per Jev, ${likelihood(met)}`);
			if (action?.choice === "done") return await done("ambiguous", `Jev chose to stop but doubts the goal is met (${likelihood(met)}); check with ui_look`);
			if (!action?.choice || (action.confidence ?? 0) < MIN_CONFIDENCE) return await done("ambiguous", "no confident next step; take over with ui_look/ui_act");
			if (action.choice === "stuck") return await done("stuck", "Jev sees no way forward from this screen");
			const el = candidates.find((c) => c.ref === target?.choice)?.el;
			const needsTarget = action.choice === "click" || action.choice === "set_text";
			if (needsTarget && (!el || (target?.confidence ?? 0) < MIN_CONFIDENCE)) {
				const top = Object.entries(target?.probabilities ?? {}).filter(([r]) => r !== "none").sort((a, b) => b[1] - a[1]).slice(0, 4)
					.map(([r]) => candidates.find((c) => c.ref === r)).filter(Boolean).map((c) => renderRow(c!.ref, c!.el));
				return await done("ambiguous", `unsure which control to ${action.choice}${top.length ? `; closest: ${top.join(" | ")}` : ""}`);
			}
			const row = el ? renderRow(this.refs.ref(id, el), el) : "";
			const risky = el && (SENSITIVE.test(el.label) || (((answers.irreversible as Noul | undefined)?.noul ?? 0) >= 0.5 && /^(ok|yes|save|apply|done|continue|next|finish)$/i.test(el.label.trim())));
			if (risky && !params.confirm && action.choice === "click")
				return await done("needs_confirmation", `next step would click ${row}; call again with confirm=true if the user wants that`);
			const signature = `${action.choice} ${row}`;
			if (signature === lastAction && history.at(-1)?.endsWith("(no change)")) return await done("stuck", "the same step changed nothing twice");
			lastAction = signature;
			const verb: Verb = action.choice === "set_text" ? "set" : action.choice.startsWith("press_") ? "key" : action.choice === "scroll_down" ? "scroll_down" : "click";
			const refused = await this.perform(read, verb, needsTarget ? el : undefined, {
				text: params.text, key: action.choice === "press_enter" ? "enter" : action.choice === "press_escape" ? "escape" : undefined,
			}, signal).catch((error: Error) => error.message);
			if (refused) { history.push(`${signature}: not done (${refused})`); return await done("stuck", refused); }
			const observed = await this.observe(read, signal);
			const effect = observed.lines[0] === "no change in the window's controls" ? " (no change)"
				: ` → ${observed.lines.slice(0, 3).join("; ")}${observed.lines.length > 3 ? `; ${observed.lines.length - 3} more changes` : ""}`;
			history.push(`${signature}${effect}`);
			if (observed.after.elements.length === 0 && observed.lines.includes("the window closed")) return await done("done", "the window closed after the last step; check the result");
			read = observed.after;
		}
		return await done("budget_exhausted", `${limit} steps taken`);
	}
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/**
 * JUNA_CUA_CURSOR=1 shows the driver's agent cursor, an overlay separate from
 * the real mouse, moving to each target so a person can watch the run live.
 * The driver animates it on its own, so an action never waits for the glide;
 * the cost is one millisecond-scale call per action. Off unless asked for.
 */
export function cursorSetup(env = process.env): [string, Record<string, unknown>][] {
	if (!["1", "true", "yes"].includes((env.JUNA_CUA_CURSOR ?? "").toLowerCase())) return [];
	return [
		["set_agent_cursor_enabled", { enabled: true }],
		["set_agent_cursor_motion", {
			glide_duration_ms: Number(env.JUNA_CUA_CURSOR_GLIDE_MS) || 120,
			dwell_after_click_ms: Number(env.JUNA_CUA_CURSOR_DWELL_MS) || 0,
			idle_hide_ms: 60_000,
			// Straight lines. The default arcs, springs and turn radius make a
			// short glide overshoot and loop around its target.
			arc_size: 0, arc_flow: 0, turn_radius: 0, spring: 1, start_handle: 0, end_handle: 0,
		}],
	];
}

export default function (pi: ExtensionAPI) {
	const setup = cursorSetup();
	const PROMPT = cuaInstructions();
	const desktop = new Desktop(new Driver(process.env, 30_000, setup), loadConfig(), askJev, setup.length > 0);

	pi.on("before_agent_start", (event) => {
		desktop.task = (event.prompt ?? "").trim();
		if (!pi.getActiveTools().includes("ui_look")) return;
		return { systemPrompt: event.systemPrompt.includes("<juna_cua>") ? event.systemPrompt : event.systemPrompt + "\n" + PROMPT };
	});
	pi.on("session_shutdown", () => desktop.driver.stop());

	pi.registerTool({
		name: "ui_look",
		label: "UI Look",
		description: "List on-screen windows, or one window's controls as refs, focused on the task. find filters by label/value; all=true skips focus; image=true adds a screenshot.",
		promptSnippet: "Read desktop windows and their controls",
		parameters: Type.Object({
			app: Type.Optional(Type.String({ description: "App, process, pid or title; omit to list windows." })),
			find: Type.Optional(Type.String()),
			all: Type.Optional(Type.Boolean()),
			image: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			try {
				if (!params.app) {
					const seen = new Set<string>();
					const lines = (await desktop.windows(signal)).filter((w) => w.onScreen && w.width > 1 && !/^cua-driver/i.test(w.app))
						.sort((a, b) => b.z - a.z)
						.flatMap((w) => { const line = `${w.app} "${w.title}" pid ${w.pid}`; return seen.has(line) ? [] : (seen.add(line), [line]); });
					return text(lines.join("\n") || "no windows on screen");
				}
				const read = await desktop.read(params.app, params.find, signal);
				const [title, ...body] = await desktop.present(read, params.find ?? "", params.all === true, signal);
				const head = [title!];
				if (read.others.length) head.push(`also open: ${read.others.map((w) => `"${w.title}"`).join(", ")}`);
				const empty = body.length === 0;
				const wantImage = params.image || read.degraded || empty;
				if (empty) body.push(params.find ? `nothing matches "${params.find}"` : "no accessible controls: this window needs the screenshot and x,y clicks");
				const content: any[] = [{ type: "text", text: [...head, ...body].join("\n") }];
				if (wantImage) {
					const img = await desktop.image(read.window, signal);
					if (img) content.push({ type: "image", data: img.data, mimeType: img.mimeType }, { type: "text", text: "x,y for ui_act are pixels in this image" });
				}
				return { content, details: undefined };
			} catch (error) {
				throw new Error(error instanceof Error ? error.message : String(error));
			}
		},
	});

	pi.registerTool({
		name: "ui_act",
		label: "UI Act",
		description: "Input on a window control; reports what changed. do=open launches app (target: optional URL). target: ref, exact label, or description; for menu, \"File > Save As…\". then: further steps, each resolved on the screen the last one left. text: for set/type. key: e.g. enter, cmd+s.",
		promptSnippet: "Click, type or press keys in a desktop window",
		parameters: Type.Object({
			app: Type.String(),
			do: VERBS,
			target: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			key: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			then: Type.Optional(Type.Array(Type.Object({
				do: VERBS,
				target: Type.Optional(Type.String()),
				text: Type.Optional(Type.String()),
				key: Type.Optional(Type.String()),
			}))),
			expect: Type.Optional(Type.String()),
			look: Type.Optional(Type.Boolean()),
			foreground: Type.Optional(Type.Boolean()),
			confirm: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			try {
				const out: string[] = [];
				let appName = params.app;
				let chain = params.then ?? [];
				if (params.do === "open") {
					const opened = await desktop.open(params.app, params.target, signal);
					out.push(...opened.lines);
					if (!opened.window || !chain.length) {
						if (params.look && opened.window) out.push("", ...await desktop.present(await desktop.readWindow(opened.window, [], undefined, signal), "", false, signal));
						return text(out.join("\n"));
					}
					appName = opened.window.title || opened.window.app;
					const [first, ...rest] = chain;
					params = { ...params, app: appName, do: first!.do, target: first!.target, text: first!.text, key: first!.key, x: undefined, y: undefined };
					chain = rest;
				}
				const steps: Step[] = [{ do: params.do as Verb, target: params.target, text: params.text, key: params.key, x: params.x, y: params.y },
					...chain.map((s) => ({ ...s, do: s.do as Verb }))];
				let state = await desktop.current(appName, signal);
				let after: Read | undefined;
				for (const [i, step] of steps.entries()) {
					const result = await desktop.step(appName, state, step, { confirm: params.confirm, foreground: params.foreground }, signal);
					out.push(...(steps.length > 1 ? result.lines.map((l, j) => (j === 0 ? `${i + 1}. ${l}` : `   ${l}`)) : result.lines));
					if (result.stopped || !result.after) {
						if (i < steps.length - 1) out.push(`stopped: steps ${i + 2}-${steps.length} not run`);
						return text(out.join("\n"));
					}
					after = result.after;
					if (result.lines.includes("the window closed")) {
						if (i < steps.length - 1) out.push(`stopped: the window closed; steps ${i + 2}-${steps.length} not run`);
						return text(out.join("\n"));
					}
					state = { read: after, cached: false };
				}
				if (params.expect && desktop.jev.apiKey && after) {
					try {
						const holds = (await desktop.ask1(expectRequest(desktop.jev.model, desktop.title(after.window),
							desktop.rows(after).slice(0, MAX_ROWS).join("\n"), out.join("\n"), params.expect), signal)).holds as Noul | undefined;
						out.push(`expect "${params.expect}": ${likelihood(holds?.noul)}`);
					} catch (error) {
						out.push(`expect not checked: ${error instanceof JevError ? error.message : String(error)}`);
					}
				}
				if (params.look && after) out.push("", ...await desktop.present(after, params.expect ?? "", false, signal));
				return text(out.join("\n"));
			} catch (error) {
				throw new Error(error instanceof DriverError || error instanceof Error ? error.message : String(error));
			}
		},
	});

	pi.registerTool({
		name: "ui_do",
		label: "UI Do",
		description: "Work toward one small UI outcome without further turns. Returns done, stuck, ambiguous or needs_confirmation, the steps taken and the net change. text is entered as given, never invented.",
		promptSnippet: "Carry out a short multi-step task in a desktop app",
		parameters: Type.Object({
			app: Type.String(),
			goal: Type.String(),
			text: Type.Optional(Type.String()),
			steps: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })),
			look: Type.Optional(Type.Boolean()),
			confirm: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			return text(await desktop.achieve(params, signal));
		},
	});
}
