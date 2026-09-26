import { describe, expect, test } from "bun:test";

import { planFolds, recoveryHint, renderFolded, type Span } from "../extensions/fold.ts";
import { languageFor, spansOf, summarize } from "../extensions/structure.ts";

const options = { unfoldUntil: 50, unfoldLimit: 100, minBodyLines: 4 };

describe("planFolds", () => {
	test("folds nothing when there is nothing big enough", () => {
		const spans: Span[] = [{ startLine: 2, endLine: 3, depth: 0, parent: -1 }];
		expect(planFolds(spans, 10, options)).toEqual([]);
	});

	test("keeps an outermost body folded when the file is already legible", () => {
		const spans: Span[] = [{ startLine: 2, endLine: 200, depth: 0, parent: -1 }];
		const folds = planFolds(spans, 220, { ...options, unfoldUntil: 10 });
		expect(folds).toHaveLength(1);
	});

	test("unfolds outermost first and reveals the children", () => {
		const spans: Span[] = [
			{ startLine: 2, endLine: 60, depth: 0, parent: -1 },
			{ startLine: 10, endLine: 30, depth: 1, parent: 0 },
		];
		const folds = planFolds(spans, 70, { ...options, unfoldUntil: 40, unfoldLimit: 100 });
		expect(folds.map((fold) => fold.startLine)).toEqual([10]);
	});

	test("skips a reveal that would blow the limit, and keeps its subtree folded", () => {
		const spans: Span[] = [
			{ startLine: 2, endLine: 900, depth: 0, parent: -1 },
			{ startLine: 100, endLine: 200, depth: 1, parent: 0 },
		];
		const folds = planFolds(spans, 1000, { ...options, unfoldUntil: 50, unfoldLimit: 200 });
		expect(folds.map((fold) => fold.startLine)).toEqual([2]);
	});

	test("one huge sibling does not starve the others", () => {
		const spans: Span[] = [
			{ startLine: 2, endLine: 800, depth: 0, parent: -1 },
			{ startLine: 810, endLine: 820, depth: 0, parent: -1 },
		];
		const folds = planFolds(spans, 830, { ...options, unfoldUntil: 40, unfoldLimit: 100 });
		// The huge one stays folded; the small one is revealed.
		expect(folds.map((fold) => fold.startLine)).toEqual([2]);
	});
});

describe("renderFolded", () => {
	const source = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

	test("replaces each region with one marker and keeps the rest", () => {
		const result = renderFolded(source, [{ startLine: 5, endLine: 14, depth: 0, parent: -1 }]);
		expect(result.text.split("\n")).toHaveLength(11);
		expect(result.text).toContain("… 10 lines folded (5-14) …");
		expect(result.text).toContain("line 4");
		expect(result.text).toContain("line 15");
		expect(result.elidedLines).toBe(10);
	});

	test("keeps the indentation of the folded region", () => {
		const indented = "function f() {\n    const a = 1;\n    const b = 2;\n}";
		const result = renderFolded(indented, [{ startLine: 2, endLine: 3, depth: 0, parent: -1 }]);
		expect(result.text).toContain("    … 2 lines");
	});

	test("reports the largest ranges in reading order", () => {
		const result = renderFolded(source, [
			{ startLine: 2, endLine: 3, depth: 0, parent: -1 },
			{ startLine: 6, endLine: 16, depth: 0, parent: -1 },
		]);
		expect(result.ranges).toEqual([
			{ startLine: 2, endLine: 3 },
			{ startLine: 6, endLine: 16 },
		]);
	});
});

describe("recoveryHint", () => {
	test("names concrete ranges the model can copy", () => {
		const hint = recoveryHint("src/a.ts", { text: "", elidedLines: 40, ranges: [{ startLine: 12, endLine: 40 }] });
		expect(hint).toContain("read path=\"src/a.ts\" offset=12 limit=29");
	});

	test("is empty when nothing was folded", () => {
		expect(recoveryHint("src/a.ts", { text: "", elidedLines: 0, ranges: [] })).toBe("");
	});
});

describe("languageFor", () => {
	test("knows the languages ast-grep ships", () => {
		expect(languageFor("a/b.ts")).toBeDefined();
		expect(languageFor("a/b.TSX")).toBeDefined();
		expect(languageFor("a/b.py")).toBeUndefined();
		expect(languageFor("README.md")).toBeUndefined();
	});
});

describe("summarize", () => {
	const big = [
		"import { x } from './x';",
		...Array.from({ length: 12 }, (_, f) =>
			[`export function fn${f}(a: number) {`, ...Array.from({ length: 10 }, (_, i) => `\tconst v${i} = ${i};`), "\treturn a;", "}"].join("\n"),
		),
	].join("\n");

	test("folds bodies and keeps every signature", () => {
		const out = summarize("src/big.ts", big, { ...options, minTotalLines: 100, maxBytes: 2_000_000 })!;
		expect(out).toBeDefined();
		for (let f = 0; f < 12; f++) expect(out).toContain(`export function fn${f}(`);
		expect(out.length).toBeLessThan(big.length);
		expect(out).toContain("[juna folded");
	});

	test("passes through a short file, an unknown language and a huge one", () => {
		expect(summarize("a.ts", "const a = 1;", { ...options, minTotalLines: 100, maxBytes: 2_000_000 })).toBeUndefined();
		expect(summarize("a.py", big, { ...options, minTotalLines: 100, maxBytes: 2_000_000 })).toBeUndefined();
		expect(summarize("a.ts", big, { ...options, minTotalLines: 100, maxBytes: 10 })).toBeUndefined();
	});

	test("spans exclude the delimiter lines, so braces survive", () => {
		const spans = spansOf("function f() {\n\tconst a = 1;\n\tconst b = 2;\n}", languageFor("a.ts")!);
		expect(spans[0]).toMatchObject({ startLine: 2, endLine: 3 });
	});
});

test("class, interface and nested signatures survive folding", () => {
	const source = `interface I {\n${Array.from({ length: 8 }, (_, i) => `m${i}(): void;`).join("\n")}\n}\nclass C {\nmethod() {\nfunction nested() {\n${"work();\n".repeat(20)}}\n${"work();\n".repeat(20)}}\n}`;
	const out = summarize("a.ts", source, { ...options, unfoldUntil: 1, minTotalLines: 1, maxBytes: 100000 })!;
	expect(out).toContain("m7(): void;");
	expect(out).toContain("method() {");
	expect(out).toContain("function nested() {");
});

test("single-line bodies have no foldable interior", () => {
	expect(spansOf("function f() { return 1; }", languageFor("a.ts")!)).toEqual([]);
});

test("invalid syntax is not summarized", () => {
	expect(spansOf("function f( {\nxx", languageFor("a.ts")!)).toEqual([]);
});

test("cyclic parent data and overlapping renders fail open", () => {
	const bad = [{ startLine: 2, endLine: 8, parent: 0, depth: 0 }];
	expect(planFolds(bad, 10, options)).toEqual([]);
	const source = "a\nb\nc\nd\ne";
	expect(renderFolded(source, [{ startLine: 2, endLine: 4, parent: -1, depth: 0 }, { startLine: 3, endLine: 5, parent: -1, depth: 0 }]).text).toBe(source);
});

test("fold markers count towards visible line limit", () => {
	const spans = [{ startLine: 2, endLine: 8, parent: -1, depth: 0 }, { startLine: 3, endLine: 6, parent: 0, depth: 1 }];
	const folds = planFolds(spans, 10, { minBodyLines: 1, unfoldUntil: 5, unfoldLimit: 6 });
	expect(folds).toEqual([spans[0]!]);
});
