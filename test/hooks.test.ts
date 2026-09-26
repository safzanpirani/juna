import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prune from "../extensions/jev-prune.ts";
import trim from "../extensions/jev-trim.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function harness(register: (pi: ExtensionAPI) => void) {
	const handlers = new Map<string, (...args: any[]) => any>();
	register({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	return handlers;
}
const ctx = { ui: { setStatus() {} }, getContextUsage: () => ({ percent: 10 }) };
const output = Array.from({ length: 40 }, (_, i) => `${i}: ${"x".repeat(100)}`).join("\n");
const event = (text = output, input = {}) => ({ toolName: "bash", input, content: [{ type: "text", text }], isError: false });

async function isolated(run: () => Promise<void>) {
	const env = { ...process.env };
	const fetchBefore = globalThis.fetch;
	const dir = mkdtempSync(join(tmpdir(), "juna-hook-test-"));
	try {
		for (const key of Object.keys(process.env)) if (key.startsWith("JUNA_")) delete process.env[key];
		Object.assign(process.env, { TMPDIR: dir, PI_CODING_AGENT_DIR: dir, TYPESAFE_API_KEY: "test-only", JUNA_PRUNE_MIN_CHARS: "1" });
		await run();
	} finally {
		globalThis.fetch = fetchBefore;
		for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
		Object.assign(process.env, env);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("only delivered bytes deduplicate; history changes reset memory", () => isolated(async () => {
	globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { chunk_0: { score: 0, confidence: 1 } } }))) as unknown as typeof fetch;
	const h = harness(prune);
	expect(h.has("context")).toBe(false);
	h.get("before_agent_start")!({ prompt: "task" });
	const first = await h.get("tool_result")!(event(), ctx);
	expect(first.content[0].text).toContain("juna pruned");
	h.get("message_end")!({ message: { role: "toolResult", toolName: "bash", isError: false, content: first.content } });
	const second = await h.get("tool_result")!(event(), ctx);
	expect(second.content[0].text).not.toContain("identical");
	h.get("message_end")!({ message: { role: "toolResult", toolName: "bash", isError: false, content: event().content } });
	expect((await h.get("tool_result")!(event(), ctx)).content[0].text).toContain("identical");
	h.get("session_compact")!();
	expect((await h.get("tool_result")!(event(), ctx)).content[0].text).not.toContain("identical");
}));

test("explicit range reads and mixed image output bypass every stage", () => isolated(async () => {
	globalThis.fetch = (async () => { throw new Error("must not call"); }) as unknown as typeof fetch;
	const h = harness(prune);
	h.get("before_agent_start")!({ prompt: "task" });
	expect(await h.get("tool_result")!({ ...event(), toolName: "read", input: { path: "a.ts", offset: 20 } }, ctx)).toBeUndefined();
	expect(await h.get("tool_result")!({ ...event(), content: [...event().content, { type: "image", data: "x", mimeType: "image/png" }] }, ctx)).toBeUndefined();
}));

test("Python selected output and recovery notices bypass pruning and dedup", () => isolated(async () => {
	globalThis.fetch = (async () => { throw new Error("must not call"); }) as unknown as typeof fetch;
	const h = harness(prune);
	const original = { ...event(), toolName: "python" };
	h.get("before_agent_start")!({ prompt: "task" });
	h.get("message_end")!({ message: { role: "toolResult", ...original } });
	expect(await h.get("tool_result")!(original, ctx)).toBeUndefined();
}));

test("Jev malformed JSON, all-drop and missing key preserve original after spill", () => isolated(async () => {
	Object.assign(process.env, { JUNA_PRUNE_MIN_LINES: "1", JUNA_SPILL_THRESHOLD: "1000", JUNA_SPILL_HEAD: "400", JUNA_SPILL_TAIL: "400" });
	const h = harness(prune);
	h.get("before_agent_start")!({ prompt: "task" });
	globalThis.fetch = (async () => new Response("not json")) as unknown as typeof fetch;
	expect(await h.get("tool_result")!(event(), ctx)).toBeUndefined();
	globalThis.fetch = (async () => new Response(JSON.stringify({ answers: {} }))) as unknown as typeof fetch;
	expect(await h.get("tool_result")!(event(), ctx)).toBeUndefined();
	process.env.TYPESAFE_API_KEY = "";
	const noKey = harness(prune);
	noKey.get("before_agent_start")!({ prompt: "task" });
	expect(await noKey.get("tool_result")!(event(), ctx)).toBeUndefined();
}));

test("all-drop without spill preserves output and does not mutate event", () => isolated(async () => {
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(init!.body as string);
		return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { score: 0, confidence: 1 }])) }));
	}) as unknown as typeof fetch;
	const h = harness(prune);
	h.get("before_agent_start")!({ prompt: "task" });
	const original = event();
	expect(await h.get("tool_result")!(original, ctx)).toBeUndefined();
	expect(original.content[0]!.text).toBe(output);
}));

test("system prompt stays byte-identical across changed input until a new session", () => {
	const h = harness(trim);
	expect(h.has("context")).toBe(false);
	const first = h.get("before_agent_start")!({ systemPrompt: "base\n<skills>\nold\n</skills>" }, ctx);
	const second = h.get("before_agent_start")!({ systemPrompt: "changed\n<skills>\nnew\n</skills>" }, ctx);
	expect(second.systemPrompt).toBe(first.systemPrompt);
	h.get("session_start")!();
	expect(h.get("before_agent_start")!({ systemPrompt: "new session" }, ctx).systemPrompt).toBe("new session");
});

test("post-spill scoring sees only the spilled body and preserves its recovery path", () => isolated(async () => {
	Object.assign(process.env, { JUNA_PRUNE_MIN_LINES: "1", JUNA_SPILL_THRESHOLD: "1000", JUNA_SPILL_HEAD: "400", JUNA_SPILL_TAIL: "400" });
	let asked = "";
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const request = JSON.parse(init!.body as string);
		asked = Object.values(request.questions).map((q: any) => q.instructions.excerpt).join("\n");
		return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { score: 2, confidence: 1 }])) }));
	}) as unknown as typeof fetch;
	const h = harness(prune);
	h.get("before_agent_start")!({ prompt: "task" });
	const result = await h.get("tool_result")!(event(), ctx);
	expect(asked).toContain("juna spilled");
	expect(asked).not.toContain("20: " + "x".repeat(100));
	expect(result.content[0].text).toContain("juna spilled");
	expect(result.content[0].text.length).toBeLessThan(output.length);
}));

test("single-chunk early return retains successful spill", () => isolated(async () => {
	Object.assign(process.env, { JUNA_SPILL_THRESHOLD: "1000", JUNA_SPILL_HEAD: "400", JUNA_SPILL_TAIL: "400" });
	let calls = 0;
	globalThis.fetch = (async () => { calls++; throw new Error("unexpected"); }) as unknown as typeof fetch;
	const h = harness(prune);
	h.get("before_agent_start")!({ prompt: "task" });
	expect((await h.get("tool_result")!(event(), ctx)).content[0].text).toContain("juna spilled");
	expect(calls).toBe(0);
}));

test("a bash command that exits non-zero is pruned, keeps its exit line, and gets a verdict", () => isolated(async () => {
	Object.assign(process.env, { JUNA_PRUNE_MIN_LINES: "1" });
	let bodies: string[] = [];
	globalThis.fetch = (async (_url: string, init: { body: string }) => {
		bodies.push(init.body);
		const questions = Object.keys((JSON.parse(init.body) as { questions: Record<string, unknown> }).questions);
		const answers: Record<string, unknown> = {};
		for (const id of questions) answers[id] = id === "chunk_0" ? { score: 0, confidence: 1 } : id.startsWith("chunk_") ? { score: 2, confidence: 1 } : id === "verify_outcome" ? { choice: "failed", confidence: 1 } : { score: 0, confidence: 1 };
		return new Response(JSON.stringify({ answers }));
	}) as unknown as typeof fetch;
	const h = harness(prune);
	h.get("before_agent_start")!({ prompt: "fix the failing tests" });
	const failing = { ...event(`${output}\n\nCommand exited with code 1`, { command: "npx jest" }), isError: true };
	const result = await h.get("tool_result")!(failing, ctx);
	expect(bodies.length).toBeGreaterThan(0);
	expect(result.content[0].text).toContain("juna pruned");
	expect(result.content[0].text.split("\n")[0]).toBe("[juna: FAILED]");
	expect(result.content[0].text.trimEnd().endsWith("Command exited with code 1")).toBe(true);
	expect(result.isError).toBeUndefined();

	bodies = [];
	const readError = { ...event(), toolName: "read", isError: true };
	expect(await h.get("tool_result")!(readError, ctx)).toBeUndefined();
	expect(bodies.length).toBe(0);
}));

test("exitStatus finds only the trailing exit line", async () => {
	const { exitStatus } = await import("../extensions/jev-prune.ts");
	expect(exitStatus("out\n\nCommand exited with code 2\n")).toBe("Command exited with code 2");
	expect(exitStatus("Command exited with code 2\nmore")).toBeUndefined();
});
