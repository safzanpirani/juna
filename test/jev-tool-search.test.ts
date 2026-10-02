import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import jevToolSearch, { buildRequests, MIN_SCORE, pick } from "../extensions/jev-tool-search.ts";
import type { ScoreAnswer } from "../extensions/jev.ts";

const tool = (name: string, exposure: ToolInfo["exposure"] = "deferred") =>
	({ name, description: `${name} does a thing.\nMore detail.`, exposure, namespace: { name: "tracker" } }) as unknown as ToolInfo;

const ALL = [tool("bash", "direct"), tool("read", "direct"), tool("tool_search", "model-only"), tool("create_label"), tool("create_issue"), tool("add_comment"), tool("send_mail", "codemode")];

function harness(scores: Record<string, number>, loaded = ["create_label"]) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let active = ["bash", "read", "tool_search", ...loaded];
	const asked: Record<string, unknown>[] = [];
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		getActiveTools: () => active,
		getAllTools: () => ALL,
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI;
	jevToolSearch(pi, async (body) => {
		asked.push(body);
		const questions = body.questions as Record<string, { instructions: { tool_name: string } }>;
		const answers: Record<string, ScoreAnswer> = {};
		for (const [id, q] of Object.entries(questions)) answers[id] = { score: scores[q.instructions.tool_name] ?? 0, confidence: 0.9 };
		return { answers };
	});
	handlers.get("before_agent_start")!({ prompt: "Open an issue for the outage and comment on it" });
	const ctx = { signal: undefined, ui: { setStatus() {} } };
	const run = (event: Record<string, unknown> = {}) =>
		handlers.get("tool_result")!({ toolName: "tool_search", toolCallId: "1", input: { query: "tracker create_issue", limit: 1 }, content: [{ type: "text", text: "Loaded 1 tool." }], isError: false, details: { loaded }, ...event }, ctx);
	return { run, asked, active: () => active };
}

test("Jev's needed tools replace the BM25 picks, even past the model's limit", async () => {
	const h = harness({ create_issue: 2, add_comment: 1.6, create_label: 0.3 });
	const result = await h.run();
	expect(h.active()).toEqual(["bash", "read", "tool_search", "create_issue", "add_comment"]);
	expect(result.details).toEqual({ loaded: ["create_issue", "add_comment"], bm25: ["create_label"] });
	expect(result.content[0].text).toBe("Loaded 2 tools. They are available from your next call:\n- create_issue: create_issue does a thing.\n- add_comment: add_comment does a thing.");
});

test("only searchable tools that were not already declared are scored", async () => {
	const h = harness({});
	await h.run();
	const names = Object.values(h.asked[0]!.questions as Record<string, { instructions: { tool_name: string } }>).map((q) => q.instructions.tool_name);
	expect(names).toEqual(["create_label", "create_issue", "add_comment", "send_mail"]);
	expect(h.asked[0]!.state).toEqual({ query: "tracker create_issue", task: "Open an issue for the outage and comment on it" });
});

test("no needed tool, a nested call, or an error keeps the built-in result", async () => {
	const h = harness({ create_issue: MIN_SCORE - 0.1 });
	expect(await h.run()).toBeUndefined();
	expect(h.active()).toContain("create_label");
	expect(await h.run({ parentToolCallId: "script" })).toBeUndefined();
	expect(await h.run({ isError: true })).toBeUndefined();
	expect(h.asked).toHaveLength(1);
});

test("a failed Jev call fails open", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = { on: (n: string, f: any) => handlers.set(n, f), getActiveTools: () => ["create_label"], getAllTools: () => ALL, setActiveTools() { throw new Error("must not change"); } } as unknown as ExtensionAPI;
	jevToolSearch(pi, async () => { throw new Error("down"); });
	expect(await handlers.get("tool_result")!({ toolName: "tool_search", input: { query: "x" }, content: [], isError: false, details: { loaded: ["create_label"] } }, { ui: { setStatus() {} } })).toBeUndefined();
});

test("requests shard at 40 questions and pick caps at 8", () => {
	const many = Array.from({ length: 90 }, (_, i) => tool(`t${i}`));
	const requests = buildRequests("q", "task", many, { apiKey: "k", model: "jev-latest", endpoint: "", timeoutMs: 1 });
	expect(requests.map((r) => Object.keys(r.questions as object).length)).toEqual([40, 40, 10]);
	const answers = Object.fromEntries(many.map((_, i) => [`tool_${i}`, { score: 2, confidence: i / 100 }]));
	expect(pick(many, answers).map((t) => t.name)).toEqual(["t89", "t88", "t87", "t86", "t85", "t84", "t83", "t82"]);
});
