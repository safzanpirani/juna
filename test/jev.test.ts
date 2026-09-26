import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJev, loadConfig, logUsage } from "../extensions/jev.ts";
const config = { apiKey: "test-secret", endpoint: "https://example.invalid", model: "test", timeoutMs: 10 };

test("config precedence is env, juna, then skill picker", () => {
	const read = (path: string) => JSON.stringify(path.endsWith("juna.json") ? { apiKey: "juna", model: "juna" } : { apiKey: "skill", timeoutMs: 99 });
	expect(loadConfig({ PI_CODING_AGENT_DIR: "/fake", TYPESAFE_API_KEY: "env" }, read).apiKey).toBe("env");
	expect(loadConfig({ PI_CODING_AGENT_DIR: "/fake" }, read)).toMatchObject({ apiKey: "juna", timeoutMs: 99 });
});

test("server and transport errors cannot echo credentials", async () => {
	for (const fetcher of [async () => new Response(config.apiKey, { status: 401 }), async () => { throw new Error(config.apiKey); }]) {
		try {
			await askJev({}, config, undefined, fetcher as unknown as typeof fetch);
			throw new Error("expected failure");
		} catch (error) {
			expect(String(error)).not.toContain(config.apiKey);
		}
	}
});

test("retryable HTTP status retries once but transport failure does not replay", async () => {
	let calls = 0;
	await askJev({}, config, undefined, (async () => ++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("{}")) as unknown as typeof fetch);
	expect(calls).toBe(2);
	calls = 0;
	await expect(askJev({}, config, undefined, (async () => { calls++; throw new Error("network"); }) as unknown as typeof fetch)).rejects.toThrow();
	expect(calls).toBe(1);
});

test("abort signal includes timeout and caller cancellation", async () => {
	const fetcher = (async (_url: unknown, init: RequestInit) => {
		const signal = init.signal!;
		if (signal.aborted) throw new Error("abort");
		await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
		return new Response("{}");
	}) as unknown as typeof fetch;
	await expect(askJev({}, config, undefined, fetcher)).rejects.toThrow("timed out");
	await expect(askJev({}, config, AbortSignal.abort(), fetcher)).rejects.toThrow("Cancelled");
});

describe("logUsage", () => {
	test("appends one line per request with questions and billed input tokens", () => {
		const dir = mkdtempSync(join(tmpdir(), "juna-jev-log-"));
		const path = join(dir, "jev.jsonl");
		logUsage({ questions: { a: {}, b: {} } }, { usage: { input_tokens: 312 } }, { JUNA_JEV_LOG: path });
		logUsage({ questions: { c: {} } }, {}, { JUNA_JEV_LOG: path });
		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(lines.map((line) => [line.questions, line.inputTokens])).toEqual([[2, 312], [1, null]]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("does nothing without JUNA_JEV_LOG and never throws on a bad path", () => {
		expect(() => logUsage({}, {}, {})).not.toThrow();
		expect(() => logUsage({}, {}, { JUNA_JEV_LOG: "/nonexistent/dir/jev.jsonl" })).not.toThrow();
	});
});
