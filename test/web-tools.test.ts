import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/jev-search.ts";

async function exercise(question: string | undefined, verdict: "drop" | "uncertain" | "error" | "mixed", full = true) {
	const env = { ...process.env };
	const originalFetch = globalThis.fetch;
	const page = Array.from({length: 48}, (_, i) => `${i}: ${"reference content ".repeat(12)}`).join("\n");
	const calls: string[] = [];
	try {
		Object.assign(process.env, {EXA_API_KEY: "test-only", TYPESAFE_API_KEY: "test-only", JUNA_EXA_ENDPOINT: "https://exa.invalid/search", JUNA_ENDPOINT: "https://jev.invalid", JUNA_PRUNE_MIN_CHARS: "1"});
		globalThis.fetch = (async (url, init) => {
			calls.push(String(url));
			if (String(url).includes("exa.invalid")) return Response.json({results: [{title: "T", url: "https://doc.invalid", text: page}]});
			if (verdict === "error") return new Response("invalid", {status: 400});
			const body = JSON.parse(String(init?.body));
			expect(body.state.task).toContain(question);
			return Response.json({answers: Object.fromEntries(Object.keys(body.questions).map((id,index) => [id, {
				score: verdict === "mixed" && index === 0 ? 1 : 0,
				confidence: verdict === "uncertain" ? 0.7 : 1,
			}]))});
		}) as typeof fetch;
		const registered: ToolDefinition[] = [];
		extension({registerTool: (tool: ToolDefinition) => registered.push(tool)} as unknown as ExtensionAPI);
		const tool = registered.find(t => t.name === "web_fetch")!;
		const ctx = {ui: {setStatus() {}}} as unknown as Parameters<typeof tool.execute>[4];
		const result = await tool.execute("test", {url: "https://doc.invalid", ...(question ? {question} : {}), ...(full ? {full} : {})}, undefined, undefined, ctx);
		return {page, text: result.content.filter(p => p.type === "text").map(p => p.text).join(""), calls};
	} finally {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
		Object.assign(process.env, env);
	}
}

describe("web_fetch full=true", () => {
	test("no question returns full text without calling Jev", async () => {
		const {page,text,calls} = await exercise(undefined,"drop");
		expect(text).toEndWith(page);
		expect(calls).toEqual(["https://exa.invalid/contents"]);
	});
	for (const verdict of ["drop", "uncertain", "error"] as const) test(`${verdict} preserves full fetched text without another fetch`, async () => {
		const {page,text,calls} = await exercise("complete criteria formats and limits",verdict);
		expect(text).toEndWith(page);
		expect(calls.filter(x => x.includes("exa.invalid"))).toHaveLength(1);
	});
	test("keeps background while dropping confidently irrelevant chunks", async () => {
		const {page,text,calls} = await exercise("complete criteria formats and limits","mixed");
		expect(text).toContain(page.split("\n")[0]!);
		expect(text.length).toBeLessThan(page.length);
		expect(calls.filter(x => x.includes("exa.invalid"))).toHaveLength(1);
	});
});

async function highlights(params: Record<string, unknown>, reply: {highlights?: string[]; text?: string}, task?: string) {
	const env = { ...process.env };
	const originalFetch = globalThis.fetch;
	const bodies: Record<string, unknown>[] = [];
	try {
		Object.assign(process.env, {EXA_API_KEY: "test-only", JUNA_EXA_ENDPOINT: "https://exa.invalid/search"});
		globalThis.fetch = (async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			return Response.json({results: [{title: "T", url: "https://doc.invalid", ...(body.highlights ? {highlights: reply.highlights ?? []} : {text: reply.text ?? "whole page"})}]});
		}) as typeof fetch;
		const registered: ToolDefinition[] = [];
		const handlers = new Map<string, (event: {prompt: string}) => void>();
		extension({registerTool: (tool: ToolDefinition) => registered.push(tool), on: (name: string, handler: (event: {prompt: string}) => void) => handlers.set(name, handler)} as unknown as ExtensionAPI);
		if (task) handlers.get("before_agent_start")!({prompt: task});
		const tool = registered.find(t => t.name === "web_fetch")!;
		const ctx = {ui: {setStatus() {}}} as unknown as Parameters<typeof tool.execute>[4];
		const result = await tool.execute("test", {url: "https://doc.invalid", ...params}, undefined, undefined, ctx);
		return {text: result.content.filter(p => p.type === "text").map(p => p.text).join(""), bodies};
	} finally {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
		Object.assign(process.env, env);
	}
}

describe("web_fetch highlights", () => {
	const passage = "Relevant passage. ".repeat(20);
	test("a question becomes the highlights query and only the passages return", async () => {
		const {text, bodies} = await highlights({question: "what changed in 15.0.0"}, {highlights: [passage, passage]});
		expect(bodies).toHaveLength(1);
		expect(bodies[0]!.highlights).toEqual({query: "what changed in 15.0.0", dynamic: true});
		expect(text).toContain(passage);
		expect(text).toContain("[juna: excerpts that answer the question.]");
	});
	test("without a question the user's request is the query", async () => {
		const {bodies} = await highlights({}, {highlights: [passage]}, "summarize the upstream changelog");
		expect(bodies[0]!.highlights).toEqual({query: "summarize the upstream changelog", dynamic: true});
	});
	test("empty or tiny highlights fall back to the whole page", async () => {
		const {text, bodies} = await highlights({question: "anything"}, {highlights: ["tiny"], text: "the whole page"});
		expect(bodies.map(body => Boolean(body.highlights))).toEqual([true, false]);
		expect(text).toEndWith("the whole page");
	});
	test("full=true skips highlights", async () => {
		const {bodies} = await highlights({question: "anything", full: true}, {text: "the whole page"}, "task");
		expect(bodies.map(body => Boolean(body.highlights))).toEqual([false]);
	});
});
