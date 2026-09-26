import { describe, expect, test } from "bun:test";

import {
	buildSearchBody,
	CONTENTS_ENDPOINT,
	contentsEndpoint,
	crawlFailure,
	EXA_ENDPOINT,
	fetchPage,
	loadExaConfig,
	renderResults,
	search,
	type ExaResult,
} from "../extensions/exa.ts";
import { preserveCode } from "../extensions/jev-search.ts";

const result = (title: string, url: string, highlights: string[] = ["a highlight"]): ExaResult => ({
	title,
	url,
	highlights,
});

describe("buildSearchBody", () => {
	test("asks for highlights rather than page text", () => {
		const body = buildSearchBody("how does x work", 8) as {
			numResults: number;
			contents: { highlights: { query: string; dynamic: boolean } };
			text?: unknown;
		};
		expect(body.numResults).toBe(8);
		expect(body.contents.highlights.dynamic).toBe(true);
		expect(body.contents.highlights.query).toBe("how does x work");
		expect(body.text).toBeUndefined();
	});
});

describe("loadExaConfig", () => {
	const read = () => JSON.stringify({ exaApiKey: "from-file" });

	test("prefers the environment over the file", () => {
		expect(loadExaConfig({ EXA_API_KEY: "from-env" } as NodeJS.ProcessEnv, read).apiKey).toBe("from-env");
		expect(loadExaConfig({} as NodeJS.ProcessEnv, read).apiKey).toBe("from-file");
	});

	test("a missing file is a valid state", () => {
		const config = loadExaConfig({} as NodeJS.ProcessEnv, () => {
			throw new Error("no such file");
		});
		expect(config.apiKey).toBeUndefined();
	});
});

describe("search", () => {
	const config = { apiKey: "k", endpoint: "https://example.invalid", timeoutMs: 1000 };

	test("refuses without a key instead of calling out", async () => {
		await expect(search("q", 4, { ...config, apiKey: undefined })).rejects.toThrow(/No Exa API key/);
	});

	test("reports a failed request rather than returning nothing", async () => {
		const failing = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
		await expect(search("q", 4, config, undefined, failing)).rejects.toThrow(/429/);
	});

	test("tolerates a response with no results", async () => {
		const empty = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
		expect(await search("q", 4, config, undefined, empty)).toEqual([]);
	});

	test("keeps the fields it needs and tidies the rest", async () => {
		const body = { results: [{ title: "T", url: "u", publishedDate: "2026-01-02T00:00:00Z", highlights: ["# H\ntext"] }] };
		const ok = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
		expect(await search("q", 4, config, undefined, ok)).toEqual([
			{ title: "T", url: "u", publishedDate: "2026-01-02T00:00:00Z", highlights: ["# H\ntext"] },
		]);
	});
});

describe("renderResults", () => {
	test("numbers the results and includes their evidence", () => {
		const out = renderResults([result("Title", "https://x", ["why it matched"])]);
		expect(out).toContain("1. Title");
		expect(out).toContain("https://x");
		expect(out).toContain("why it matched");
	});

	test("says so plainly when nothing survived", () => {
		expect(renderResults([])).toBe("No results worth keeping.");
	});
});

describe("contentsEndpoint", () => {
	test("uses Exa's contents endpoint by default", () => {
		expect(contentsEndpoint({ apiKey: "k", endpoint: EXA_ENDPOINT, timeoutMs: 1 })).toBe(CONTENTS_ENDPOINT);
	});

	test("an overridden search endpoint carries over to fetching", () => {
		expect(contentsEndpoint({ apiKey: "k", endpoint: "https://proxy.invalid/search", timeoutMs: 1 })).toBe(
			"https://proxy.invalid/contents",
		);
	});
});

describe("crawlFailure", () => {
	test("reports the tag and the status Exa gave", () => {
		expect(crawlFailure([{ error: { httpStatusCode: 404, tag: "CRAWL_NOT_FOUND" } }])).toBe(
			"CRAWL_NOT_FOUND (HTTP 404)",
		);
	});

	test("says something useful when Exa said nothing", () => {
		expect(crawlFailure(undefined)).toBe("no readable text came back");
		expect(crawlFailure([{}])).toBe("no readable text came back");
	});
});

describe("fetchPage", () => {
	const config = { apiKey: "k", endpoint: EXA_ENDPOINT, timeoutMs: 1000 };

	test("refuses without a key", async () => {
		await expect(fetchPage("https://x", 100, { ...config, apiKey: undefined })).rejects.toThrow(/No Exa API key/);
	});

	test("explains a page that could not be crawled", async () => {
		const body = { results: [], statuses: [{ error: { httpStatusCode: 403, tag: "CRAWL_FORBIDDEN" } }] };
		const refused = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
		await expect(fetchPage("https://x", 100, config, undefined, refused)).rejects.toThrow(/CRAWL_FORBIDDEN/);
	});

	test("returns the title, url and text", async () => {
		const body = { results: [{ title: "T", url: "https://x", text: "the page" }] };
		const ok = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
		expect(await fetchPage("https://x", 100, config, undefined, ok)).toEqual({
			title: "T",
			url: "https://x",
			text: "the page",
		});
	});

	test("asks for text with a character cap", async () => {
		let sent: Record<string, unknown> = {};
		const spy = (async (_url: string, init: RequestInit) => {
			sent = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ results: [{ text: "x", url: "u" }] }), { status: 200 });
		}) as unknown as typeof fetch;
		await fetchPage("https://x", 1234, config, undefined, spy);
		expect(sent).toEqual({ urls: ["https://x"], text: { maxCharacters: 1234 } });
	});
});


describe("first-response evidence", () => {
	test("preserves facts beyond the former 400 character cut and code formatting", () => {
		const evidence = "context ".repeat(180) + "\n```python\nif ready:\n    run()\n```\nRequired: confidence is not score.";
		expect(renderResults([result("T", "u", [evidence])])).toContain(evidence);
	});

	test("sends the dynamic beta header and the entire information need in one request", async () => {
		let calls = 0;
		const query = "context ".repeat(200) + "include schemas and edge cases";
		const spy = (async (_url: unknown, init: RequestInit) => {
			calls++;
			expect(new Headers(init.headers).get("Exa-Beta")).toBe("dynamic-highlights-2026-08-28");
			expect(JSON.parse(String(init.body))).toEqual({query, numResults: 4, contents: {highlights: {query, dynamic: true}}});
			return new Response(JSON.stringify({results: []}));
		}) as typeof fetch;
		await search(query, 4, {apiKey: "k", endpoint: EXA_ENDPOINT, timeoutMs: 1000}, undefined, spy);
		expect(calls).toBe(1);
	});

	test("protects every chunk in a fenced example, including an unclosed fence", () => {
		const chunks = ["boilerplate", "```python\nif ready:", "    run()", "```", "navigation", "~~~json", '{"value": 1}']
			.map((text,index) => ({text,index,startLine:index+1,endLine:index+1}));
		expect(preserveCode(chunks, chunks.map(() => false))).toEqual([false,true,true,true,false,true,true]);
	});
});
