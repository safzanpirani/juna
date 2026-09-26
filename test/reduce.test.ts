import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import prune, { reduceBash } from "../extensions/jev-prune.ts";
import { collapseRedraws, htmlToText, looksLikeHtml, reduceBashOutput, reduceTestOutput, stripAnsi } from "../extensions/reduce.ts";

const failure = (suite: string, n: number) => `  ● ${suite} › case ${n}\n\n    expect(received).toBe(expected)\n\n    Expected: "a"\n    Received: "b"\n\n      at Object.<anonymous> (tests/${suite}.test.js:${n}:1)\n`;
const jest = (suites: Record<string, number>) => {
	const parts: string[] = ["PASS tests/ok.test.js", "PASS tests/fine.test.js"];
	for (const [suite, count] of Object.entries(suites)) {
		parts.push(`FAIL tests/${suite}.test.js`);
		for (let i = 1; i <= count; i++) parts.push(failure(suite, i));
	}
	const blocks = parts.filter((p) => p.startsWith("  ●")).join("\n");
	parts.push(`\nSummary of all failing tests\n${blocks}\n`);
	parts.push("Test Suites: 2 failed, 2 passed, 4 total\nTests:       7 failed, 20 passed, 27 total\nTime:        1.2 s");
	return parts.join("\n");
};

describe("stripAnsi and collapseRedraws", () => {
	test("colour and cursor codes go, text stays", () => {
		expect(stripAnsi("\x1b[31mFAIL\x1b[39m \x1b[1mx\x1b[22m\x1b[2K")).toBe("FAIL x");
		expect(stripAnsi("plain")).toBe("plain");
	});
	test("a redrawn line keeps its final state; CRLF endings survive", () => {
		expect(collapseRedraws("10%\r50%\r100% done\nnext")).toBe("100% done\nnext");
		expect(collapseRedraws("one\r\ntwo\r\n")).toBe("one\ntwo\n");
	});
});

describe("reduceTestOutput", () => {
	test("drops passes and the repeated summary; first failures and each file's first stay whole", () => {
		const input = jest({ alpha: 5, beta: 2 });
		const { text, folded } = reduceTestOutput(input);
		expect(text).not.toContain("PASS tests/ok");
		expect(text).not.toContain("Summary of all failing tests");
		expect(text.match(/Received: "b"/g)?.length).toBe(4); // alpha 1-3 and beta 1
		expect(folded).toBe(3);
		for (const title of ["alpha › case 5", "beta › case 2"]) expect(text).toContain(title);
		expect(text).toContain("Tests:       7 failed");
		expect(text).toContain("[juna: 3 failures shown by title only.");
	});
	test("non-test output is untouched", () => {
		const text = "line one\nline two\n";
		expect(reduceTestOutput(text)).toEqual({ text, folded: 0 });
	});
	test("passing lines from other runners go when there are many", () => {
		const input = [...Array.from({ length: 8 }, (_, i) => `  ✓ works ${i} (2 ms)`), "  ✗ breaks", "8 pass, 1 fail"].join("\n");
		const { text } = reduceTestOutput(input);
		expect(text).not.toContain("✓");
		expect(text).toContain("✗ breaks");
	});
});

describe("HTML", () => {
	const page = `<!doctype html><html><head><style>.a{color:red}</style><script>var x=1</script></head><body><h1>Pricing</h1><p>Jev costs &#36;42 per billion&nbsp;tokens.</p>${"<div class=\"x\"></div>".repeat(200)}</body></html>`;
	test("detected, converted to text, scripts and styles gone", () => {
		expect(looksLikeHtml(page)).toBe(true);
		const text = htmlToText(page);
		expect(text).toContain("Pricing");
		expect(text).toContain("Jev costs $42 per billion tokens.");
		expect(text).not.toContain("color:red");
		expect(text).not.toContain("var x");
	});
	test("code that mentions a tag is not HTML", () => {
		expect(looksLikeHtml("const el = <div>hi</div>;\nreturn el;")).toBe(false);
	});
	test("reduceBashOutput reports what it applied", () => {
		const result = reduceBashOutput(`\x1b[32m${page}\x1b[0m`);
		expect(result.applied).toEqual(["ansi", "html"]);
		expect(result.text).toContain("HTML converted to text");
	});
});

describe("reduceBash with Pi's truncated output", () => {
	test("reduces the complete log instead of the tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "juna-reduce-"));
		const path = join(dir, "full.log");
		writeFileSync(path, jest({ first: 2, second: 1 }));
		const tail = "…only the end of the run…\nTests: 3 failed";
		const result = reduceBash(tail, { input: { command: "npx jest" }, details: { truncation: { truncated: true }, fullOutputPath: path } } as never);
		expect(result.text).toContain("first › case 1");
		expect(result.text).toContain(`complete output at ${path}`);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("hook", () => {
	const harness = () => {
		const handlers = new Map<string, (...args: any[]) => any>();
		prune({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
		return handlers;
	};
	const ctx = { ui: { setStatus() {} }, getContextUsage: () => ({ percent: 10 }) };
	test("a short coloured bash result is cleaned without any Jev call", async () => {
		const before = globalThis.fetch;
		globalThis.fetch = (async () => { throw new Error("must not call"); }) as unknown as typeof fetch;
		try {
			const h = harness();
			h.get("before_agent_start")!({ prompt: "task" });
			const result = await h.get("tool_result")!({ toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "\x1b[34mdir\x1b[0m file" }], isError: false }, ctx);
			expect(result.content[0].text).toBe("dir file");
			expect(await h.get("tool_result")!({ toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "\x1b[34mx\x1b[0m" }], isError: false }, ctx)).toBeUndefined();
		} finally {
			globalThis.fetch = before;
		}
	});
	test("a failing run keeps its exit line after reduction", async () => {
		const h = harness();
		const result = await h.get("tool_result")!({ toolName: "bash", input: { command: "npx jest" }, content: [{ type: "text", text: `\x1b[31mFAIL\x1b[0m x\n\nCommand exited with code 1` }], isError: true }, ctx);
		expect(result.content[0].text.trimEnd().endsWith("Command exited with code 1")).toBe(true);
		expect(result.content[0].text).not.toContain("\x1b");
	});
});
