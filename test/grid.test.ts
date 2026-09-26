import { describe, expect, test } from "bun:test";

import { CELL_FREE, estimateTokens, planCells, renderGrid, thousands } from "../extensions/grid.ts";
import { slicesOf } from "../extensions/jev-ctx.ts";

const options = { columns: 10, rows: 10, contextWindow: 1000 };

describe("planCells", () => {
	test("fills the rest with free cells", () => {
		const cells = planCells([{ label: "a", tokens: 100, glyph: "#", color: "accent" }], options);
		expect(cells).toHaveLength(100);
		expect(cells.filter((cell) => cell.glyph === "#")).toHaveLength(10);
		expect(cells.filter((cell) => cell.glyph === CELL_FREE)).toHaveLength(90);
	});

	test("a slice too small to round to a cell still shows one", () => {
		const cells = planCells([{ label: "tiny", tokens: 1, glyph: "#", color: "accent" }], options);
		expect(cells.filter((cell) => cell.glyph === "#")).toHaveLength(1);
	});

	test("an empty slice takes no cell at all", () => {
		expect(planCells([{ label: "none", tokens: 0, glyph: "#", color: "accent" }], options).every((c) => c.glyph === CELL_FREE)).toBe(true);
	});

	test("an overfull window clips rather than wrapping", () => {
		const cells = planCells([{ label: "big", tokens: 99_999, glyph: "#", color: "accent" }], options);
		expect(cells).toHaveLength(100);
		expect(cells.every((cell) => cell.glyph === "#")).toBe(true);
	});

	test("an unknown window renders as entirely free", () => {
		const cells = planCells([{ label: "a", tokens: 5, glyph: "#", color: "accent" }], { ...options, contextWindow: 0 });
		expect(cells.every((cell) => cell.glyph === CELL_FREE)).toBe(true);
	});
});

describe("renderGrid", () => {
	test("puts the legend beside the grid", () => {
		const out = renderGrid([{ label: "system prompt", tokens: 500, glyph: "#", color: "accent" }], options);
		// The grid is taller than this legend, so the grid sets the height.
		expect(out.split("\n")).toHaveLength(10);
		expect(out).toContain("system prompt");
		expect(out).toContain("free");
		expect(out).toContain("window");
	});
});

describe("thousands", () => {
	test("keeps small numbers exact and rounds big ones", () => {
		expect(thousands(900)).toBe("900");
		expect(thousands(1500)).toBe("1.5k");
		expect(thousands(26_000)).toBe("26k");
	});
});

describe("slicesOf", () => {
	const payload = {
		messages: [
			{ role: "system", content: "x".repeat(400) },
			{ role: "user", content: "y".repeat(40) },
			{ role: "assistant", content: "z".repeat(80) },
		],
		tools: [{ name: "bash" }],
	};

	test("separates the prompt, the schemas and the two sides of the conversation", () => {
		const slices = slicesOf(payload);
		expect(slices.map((slice) => slice.label)).toEqual([
			"system prompt",
			"tool schemas",
			"your messages",
			"replies + tools",
		]);
		expect(slices[0]!.tokens).toBe(100);
		expect(slices[2]!.tokens).toBe(10);
		expect(slices[3]!.tokens).toBe(20);
	});

	test("reads a top-level system field too", () => {
		expect(slicesOf({ system: "a".repeat(40), messages: [] })[0]!.tokens).toBe(10);
	});

	test("estimates an empty string as nothing", () => {
		expect(estimateTokens("")).toBe(0);
	});
});

describe("provider shapes", () => {
	test("reads the Responses shape, where the prompt is a developer entry", () => {
		const slices = slicesOf({
			input: [
				{ role: "developer", content: "d".repeat(400) },
				{ role: "user", content: [{ type: "input_text", text: "u".repeat(40) }] },
			],
			tools: [],
		});
		expect(slices[0]!.tokens).toBe(100);
		expect(slices[2]!.tokens).toBe(10);
	});

	test("reads a top-level instructions field", () => {
		expect(slicesOf({ instructions: "i".repeat(80), input: [] })[0]!.tokens).toBe(20);
	});

	test("reads the chat-completions shape too", () => {
		const slices = slicesOf({
			messages: [
				{ role: "system", content: "s".repeat(400) },
				{ role: "assistant", content: "a".repeat(80) },
			],
		});
		expect(slices[0]!.tokens).toBe(100);
		expect(slices[3]!.tokens).toBe(20);
	});
});
