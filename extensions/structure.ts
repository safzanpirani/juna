/**
 * Turn a source file into foldable spans with ast-grep.
 *
 * Only bodies fold: the braces, signatures, imports and top-level structure all
 * survive, so the model still sees the shape of the file and the name of every
 * function in it. Anything unparseable, unknown or too short falls through and
 * the file is returned whole.
 */

import { Lang, parse, type SgNode } from "@ast-grep/napi";

import { planFolds, recoveryHint, renderFolded, type FoldOptions, type Span } from "./fold.ts";

/** Node kinds whose interior is a body rather than structure. */
const BODY_KINDS = new Set(["statement_block"]);
const SIGNATURE_KINDS = new Set([
	"function_declaration", "generator_function_declaration", "method_definition",
	"class_declaration", "interface_declaration", "enum_declaration",
	"arrow_function", "function_expression", "generator_function",
]);

/**
 * The languages ast-grep ships in its core package. Others need a companion
 * grammar package and dynamic registration, so an unknown extension simply
 * falls through and the file is sent whole.
 */
const BY_EXTENSION: Record<string, Lang> = {
	ts: Lang.TypeScript,
	mts: Lang.TypeScript,
	cts: Lang.TypeScript,
	tsx: Lang.Tsx,
	jsx: Lang.Tsx,
	js: Lang.JavaScript,
	mjs: Lang.JavaScript,
	cjs: Lang.JavaScript,
};

export function languageFor(path: string): Lang | undefined {
	const extension = path.toLowerCase().split(".").pop() ?? "";
	return BY_EXTENSION[extension];
}

/**
 * Collect body interiors, excluding the lines the delimiters sit on so a folded
 * body still shows its own braces.
 */
export function spansOf(source: string, language: Lang): Span[] {
	const spans: Span[] = [];
	const signatures: number[] = [];

	function walk(node: SgNode, depth: number, parent: number) {
		if (SIGNATURE_KINDS.has(String(node.kind()))) signatures.push(node.range().start.line + 1);
		let nextParent = parent;
		let nextDepth = depth;
		if (BODY_KINDS.has(String(node.kind()))) {
			const range = node.range();
			const startLine = range.start.line + 2; // 1-based, and skip the opening delimiter's line
			const endLine = range.end.line; // 1-based end, minus the closing delimiter's line
			if (endLine >= startLine) {
				nextParent = spans.length;
				nextDepth = depth + 1;
				spans.push({ startLine, endLine, depth, parent });
			}
		}
		for (const child of node.children()) walk(child, nextDepth, nextParent);
	}

	const root = parse(language, source).root();
	if (root.find({ rule: { kind: "ERROR" } })) return [];
	walk(root, 0, -1);
	// An outer body must not hide declarations nested inside it.
	const keep = spans.map((span) => !signatures.some((line) => line >= span.startLine && line <= span.endLine));
	const indexes = new Map<number, number>();
	const result: Span[] = [];
	for (let i = 0; i < spans.length; i++) {
		if (!keep[i]) continue;
		const span = spans[i]!;
		let parent = span.parent;
		while (parent >= 0 && !keep[parent]) parent = spans[parent]!.parent;
		indexes.set(i, result.length);
		result.push({ ...span, parent: indexes.get(parent) ?? -1 });
	}
	return result;
}

export interface SummaryOptions extends FoldOptions {
	/** Files shorter than this are cheaper to send whole. */
	minTotalLines: number;
	/** Refuse to parse anything larger, to bound the work. */
	maxBytes: number;
}

/**
 * Fold a file's bodies. Returns undefined when the file should be passed
 * through untouched: unknown language, too small, too large, unparseable, or
 * nothing worth folding.
 */
export function summarize(path: string, source: string, options: SummaryOptions): string | undefined {
	const language = languageFor(path);
	if (!language) return undefined;
	if (source.length > options.maxBytes) return undefined;

	const totalLines = source.split("\n").length;
	if (totalLines < options.minTotalLines) return undefined;

	let spans: Span[];
	try {
		spans = spansOf(source, language);
	} catch {
		return undefined;
	}
	if (spans.length === 0) return undefined;

	const folds = planFolds(spans, totalLines, options);
	if (folds.length === 0) return undefined;

	const rendered = renderFolded(source, folds);
	if (rendered.elidedLines === 0) return undefined;
	// A summary that saved nothing is worse than the original: it costs a marker.
	const result = rendered.text + recoveryHint(path, rendered);
	return result.length < source.length ? result : undefined;
}
