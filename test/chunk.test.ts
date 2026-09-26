import { describe, expect, test } from "bun:test";

import { assemble, excerpt, splitBounded, splitChunks } from "../extensions/chunk.ts";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("splitChunks", () => {
	test("respects minLines so small output stays whole", () => {
		const chunks = splitChunks(lines(6), { maxChunks: 40, minLines: 8, maxChars: 4000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.startLine).toBe(1);
		expect(chunks[0]!.endLine).toBe(6);
	});

	test("never exceeds maxChunks", () => {
		const chunks = splitChunks(lines(1000), { maxChunks: 10, minLines: 1, maxChars: 4000 });
		expect(chunks.length).toBeLessThanOrEqual(10);
	});

	test("covers every line exactly once", () => {
		const chunks = splitChunks(lines(97), { maxChunks: 8, minLines: 2, maxChars: 4000 });
		expect(chunks.map((c) => c.text).join("\n")).toBe(lines(97));
		expect(chunks.at(-1)!.endLine).toBe(97);
	});
});

describe("assemble", () => {
	const chunks = splitChunks(lines(40), { maxChunks: 4, minLines: 10, maxChars: 4000 });

	test("keeping everything returns the original text", () => {
		const result = assemble(chunks, [true, true, true, true]);
		expect(result.text).toBe(lines(40));
		expect(result.droppedChunks).toBe(0);
	});

	test("collapses adjacent drops into one marker", () => {
		const result = assemble(chunks, [true, false, false, true]);
		expect(result.text.match(/juna pruned/g)).toHaveLength(1);
		expect(result.text).toContain("lines 11-30");
		expect(result.droppedLines).toBe(20);
		expect(result.keptLines).toBe(20);
	});

	test("an undecided chunk is kept", () => {
		const result = assemble(chunks, []);
		expect(result.text).toBe(lines(40));
	});
});

describe("character budget", () => {
	test("a long line forces its own chunk", () => {
		const text = ["short", "x".repeat(5000), "short"].join("\n");
		const chunks = splitChunks(text, { maxChunks: 1, minLines: 10, maxChars: 1000 });
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.map((c) => c.text).join("\n")).toBe(text);
	});

	test("every chunk fits the budget unless one line exceeds it alone", () => {
		const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(50)}`).join("\n");
		for (const chunk of splitChunks(text, { maxChunks: 4, minLines: 50, maxChars: 900 })) {
			expect(chunk.text.length).toBeLessThanOrEqual(900);
		}
	});
});

describe("splitBounded", () => {
	const huge = Array.from({ length: 50_000 }, (_, i) => `line ${i} ${"z".repeat(80)}`).join("\n");

	test("keeps a huge output under the hard cap", () => {
		const chunks = splitBounded(huge, { maxChunks: 40, minLines: 8, maxChars: 4000, hardMax: 240 });
		expect(chunks.length).toBeLessThanOrEqual(240);
		expect(chunks.at(-1)!.endLine).toBe(50_000);
	});

	test("leaves a small output exactly as splitChunks would", () => {
		const small = lines(40);
		const options = { maxChunks: 4, minLines: 10, maxChars: 4000 };
		expect(splitBounded(small, { ...options, hardMax: 240 })).toEqual(splitChunks(small, options));
	});
});

describe("excerpt", () => {
	test("passes short text through", () => {
		expect(excerpt("abc", 10)).toBe("abc");
	});

	test("keeps head and tail and names the gap", () => {
		const result = excerpt("A".repeat(50) + "B".repeat(50), 40);
		expect(result.startsWith("A".repeat(24))).toBe(true);
		expect(result.endsWith("B".repeat(16))).toBe(true);
		expect(result).toContain("60 characters omitted");
	});
});

test("adversarial long-line distribution cannot exceed the hard cap", () => {
	const text = Array.from({ length: 241 }, (_, i) => `${"x".repeat(i % 2 ? 1 : 10000)}\n`).join("");
	const chunks = splitBounded(text, { maxChunks: 40, minLines: 1, maxChars: 100, hardMax: 40 });
	expect(chunks.length).toBeLessThanOrEqual(40);
	expect(chunks.map((c) => c.text).join("\n")).toBe(text);
	expect(assemble(chunks, [false, true]).text).toContain(chunks.at(-1)!.text);
});

test("zero excerpt budget never copies the entire input as a tail", () => {
	expect(excerpt("private middle", 0)).not.toContain("private middle");
});
