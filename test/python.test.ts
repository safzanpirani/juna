import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/python/index.ts";
import trim from "../extensions/jev-trim.ts";
import { createBridge, receiptSummary, type Receipt } from "../extensions/python/bridge.ts";
import { PythonRuntime, type Bridge } from "../extensions/python/runtime.ts";
import { hasDill } from "./dill.ts";

const kernels: PythonRuntime[] = [];
const dirs: string[] = [];
const noBridge: Bridge = async () => { throw new Error("Unexpected bridge call"); };
function kernel(executable?: string) { const r = new PythonRuntime(executable); kernels.push(r); return r; }
async function workspace() { const dir = await mkdtemp(join(tmpdir(), "juna-python-test-")); dirs.push(dir); return dir; }
function context(cwd: string) { return { cwd, ui: { setStatus() {} } } as unknown as ExtensionContext; }
afterEach(async () => {
	for (const r of kernels.splice(0)) r.reset("test cleanup");
	await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("persistent Python cells", () => {
	test("retains imports, objects, functions and a live event loop across calls", async () => {
		const r = kernel();
		const first = await r.run("import asyncio\nrows = [1, 2, 3]\ndef total(): return sum(rows)\nqueue = asyncio.Queue()\nawait queue.put(40)\nprint(total())", tmpdir(), noBridge);
		expect(first.text).toContain("6");
		const second = await r.run("rows.append(await queue.get())\nprint(total())", tmpdir(), noBridge);
		expect(second.text).toBe("46\n");
		expect(second.generation).toBe(first.generation);
	});
	test("errors preserve prior and partial state without replaying a cell", async () => {
		const r = kernel();
		await r.run("values = []", tmpdir(), noBridge);
		await expect(r.run("values.append(7)\nraise ValueError('example')", tmpdir(), noBridge)).rejects.toThrow("ValueError: example");
		expect((await r.run("print(values)", tmpdir(), noBridge)).text).toBe("[7]\n");
		await expect(r.run("def broken(", tmpdir(), noBridge)).rejects.toThrow("SyntaxError");
		expect((await r.run("print(values)", tmpdir(), noBridge)).text).toBe("[7]\n");
	});
	test("reset, cwd changes and process exit invalidate the namespace", async () => {
		const r = kernel();
		await r.run("old = 1", tmpdir(), noBridge);
		r.reset();
		expect((await r.run("print('old' in globals())", tmpdir(), noBridge)).text).toContain("False");
		await r.run("old = 2", tmpdir(), noBridge);
		const changed = await r.run("print('old' in globals())", await workspace(), noBridge);
		expect(changed.text).toContain("working directory changed");
		expect(changed.text).toContain("False");
		await expect(r.run("import os\nos._exit(9)", tmpdir(), noBridge)).rejects.toThrow("Python process exited");
		expect((await r.run("print('old' in globals())", tmpdir(), noBridge)).text).toContain("False");
	});
	test("timeouts stop CPU-bound cells and report lost state", async () => {
		const r = kernel();
		await r.run("old = 1", tmpdir(), noBridge);
		await expect(r.run("while True: pass", tmpdir(), noBridge, undefined, 100)).rejects.toThrow("timed out");
		const after = await r.run("print('old' in globals())", tmpdir(), noBridge);
		expect(after.text).toContain("False");
		expect(after.text).toContain("state cleared");
	});
	test("cancellation reaches nested calls and late results cannot cross cells", async () => {
		const r = kernel();
		const controller = new AbortController();
		let started!: () => void;
		const ready = new Promise<void>(resolve => { started = resolve; });
		let aborted = false;
		const call = r.run("data = await tools.web_fetch('https://example.invalid')", tmpdir(), async (_n, _a, signal) => {
			started();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
			return "stale";
		}, controller.signal);
		const observed = call.catch(error => error as Error);
		await ready;
		controller.abort();
		expect(await observed).toBeInstanceOf(Error);
		expect(String(await observed)).toContain("cell cancelled");
		expect(aborted).toBe(true);
		expect((await r.run("print('data' in globals())", tmpdir(), noBridge)).text).toContain("False");
	});
	test("pre-aborted calls preserve state and overlapping calls fail explicitly", async () => {
		const r = kernel();
		await r.run("value = 8", tmpdir(), noBridge);
		await expect(r.run("value = 9", tmpdir(), noBridge, AbortSignal.abort())).rejects.toThrow("state unchanged");
		const running = r.run("import asyncio\nawait asyncio.sleep(0.1)\nprint(value)", tmpdir(), noBridge);
		await expect(r.run("value = 10", tmpdir(), noBridge)).rejects.toThrow("busy");
		expect((await running).text).toContain("8");
	});
	test("parallel host calls correlate out-of-order responses", async () => {
		const r = kernel();
		const seen: number[] = [];
		const result = await r.run("import asyncio\nvalues = await asyncio.gather(*(tools.call('echo', n=n) for n in range(6)))\nprint(values)", tmpdir(), async (_n, args) => {
			const n = args.n as number;
			await new Promise(resolve => setTimeout(resolve, (6 - n) * 10));
			seen.push(n);
			return String(n);
		});
		expect(result.text).toContain("['0', '1', '2', '3', '4', '5']");
		expect(seen).toEqual([5, 4, 3, 2, 1, 0]);
	});
	test("unawaited background work is cancelled and surfaced", async () => {
		const r = kernel();
		await expect(r.run("import asyncio\nasync def later():\n    await asyncio.sleep(1)\n    globals()['escaped'] = True\ntask = asyncio.create_task(later())", tmpdir(), noBridge)).rejects.toThrow("Unawaited background tasks");
		expect((await r.run("print('escaped' in globals())", tmpdir(), noBridge)).text).toBe("False\n");
	});
	test("large printed output has a bounded preview and complete protected recovery file", async () => {
		const r = kernel();
		const result = await r.run("print('abc' * 20000)", tmpdir(), noBridge);
		expect(result.outputPath).toBeDefined();
		dirs.push(dirname(result.outputPath!));
		expect(result.text.length).toBeLessThan(12500);
		expect(await readFile(result.outputPath!, "utf8")).toBe("abc".repeat(20000) + "\n");
	});
	test("missing Python is actionable and does not hang", async () => {
		await expect(kernel("/nonexistent/juna-python").run("print(1)", tmpdir(), noBridge)).rejects.toThrow("JUNA_PYTHON");
	});
	test("native stdout and stderr drain before the cell completes", async () => {
		const r = kernel();
		for (let i = 0; i < 30; i++) {
			const result = await r.run(`import os\nos.write(1, b'out-${i}\\n')\nos.write(2, b'err-${i}\\n')`, tmpdir(), noBridge);
			expect(result.text).toContain(`out-${i}\n`);
			expect(result.text).toContain(`err-${i}\n`);
		}
	});
});

describe("Python tool bridge", () => {
	test("writes, exact edits, reads and caught shell failures produce receipts", async () => {
		const dir = await workspace();
		const receipts: Receipt[] = [];
		const bridge = createBridge(context(dir), receipts);
		const result = await kernel().run("await tools.write('nested/example.txt', 'before')\nawait tools.edit('nested/example.txt', 'before', 'after')\nprint(await tools.read('nested/example.txt'))\ntry:\n    await tools.bash('exit 7')\nexcept RuntimeError:\n    print('expected failure')", dir, bridge);
		expect(await readFile(join(dir, "nested/example.txt"), "utf8")).toBe("after");
		expect(result.text).toContain("after");
		expect(result.text).toContain("expected failure");
		expect(receipts.map(r => r.status)).toEqual(["completed", "completed", "completed", "failed"]);
		expect(receipts[1]!.diff).toContain("after");
		expect(receiptSummary(receipts)).toContain("bash failed");
	});
	test("invalid arguments and overrides fail before mutation", async () => {
		const dir = await workspace();
		const ctx = context(dir);
		const receipts: Receipt[] = [];
		await expect(createBridge(ctx, receipts)("write", { path: "x" }, new AbortController().signal)).rejects.toThrow("Invalid arguments");
		await expect(createBridge(ctx, receipts, new Set(["write"]))("write", { path: "x", content: "x" }, new AbortController().signal)).rejects.toThrow("overridden");
		expect(receipts).toHaveLength(0);
	});
	test("stored full local data can be inspected without another read", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "data.json"), JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, value: i % 7 }))));
		const r = kernel();
		const first = await r.run("import json\nfrom pathlib import Path\nrows = json.loads(Path('data.json').read_text())\nprint(len(rows))", dir, noBridge);
		expect(first.text).toContain("20000");
		await rm(join(dir, "data.json"));
		const second = await r.run("print(sum(row['value'] for row in rows))", dir, noBridge);
		expect(second.text).toBe("59997\n");
	});
	test("web text stays in Python for follow-up inspection without another fetch", async () => {
		const previousFetch = globalThis.fetch;
		const previousKey = process.env.EXA_API_KEY;
		let requests = 0;
		try {
			process.env.EXA_API_KEY = "test-only";
			globalThis.fetch = (async () => {
				requests++;
				return Response.json({ results: [{ title: "Reference", url: "https://example.invalid", text: "section\n".repeat(2000) + "END-OF-DOCUMENT" }] });
			}) as unknown as typeof fetch;
			const r = kernel();
			const receipts: Receipt[] = [];
			const bridge = createBridge(context(tmpdir()), receipts);
			const first = await r.run("page = await tools.web_fetch('https://example.invalid')\nprint(len(page))", tmpdir(), bridge);
			expect(first.text.length).toBeLessThan(100);
			const second = await r.run("print(page[-15:])", tmpdir(), bridge);
			expect(second.text).toContain("END-OF-DOCUMENT");
			expect(requests).toBe(1);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousKey === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = previousKey;
		}
	});
});

describe("CodeMode opt-in and lifecycle", () => {
	(hasDill ? test : test.skip)("prompt instructions are stable and state survives tree navigation and resume", async () => {
		const hooks = new Map<string, Function[]>();
		let python!: ToolDefinition<any, any>;
		const api = {
			on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
			registerTool(tool: ToolDefinition<any, any>) { python = tool; },
			registerCommand() {}, getAllTools: () => [], getActiveTools: () => ["python"], sendMessage() {},
		} as unknown as ExtensionAPI;
		const profile = await workspace();
		const oldProfile = process.env.JUNA_DIR;
		const ctx = { cwd: tmpdir(), sessionManager: { getSessionFile: () => join(profile, "session.jsonl") }, ui: { setStatus() {} } } as unknown as ExtensionContext;
		trim(api);
		extension(api);
		process.env.JUNA_DIR = profile;
		const prompt = async () => {
			let systemPrompt = "base\n<skills>\nlarge catalogue\n</skills>";
			for (const fn of hooks.get("before_agent_start") ?? []) systemPrompt = (await fn({ systemPrompt }, ctx))?.systemPrompt ?? systemPrompt;
			return systemPrompt;
		};
		try {
			for (const fn of hooks.get("session_start") ?? []) await fn({}, ctx);
			const first = await prompt();
			expect(first).not.toContain("large catalogue");
			expect(first.match(/<juna_python>/g)).toHaveLength(1);
			expect(python.executionMode).toBe("sequential");
			await python.execute("1", { code: "saved = 41" }, undefined, undefined, ctx);
			expect(await prompt()).toBe(first);
			const second = await python.execute("2", { code: "print(saved + 1)" }, undefined, undefined, ctx);
			expect(second.content).toEqual([{ type: "text", text: "42\n" }]);
			for (const fn of hooks.get("session_tree") ?? []) await fn({}, ctx);
			const third = await python.execute("3", { code: "print('saved' in globals())" }, undefined, undefined, ctx);
			expect(JSON.stringify(third.content)).toContain("True");
			for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
			for (const fn of hooks.get("session_start") ?? []) await fn({ reason: "resume" }, ctx);
			const resumed = await python.execute("4", { code: "print(saved)" }, undefined, undefined, ctx);
			expect(JSON.stringify(resumed.content)).toContain("41");
			expect(await prompt()).toBe(first);
		} finally {
			for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
			if (oldProfile === undefined) delete process.env.JUNA_DIR;
			else process.env.JUNA_DIR = oldProfile;
		}
	});
	test("launcher loads CodeMode only on opt-in and preserves argv", async () => {
		const dir = await workspace();
		await mkdir(join(dir, "bin"));
		await mkdir(join(dir, "profile"));
		await writeFile(join(dir, "profile/settings.json"), "{}");
		await writeFile(join(dir, "profile/AGENTS.md"), "");
		await writeFile(join(dir, "bin/pi"), '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n');
		await chmod(join(dir, "bin/pi"), 0o700);
		const run = async (args: string[], toggle = "0") => {
			const proc = Bun.spawn(["/bin/bash", join(import.meta.dir, "../bin/juna"), ...args], {
				cwd: dir, env: { ...process.env, JUNA_DIR: join(dir, "profile"), PI_MAIN_AGENT_DIR: join(dir, "empty"), JUNA_CODEMODE: toggle, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
			});
			const out = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			return JSON.parse(out) as string[];
		};
		expect(await run([])).toEqual([]);
		expect(await run(["--no-codemode", "prompt with spaces"], "1")).toEqual(["prompt with spaces"]);
		const on = await run(["--codemode", "-p", "prompt with spaces"]);
		expect(on.slice(0, 2)).toEqual(["-e", join(import.meta.dir, "../extensions/python/index.ts")]);
		expect(on.slice(2)).toEqual(["-p", "prompt with spaces"]);
		expect(await run(["--", "--codemode"])).toEqual(["--", "--codemode"]);
	});
});
