import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/jev-search.ts";

async function exercise(question: string | undefined, verdict: "drop" | "uncertain" | "error" | "mixed") {
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
		const result = await tool.execute("test", {url: "https://doc.invalid", ...(question ? {question} : {})}, undefined, undefined, ctx);
		return {page, text: result.content.filter(p => p.type === "text").map(p => p.text).join(""), calls};
	} finally {
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
		Object.assign(process.env, env);
	}
}

describe("web_fetch first response", () => {
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
