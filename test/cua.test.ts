import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import cua, { cuaInstructions, cursorSetup, Desktop, needsForeground, refusal } from "../extensions/cua/index.ts";
import { Driver, DriverError, driverCommand, readReply } from "../extensions/cua/driver.ts";
import { actionable, diffTrees, exactLabel, parseElements, parseWindows, Refs, renderRow, resolveWindow, SENSITIVE } from "../extensions/cua/model.ts";
import { shortlist, stepRequest } from "../extensions/cua/decide.ts";
import { decideFocus, dropMirrors, focusRequest, foldCells, hiddenNote } from "../extensions/cua/focus.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const windows = parseWindows({ windows: [
	{ window_id: 1, pid: 10, app_name: "charmap.exe", title: "Character Map", bounds: { x: 0, y: 0, width: 400, height: 500 }, z_index: 3 },
	{ window_id: 2, pid: 10, app_name: "charmap.exe", title: "Save", bounds: { x: 50, y: 50, width: 200, height: 100 }, z_index: 9 },
	{ window_id: 3, pid: 20, app_name: "notepad.exe", title: "Untitled - Notepad", bounds: { x: 0, y: 0, width: 800, height: 600 }, z_index: 1 },
	{ window_id: 4, pid: 30, app_name: "cua-driver.exe", title: "Cua.AgentCursorOverlay.default", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, z_index: 99 },
] });

const tree = (checked: boolean, extra: object[] = []) => ({
	snapshot_id: "s1", total_element_count: 4 + extra.length,
	elements: [
		{ element_index: 0, element_token: "s1:0", role: "Edit", label: "Characters to copy :", value: "", actions: ["set_value"] },
		{ element_index: 1, element_token: "s1:1", role: "Button", label: "Select", actions: ["invoke"] },
		{ element_index: 2, element_token: "s1:2", role: "CheckBox", label: "Advanced view", selected: checked, actions: ["toggle"] },
		{ element_index: 3, element_token: "s1:3", role: "Pane", label: "", actions: [] },
		...extra,
	],
});

describe("windows", () => {
	test("the largest window of a process is the target, never the frontmost dialog", () => {
		const { window, others } = resolveWindow(windows, "charmap");
		expect(window.window_id).toBe(1);
		expect(others.map((w) => w.window_id)).toEqual([2]);
	});

	test("a title addresses that window itself, and the driver's overlay is never a target", () => {
		expect(resolveWindow(windows, "Save").window.window_id).toBe(2);
		expect(resolveWindow(windows, "20").window.window_id).toBe(3);
		expect(() => resolveWindow(windows, "Cua.AgentCursorOverlay.default")).toThrow(/no window matches/);
	});

	test("no match names what is on screen", () => {
		expect(() => resolveWindow(windows, "photoshop")).toThrow(/On screen: charmap, notepad/);
	});
});

describe("elements", () => {
	test("refs stay stable across reads and survive index shifts", () => {
		const refs = new Refs();
		const first = parseElements(tree(false)).elements;
		const shifted = parseElements({ elements: [{ element_index: 0, role: "Text", label: "new banner" },
			...tree(false).elements.map((e: any) => ({ ...e, element_index: e.element_index + 1 }))] }).elements;
		const a = refs.ref(1, first.find((e) => e.label === "Select")!);
		const b = refs.ref(1, shifted.find((e) => e.label === "Select")!);
		expect(a).toBe(b);
		expect(refs.ref(2, first[1]!)).not.toBe(a);
		expect(refs.lookup(a.toUpperCase())).toEqual({ window: 1, key: "Button|Select|0" });
	});

	test("rows are compact, and a toggle always states whether it is checked", () => {
		const [edit, , box] = parseElements(tree(false)).elements;
		expect(renderRow("e1", { ...edit!, value: "abc" })).toBe('e1 Edit "Characters to copy :" = "abc"');
		expect(renderRow("e3", box!)).toBe('e3 CheckBox "Advanced view" (unchecked)');
		expect(renderRow("e3", { ...box!, selected: true, enabled: false })).toBe('e3 CheckBox "Advanced view" (disabled) (checked)');
	});

	test("macOS AX roles lose their prefix", () => {
		expect(parseElements({ elements: [{ element_index: 0, role: "AXButton", label: "OK" }] }).elements[0]!.role).toBe("Button");
	});

	test("a diff names what appeared, vanished and changed", () => {
		const before = parseElements(tree(false)).elements;
		const after = parseElements(tree(true, [{ element_index: 4, role: "Edit", label: "Search for :" }])).elements;
		const diff = diffTrees(before, after);
		expect(diff.added.map((e) => e.label)).toEqual(["Search for :"]);
		expect(diff.changed.map((c) => c.after.label)).toEqual(["Advanced view"]);
		expect(diff.removed).toEqual([]);
	});

	test("verbs narrow candidates, and an exact label is the no-model path", () => {
		const els = parseElements(tree(false)).elements;
		expect(actionable(els, "set").map((e) => e.label)).toEqual(["Characters to copy :"]);
		expect(actionable(els, "click").map((e) => e.label)).toEqual(["Characters to copy :", "Select", "Advanced view"]);
		expect(exactLabel(els, "characters to copy")?.index).toBe(0);
		expect(exactLabel(els, "copy")).toBeUndefined();
	});

	test("hard-to-undo labels are caught on the raw text", () => {
		for (const label of ["Delete", "Send now", "Empty Trash", "Pay $12.00"]) expect(SENSITIVE.test(label)).toBe(true);
		for (const label of ["Select", "Advanced view", "Open"]) expect(SENSITIVE.test(label)).toBe(false);
	});
});

describe("Jev requests", () => {
	test("a step asks every question in one request, and set_text exists only with text", () => {
		const els = parseElements(tree(false)).elements.map((el, i) => ({ ref: `e${i + 1}`, el }));
		const withText = stepRequest("jev-latest", "search", "omega", "w", "rows", [], els) as any;
		const without = stepRequest("jev-latest", "search", undefined, "w", "rows", [], els) as any;
		expect(Object.keys(withText.questions).sort()).toEqual(["action", "done", "irreversible", "target"]);
		expect(withText.questions.action.criteria.set_text).toBeDefined();
		expect(without.questions.action.criteria.set_text).toBeUndefined();
		expect(withText.questions.target.criteria.none).toBeDefined();
	});

	test("a long candidate list is cut to the rows sharing words with the request", () => {
		const many = Array.from({ length: 100 }, (_, i) => ({ el: { label: i === 77 ? "Export PDF" : `Item ${i}`, role: "Button", actions: [] } as any }));
		const kept = shortlist(many, "export as pdf", 10);
		expect(kept.length).toBe(10);
		expect(kept.some((c) => c.el.label === "Export PDF")).toBe(true);
	});
});

describe("driver", () => {
	test("replies normalize, and refused input is recognized", () => {
		const reply = readReply({ content: [{ type: "text", text: "✅ done" }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: { ok: 1 } });
		expect(reply).toEqual({ data: { ok: 1 }, text: "done", isError: false, images: [{ data: "AAAA", mimeType: "image/png" }] });
		expect(refusal({ ...reply, data: { escalation: { reason: "delivery_failed" } } })).toContain("foreground=true");
		expect(refusal({ ...reply, data: { status: "refused", refusal: { message: "menu path segment 1 was not found" } } })).toContain("menu path");
		expect(refusal({ ...reply, isError: true, text: "bad token" })).toBe("bad token");
		expect(refusal(reply)).toBeUndefined();
	});

	test("the visible cursor is opt-in and sets a glide and a click dwell", () => {
		expect(cursorSetup({})).toEqual([]);
		const setup = cursorSetup({ JUNA_CUA_CURSOR: "1", JUNA_CUA_CURSOR_GLIDE_MS: "600" });
		expect(setup.map(([name]) => name)).toEqual(["set_agent_cursor_enabled", "set_agent_cursor_motion"]);
		expect(setup[1]![1]).toMatchObject({ glide_duration_ms: 600, dwell_after_click_ms: 0 });
	});

	test("with the cursor on, the overlay moves to the control's center before the input, in window coordinates", async () => {
		const framed = { snapshot_id: "s1", total_element_count: 1, elements: [
			{ element_index: 0, element_token: "s1:0", role: "Button", label: "Select", actions: ["invoke"], frame: { x: 300, y: 400, w: 60, h: 20 } },
		] };
		const { driver, inputs } = scripted([framed]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 }, undefined, true);
		const read = await desktop.read("charmap");
		await desktop.perform(read, "click", read.elements[0], {});
		expect(inputs.map((i) => i.name)).toEqual(["move_cursor", "click"]);
		expect(inputs[0]!.args).toEqual({ pid: 10, window_id: 1, x: 330, y: 410, scope: "window" });
	});

	test("the command override takes an argv array or a shell string", () => {
		expect(driverCommand({ JUNA_CUA_COMMAND: '["ssh","box","cua-driver mcp"]' })).toEqual({ file: "ssh", args: ["box", "cua-driver mcp"], shell: false });
		expect(driverCommand({ JUNA_CUA_COMMAND: "cua-driver mcp --socket /tmp/x" }).shell).toBe(true);
		expect(driverCommand({ JUNA_CUA_BIN: "/opt/cua" })).toEqual({ file: "/opt/cua", args: ["mcp"], shell: false });
	});

	test("one process serves every call, and a call lost to a crash is never replayed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "juna-cua-driver-"));
		const log = join(dir, "calls.log");
		const server = join(dir, "server.ts");
		writeFileSync(server, `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "start\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
		const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
		if (msg.id === undefined) continue;
		if (msg.method === "tools/call") appendFileSync(${JSON.stringify(log)}, msg.params.name + "\\n");
		if (msg.params?.name === "crash") process.exit(3);
		const result = msg.method === "initialize" ? {} : { content: [{ type: "text", text: "✅ " + msg.params.name }], structuredContent: { echo: msg.params.arguments } };
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
	}
});`);
		const driver = new Driver({ ...process.env, JUNA_CUA_COMMAND: JSON.stringify([process.execPath, server]) }, 5000);
		try {
			const [a, b] = await Promise.all([driver.call("list_windows"), driver.call("click", { pid: 1 })]);
			expect(a.text).toBe("list_windows");
			expect(b.data).toEqual({ echo: { pid: 1 } });
			await expect(driver.call("crash")).rejects.toBeInstanceOf(DriverError);
			expect((await driver.call("get_config")).text).toBe("get_config");
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual(["start", "list_windows", "click", "crash", "start", "get_config"]);
		} finally {
			driver.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** A scripted desktop: list_windows, then trees in order, recording every input. */
function scripted(trees: object[]) {
	const inputs: { name: string; args: any }[] = [];
	let reads = 0;
	const driver = {
		async call(name: string, args: any = {}) {
			if (name === "list_windows") return { data: { windows: [{ window_id: 1, pid: 10, app_name: "charmap.exe", title: "Character Map", bounds: { width: 400, height: 500 } }] }, text: "", isError: false, images: [] };
			if (name === "get_window_state") return { data: trees[Math.min(reads++, trees.length - 1)], text: "", isError: false, images: [] };
			inputs.push({ name, args });
			return { data: { route: "accessibility" }, text: "", isError: false, images: [] };
		},
		stop() {},
	};
	return { driver, inputs };
}

/** Scripted Jev answers; `pick` names a control by label and finds its ref in the request. */
function jevScript(steps: { action: string; pick?: string; done?: number; irreversible?: number; confidence?: number }[]) {
	const bodies: any[] = [];
	const ask = async (body: any) => {
		bodies.push(body);
		const step = steps[Math.min(bodies.length - 1, steps.length - 1)]!;
		const criteria = body.questions.target?.criteria ?? {};
		const ref = step.pick ? Object.keys(criteria).find((id) => String(criteria[id]).includes(step.pick!)) : "none";
		return { answers: {
			action: { choice: step.action, confidence: step.confidence ?? 0.95 },
			target: { choice: ref, confidence: 0.95, probabilities: ref ? { [ref]: 0.95 } : {} },
			done: { noul: step.done ?? 0.05 },
			irreversible: { noul: step.irreversible ?? 0.05 },
		} };
	};
	return { ask, bodies };
}

const keyed = { apiKey: "k", model: "jev-latest", endpoint: "", timeoutMs: 1 };

describe("tools", () => {
	process.env.JUNA_CUA_SETTLE_MS = "1";

	test("ui_act by label clicks the element token and reports the tree change", async () => {
		const { driver, inputs } = scripted([tree(false), tree(false), tree(true, [{ element_index: 4, role: "Edit", label: "Search for :" }])]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const el = await desktop.locate(await desktop.read("charmap"), "Advanced view", "click");
		expect(el.token).toBe("s1:2");
		expect(inputs).toEqual([]);
		const before = await desktop.read("charmap");
		expect(await desktop.perform(before, "click", el, {})).toBeUndefined();
		expect(inputs).toEqual([{ name: "click", args: { pid: 10, window_id: 1, element_token: "s1:2" } }]);
		const { lines } = await desktop.observe(before);
		expect(lines.join("\n")).toContain('+ e');
		expect(lines.join("\n")).toContain('CheckBox "Advanced view" (checked)');
	});

	test("a pasted row resolves by its leading ref, with no model call", async () => {
		const { driver } = scripted([tree(false)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const read = await desktop.read("charmap");
		const row = desktop.rows(read).find((r) => r.includes("Advanced view"))!;
		expect((await desktop.locate(read, row, "click")).token).toBe("s1:2");
	});

	test("look=true appends the whole resulting window to an action's reply", async () => {
		const { driver } = scripted([tree(false), tree(true)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const snap = desktop.snapshot(await desktop.read("charmap"));
		expect(snap[0]).toBe('charmap.exe "Character Map" (pid 10, window 1)');
		expect(snap.some((r) => r.includes('Button "Select"'))).toBe(true);
	});

	test("the title bar's System menu never shadows a real control with the same label", async () => {
		const settings = { snapshot_id: "s1", total_element_count: 4, elements: [
			{ element_index: 0, element_token: "s1:0", role: "TitleBar", label: "Settings" },
			{ element_index: 1, element_token: "s1:1", role: "MenuItem", label: "System", parent_index: 0, actions: ["expand"] },
			{ element_index: 2, element_token: "s1:2", role: "ListItem", label: "System", actions: ["select"] },
			{ element_index: 3, element_token: "s1:3", role: "ListItem", label: "Bluetooth & devices", actions: ["select"] },
		] };
		const { driver } = scripted([settings]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const read = await desktop.read("charmap");
		expect((await desktop.locate(read, "System", "click")).token).toBe("s1:2");
		expect((await desktop.locate(read, "System menu", "click").catch((e) => e.message))).toContain("TypeSafe key");
	});

	test("a UWP frame's System menu, hung off the window itself, is also never a label match", async () => {
		const uwp = { snapshot_id: "s1", total_element_count: 3, elements: [
			{ element_index: 0, element_token: "s1:0", role: "Window", label: "Settings" },
			{ element_index: 1, element_token: "s1:1", role: "MenuItem", label: "System", parent_index: 0, actions: ["expand"] },
			{ element_index: 2, element_token: "s1:2", role: "ListItem", label: "System", actions: ["select"] },
		] };
		const { driver } = scripted([uwp]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		expect((await desktop.locate(await desktop.read("charmap"), "System", "click")).token).toBe("s1:2");
	});

	test("an unresolved exact-label tie takes the selected one, and otherwise hands back", async () => {
		for (const selectSecond of [true, false]) {
			const twins = tree(false, [{ element_index: 4, element_token: "s1:4", role: "ListItem", label: "Select", selected: selectSecond, actions: ["select"] }]);
			const { driver } = scripted([twins]);
			const ask = async () => ({ answers: { target: { choice: "none", confidence: 0.4 } } });
			const desktop = new Desktop(driver as any, keyed, ask as any);
			const found = desktop.locate(await desktop.read("charmap"), "Select", "click");
			if (selectSecond) {
				expect((await found).token).toBe("s1:4");
				expect(desktop.note).toContain("took the selected one");
			} else await expect(found).rejects.toThrow(/not sure which control/);
		}
	});

	test("text input never resolves to a control that cannot take text", async () => {
		const { driver } = scripted([tree(false)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		await expect(desktop.locate(await desktop.read("charmap"), "Select", "type")).rejects.toThrow(/no control labelled/);
	});

	test("several exact matches go to Jev as the only candidates", async () => {
		const twins = tree(false, [{ element_index: 4, element_token: "s1:4", role: "Button", label: "Select", actions: ["invoke"] }]);
		const { driver } = scripted([twins]);
		let options: string[] = [];
		const ask = async (body: any) => { options = Object.keys(body.questions.target.criteria); return { answers: { target: { choice: options[1], confidence: 0.9 } } }; };
		const desktop = new Desktop(driver as any, keyed, ask as any);
		const el = await desktop.locate(await desktop.read("charmap"), "Select", "click");
		expect(options.length).toBe(3);
		expect(el.token).toBe("s1:4");
	});

	test("a label inside its clickable row never ties with the row", async () => {
		const about = { snapshot_id: "s1", total_element_count: 2, elements: [
			{ element_index: 0, element_token: "s1:0", role: "ListItem", label: "About", actions: ["select"] },
			{ element_index: 1, element_token: "s1:1", role: "Text", label: "About", parent_index: 0, actions: ["text"] },
		] };
		const { driver } = scripted([about]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		expect((await desktop.locate(await desktop.read("charmap"), "About", "click")).token).toBe("s1:0");
	});

	test("a description without a key refuses instead of guessing", async () => {
		const { driver } = scripted([tree(false)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		await expect(desktop.locate(await desktop.read("charmap"), "the box you type into", "set")).rejects.toThrow(/TypeSafe key/);
	});

	test("a low-confidence Jev pick lists the closest controls and does not act", async () => {
		const { driver, inputs } = scripted([tree(false)]);
		const ask = async () => ({ answers: { target: { choice: "e2", confidence: 0.3, probabilities: { e2: 0.4, e3: 0.35, none: 0.25 } } } });
		const desktop = new Desktop(driver as any, { apiKey: "k", model: "jev-latest", endpoint: "", timeoutMs: 1 }, ask as any);
		const read = await desktop.read("charmap");
		desktop.rows(read);
		await expect(desktop.locate(read, "that button", "click")).rejects.toThrow(/not sure which control[\s\S]*Retry with a ref/);
		expect(inputs).toEqual([]);
	});

	test("foreground input raises its window first, because it lands on whatever is on top", async () => {
		const { driver, inputs } = scripted([tree(false)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const read = await desktop.read("charmap");
		await desktop.perform(read, "click", read.elements[1], { foreground: true });
		expect(inputs.map((i) => i.name)).toEqual(["bring_to_front", "click"]);
		expect(inputs[1]!.args.delivery_mode).toBe("foreground");
	});

	test("a key combination becomes one hotkey call", async () => {
		const { driver, inputs } = scripted([tree(false)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		await desktop.perform(await desktop.read("charmap"), "key", undefined, { key: "Cmd+Shift+S" });
		expect(inputs[0]).toEqual({ name: "hotkey", args: { pid: 10, window_id: 1, keys: ["cmd", "shift", "s"] } });
	});

	test("a click with no target is refused before any input", async () => {
		const { driver, inputs } = scripted([tree(false)]);
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		await expect(desktop.perform(await desktop.read("charmap"), "click", undefined, {})).rejects.toThrow(/needs a target/);
		expect(inputs).toEqual([]);
	});

	test("the tools register with small schemas and the prompt block is stable", () => {
		const registered: any[] = [];
		const handlers = new Map<string, any>();
		cua({ registerTool: (t: any) => registered.push(t), on: (n: string, h: any) => handlers.set(n, h), getActiveTools: () => ["ui_look"] } as unknown as ExtensionAPI);
		expect(registered.map((t) => t.name)).toEqual(["ui_look", "ui_act", "ui_do"]);
		const schemaChars = registered.reduce((sum, t) => sum + JSON.stringify(t.parameters).length + t.description.length, 0);
		expect(schemaChars).toBeLessThan(4000);
		const once = handlers.get("before_agent_start")({ systemPrompt: "base" });
		expect(handlers.get("before_agent_start")({ systemPrompt: once.systemPrompt }).systemPrompt).toBe(once.systemPrompt);
	});
});

describe("ui_do", () => {
	test("each step is one request; the history carries what the step changed", async () => {
		const { driver, inputs } = scripted([tree(false), tree(true)]);
		const { ask, bodies } = jevScript([{ action: "click", pick: "Advanced view" }, { action: "done", done: 0.95 }]);
		const out = await new Desktop(driver as any, keyed, ask as any).achieve({ app: "charmap", goal: "turn advanced view on" });
		expect(out.split("\n")[0]).toStartWith("done");
		expect(inputs.map((i) => i.args.element_token)).toEqual(["s1:2"]);
		expect(bodies.length).toBe(2);
		expect(bodies[1].state.actions_taken_so_far).toContain('(unchecked) → ~');
		expect(bodies[1].state.actions_taken_so_far).toContain("(checked)");
	});

	test("choosing to stop is not success unless the done probability agrees", async () => {
		const { driver, inputs } = scripted([tree(false)]);
		const { ask } = jevScript([{ action: "done", done: 0.2 }]);
		const out = await new Desktop(driver as any, keyed, ask as any).achieve({ app: "charmap", goal: "turn advanced view off" });
		expect(out).toStartWith("ambiguous");
		expect(inputs).toEqual([]);
	});

	test("a hard-to-undo click stops for confirmation, and confirm=true lets it through", async () => {
		const withDelete = tree(false, [{ element_index: 4, element_token: "s1:4", role: "Button", label: "Delete all", actions: ["invoke"] }]);
		for (const confirm of [false, true]) {
			const { driver, inputs } = scripted([withDelete, withDelete]);
			const { ask } = jevScript([{ action: "click", pick: "Delete all" }, { action: "done", done: 0.95 }]);
			const out = await new Desktop(driver as any, keyed, ask as any).achieve({ app: "charmap", goal: "clear everything", confirm });
			expect(out).toStartWith(confirm ? "done" : "needs_confirmation");
			expect(inputs.length).toBe(confirm ? 1 : 0);
		}
	});

	test("a low-confidence step hands back instead of acting", async () => {
		const { driver, inputs } = scripted([tree(false)]);
		const { ask } = jevScript([{ action: "click", pick: "Select", confidence: 0.3 }]);
		expect(await new Desktop(driver as any, keyed, ask as any).achieve({ app: "charmap", goal: "x" })).toStartWith("ambiguous");
		expect(inputs).toEqual([]);
	});
});

describe("focus", () => {
	const rows = (els: object[]) => parseElements({ elements: els }).elements.map((el, i) => ({ ref: `e${i + 1}`, el, line: renderRow(`e${i + 1}`, el) }));

	test("a list row's cells fold into the row, and a cell equal to the row's label vanishes", () => {
		const folded = foldCells(rows([
			{ element_index: 0, role: "ListItem", label: "Fonts" },
			{ element_index: 1, role: "Edit", label: "Name", value: "Fonts", parent_index: 0 },
			{ element_index: 2, role: "Edit", label: "Type", value: "File folder", parent_index: 0 },
			{ element_index: 3, role: "Button", label: "Up", parent_index: 0 },
		]));
		expect(folded.map((r) => r.line)).toEqual(['e1 ListItem "Fonts" · Type: File folder', 'e4 Button "Up"']);
	});

	test("a Text row echoing the control above it is dropped", () => {
		const kept = dropMirrors(rows([
			{ element_index: 0, role: "ComboBox", label: "Font :", value: "Arial" },
			{ element_index: 1, role: "Text", label: "Font :", value: "Arial" },
			{ element_index: 2, role: "Text", label: "Other" },
		]));
		expect(kept.map((r) => r.el.label)).toEqual(["Font :", "Other"]);
	});

	test("only a confident 'not needed' hides a row; missing answers keep it", () => {
		const r = rows([{ element_index: 0, role: "Button", label: "a" }, { element_index: 1, role: "Button", label: "b" }, { element_index: 2, role: "Button", label: "c" }]);
		expect(decideFocus(r, { r0: { noul: 0.05 }, r1: { noul: 0.4 } }, 0.15)).toEqual([false, true, true]);
		expect(hiddenNote([r[0]!])).toContain("hid 1 controls");
	});

	test("the request carries the task in state and one row per question, with no other rows leaking in", () => {
		const r = rows([{ element_index: 0, role: "Button", label: "Save" }, { element_index: 1, role: "Button", label: "Cancel" }]);
		const body = focusRequest("jev-latest", "save the file", "Editor", r) as any;
		expect(body.state.task).toBe("save the file");
		expect(Object.keys(body.questions)).toEqual(["r0", "r1"]);
		expect(body.questions.r1.instructions.row).toBe('Button "Cancel"');
	});

	test("a big window is focused through Jev and a failed Jev call shows everything", async () => {
		const many = { snapshot_id: "s1", total_element_count: 60, elements: Array.from({ length: 60 }, (_, i) => ({ element_index: i, element_token: `s1:${i}`, role: "Button", label: `item ${i}` })) };
		for (const fail of [false, true]) {
			const { driver } = scripted([many]);
			const ask = async (body: any) => {
				if (fail) throw new Error("down");
				return { answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id, { noul: q.instructions.row === 'Button "item 7"' ? 0.9 : 0.01 }])) };
			};
			const desktop = new Desktop(driver as any, keyed, ask as any);
			const lines = await desktop.present(await desktop.read("charmap"));
			if (fail) expect(lines.length).toBe(61);
			else {
				expect(lines.filter((l) => l.startsWith("e")).length).toBe(1);
				expect(lines.at(-1)).toContain("hid 59 controls");
			}
		}
	});
});

describe("opening apps and foreground-only windows", () => {
	const reply = (data: object, text = "", isError = false) => ({ data, text, isError, images: [] });

	test("a window that takes no background input is retried in the foreground, once", async () => {
		const inputs: any[] = [];
		const driver = {
			async call(name: string, args: any = {}) {
				if (name === "list_windows") return reply({ windows: [{ window_id: 1, pid: 10, app_name: "chrome.exe", title: "Chrome", bounds: { width: 900, height: 700 } }] });
				if (name === "get_window_state") return reply(tree(false));
				inputs.push({ name, args });
				if (name === "hotkey" && args.delivery_mode !== "foreground")
					return reply({}, "Background delivery is not available for target window class 'Chrome_WidgetWin_1'", true);
				return reply({ route: "global_input" });
			},
			stop() {},
		};
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const start = await desktop.current("chrome");
		const result = await desktop.step("chrome", start, { do: "key", key: "ctrl+l" }, {});
		expect(inputs.map((i) => `${i.name}:${i.args.delivery_mode ?? "background"}`)).toEqual(["hotkey:background", "bring_to_front:background", "hotkey:foreground"]);
		expect(result.stopped).toBe(false);
		expect(result.lines.join("\n")).toContain("sent in the foreground");
	});

	test("an input the app ignored after delivery is NOT replayed in the foreground", () => {
		expect(needsForeground({ data: { escalation: { reason: "delivery_failed" } }, text: "", isError: false, images: [] })).toBe(false);
		expect(needsForeground({ data: { escalation: { reason: "background_unavailable" } }, text: "", isError: false, images: [] })).toBe(true);
	});

	test("open launches the app with the URL and names the window that appeared", async () => {
		const calls: any[] = [];
		let launched = false;
		const driver = {
			async call(name: string, args: any = {}) {
				calls.push({ name, args });
				if (name === "launch_app") { launched = true; return reply({ pid: 20 }); }
				if (name === "list_windows") return reply({ windows: launched
					? [{ window_id: 5, pid: 20, app_name: "chrome.exe", title: "New Tab - Google Chrome", bounds: { width: 1000, height: 800 } }] : [] });
				return reply({});
			},
			stop() {},
		};
		const desktop = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		const opened = await desktop.open("Google Chrome", "https://example.com", undefined);
		expect(calls.find((c) => c.name === "launch_app")!.args).toEqual({ name: "Google Chrome", additional_arguments: ["https://example.com"] });
		expect(opened.window?.window_id).toBe(5);
		expect(opened.lines.join("\n")).toContain('address it as app="New Tab - Google Chrome"');
		const viaDefault = new Desktop(driver as any, { apiKey: undefined, model: "jev-latest", endpoint: "", timeoutMs: 1 });
		calls.length = 0;
		await viaDefault.open("browser", "https://example.com", undefined);
		expect(calls.find((c) => c.name === "launch_app")!.args).toEqual({ urls: ["https://example.com"] });
	});

	test("the prompt says the desktop is another machine only when the driver is remote", () => {
		expect(cuaInstructions({})).toContain("this machine's");
		expect(cuaInstructions({ JUNA_CUA_COMMAND: '["ssh","box","cua-driver mcp"]' })).toContain("DIFFERENT machine");
		expect(cuaInstructions({})).toBe(cuaInstructions({}));
	});
});
