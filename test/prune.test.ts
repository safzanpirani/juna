import { describe, expect, test } from "bun:test";

import { splitChunks } from "../extensions/chunk.ts";
import { buildRequest, decide, floorFor, loadSettings, questionId, readPath } from "../extensions/jev-prune.ts";

const settings = loadSettings({} as NodeJS.ProcessEnv);
const config = { apiKey: "k", model: "jev-latest", endpoint: "https://example.invalid", timeoutMs: 1 };
const chunks = splitChunks(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"), {
	maxChunks: 3,
	minLines: 1,
	maxChars: 4000,
});

describe("buildRequest", () => {
	const request = buildRequest("find the failing test", "bash", "command=bun test", chunks, config, settings);

	test("puts the task in state and one question per chunk", () => {
		expect((request.state as Record<string, string>).task).toBe("find the failing test");
		expect(Object.keys(request.questions as object)).toHaveLength(chunks.length);
	});

	test("each question is a score over the relevance ladder", () => {
		const question = (request.questions as Record<string, any>)[questionId(0)];
		expect(question.type).toBe("score");
		expect(question.criteria).toHaveLength(3);
		expect(question.instructions.excerpt).toContain("line 1");
	});
});

describe("decide", () => {
	test("drops only confident low scores", () => {
		const kept = decide(chunks, {
			[questionId(0)]: { score: 0.1, confidence: 0.9 },
			[questionId(1)]: { score: 0.1, confidence: 0.2 },
			[questionId(2)]: { score: 1.8, confidence: 0.9 },
		}, settings);
		expect(kept).toEqual([false, true, true]);
	});

	test("keeps a chunk Jev did not answer", () => {
		expect(decide(chunks, {}, settings)).toEqual([true, true, true]);
	});

	test("keeps a chunk with an unusable score", () => {
		const kept = decide(chunks, { [questionId(0)]: { score: Number.NaN, confidence: 1 } }, settings);
		expect(kept[0]).toBe(true);
	});
});

describe("floorFor", () => {
	test("stays at the base floor while the window has room", () => {
		expect(floorFor(0, settings)).toBe(settings.minScore);
		expect(floorFor(50, settings)).toBe(settings.minScore);
	});

	test("rises towards maxScore as the window fills", () => {
		const half = floorFor(75, settings);
		expect(half).toBeGreaterThan(settings.minScore);
		expect(half).toBeLessThan(settings.maxScore);
		expect(floorFor(100, settings)).toBeCloseTo(settings.maxScore, 5);
	});

	test("is monotonic", () => {
		let previous = -1;
		for (let percent = 0; percent <= 100; percent += 5) {
			const floor = floorFor(percent, settings);
			expect(floor).toBeGreaterThanOrEqual(previous);
			previous = floor;
		}
	});

	test("falls back to the base floor when usage is unknown", () => {
		expect(floorFor(null, settings)).toBe(settings.minScore);
		expect(floorFor(undefined, settings)).toBe(settings.minScore);
		expect(floorFor(Number.NaN, settings)).toBe(settings.minScore);
	});

	test("a higher floor drops more chunks", () => {
		const answers = {
			[questionId(0)]: { score: 0.9, confidence: 0.9 },
			[questionId(1)]: { score: 1.5, confidence: 0.9 },
			[questionId(2)]: { score: 0.5, confidence: 0.9 },
		};
		expect(decide(chunks, answers, settings, 0.7)).toEqual([true, true, false]);
		expect(decide(chunks, answers, settings, 1.4)).toEqual([false, true, false]);
	});
});

describe("readPath", () => {
	test("finds the path of a read call, whatever the field is called", () => {
		expect(readPath("read", { path: "src/a.ts" })).toBe("src/a.ts");
		expect(readPath("read", { filePath: " src/b.ts " })).toBe("src/b.ts");
	});

	test("ignores other tools and missing paths", () => {
		expect(readPath("bash", { path: "src/a.ts" })).toBeUndefined();
		expect(readPath("read", {})).toBeUndefined();
		expect(readPath("read", { path: "  " })).toBeUndefined();
	});
});

test("missing, nonfinite and out-of-range confidence keep chunks", () => {
	for (const confidence of [undefined, NaN, Infinity, -1, 2]) {
		expect(decide(chunks, { chunk_0: { score: 0, confidence } }, settings)[0]).toBe(true);
	}
});

test("unseen middle cannot be dropped on a head-tail score", () => {
	const oversized = [{ index: 0, startLine: 1, endLine: 1, text: "x".repeat(settings.chunkLimit + 1) }];
	expect(decide(oversized, { chunk_0: { score: 0, confidence: 1 } }, settings)).toEqual([true]);
});

test("fractional positive integer settings cannot round down to zero", () => {
	expect(loadSettings({ JUNA_PRUNE_CHUNK_LIMIT: "0.5", JUNA_PRUNE_HARD_MAX_CHUNKS: "0.5" }).chunkLimit).toBe(1);
});
