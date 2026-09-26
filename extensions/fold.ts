/**
 * Fold planning and rendering for structural summaries. Pure: it takes spans
 * and text, and knows nothing about parsers or files.
 *
 * A bare read of a long code file does not need every function body. Folding
 * the bodies and keeping the signatures gives the model the shape of the file
 * for a fraction of the tokens, and unlike a Jev call it is free, instant and
 * deterministic, so it runs before anything that costs a round trip.
 */

export interface Span {
	/** 1-based inclusive lines of the foldable region, signature excluded. */
	startLine: number;
	endLine: number;
	/** Nesting depth, 0 for an outermost region. */
	depth: number;
	/** Index of the enclosing span in the same array, or -1. */
	parent: number;
}

export interface FoldOptions {
	/** Unfold outermost-first until at least this many lines are visible. */
	unfoldUntil: number;
	/** Never let a single unfold push visible lines past this. */
	unfoldLimit: number;
	/** Regions shorter than this are not worth a marker. */
	minBodyLines: number;
}

const lines = (span: Span) => span.endLine - span.startLine + 1;

/**
 * Choose which spans stay folded.
 *
 * Every outermost region starts folded. Regions are then revealed
 * outermost-first until the file is legible. A region whose reveal would blow
 * the limit is skipped and its children are never considered, so one enormous
 * function cannot starve its siblings of visibility.
 */
export function planFolds(spans: Span[], totalLines: number, options: FoldOptions): Span[] {
	// Drop regions too small to be worth a marker, then re-parent the survivors
	// onto their nearest surviving ancestor.
	if (spans.some((span, index) => !Number.isInteger(span.startLine) || !Number.isInteger(span.endLine)
		|| span.startLine < 1 || span.endLine > totalLines || span.endLine < span.startLine
		|| !Number.isInteger(span.parent) || span.parent < -1 || span.parent >= index
		|| (span.parent >= 0 && (span.startLine < spans[span.parent]!.startLine || span.endLine > spans[span.parent]!.endLine)))) return [];
	const keep = spans.map((span) => lines(span) >= options.minBodyLines);
	const nearest = (index: number): number => {
		let parent = spans[index]!.parent;
		while (parent >= 0 && !keep[parent]) parent = spans[parent]!.parent;
		return parent;
	};

	const children = new Map<number, number[]>();
	for (let index = 0; index < spans.length; index++) {
		if (!keep[index]) continue;
		const parent = nearest(index);
		children.set(parent, [...(children.get(parent) ?? []), index]);
	}

	const folded = new Set<number>(children.get(-1) ?? []);
	const queue = [...folded];
	let visible = totalLines - [...folded].reduce((sum, index) => sum + lines(spans[index]!) - 1, 0);

	while (queue.length > 0 && visible < options.unfoldUntil) {
		// Outermost first, then top to bottom, so the file reveals in reading order.
		queue.sort((a, b) => spans[a]!.depth - spans[b]!.depth || spans[a]!.startLine - spans[b]!.startLine);
		const index = queue.shift()!;
		if (!folded.has(index)) continue;

		const kids = children.get(index) ?? [];
		const gained = lines(spans[index]!) - 1 - kids.reduce((sum, kid) => sum + lines(spans[kid]!) - 1, 0);
		if (visible + gained > options.unfoldLimit) continue;

		folded.delete(index);
		visible += gained;
		for (const kid of kids) {
			folded.add(kid);
			queue.push(kid);
		}
	}

	return [...folded].map((index) => spans[index]!).sort((a, b) => a.startLine - b.startLine);
}

export interface RenderResult {
	text: string;
	elidedLines: number;
	/** The largest elided regions, for the recovery hint. */
	ranges: { startLine: number; endLine: number }[];
}

/** Replace each folded region with one marker line, keeping indentation. */
export function renderFolded(source: string, folds: Span[]): RenderResult {
	const all = source.split("\n");
	const out: string[] = [];
	let elidedLines = 0;
	let cursor = 0;

	folds = [...folds].sort((a, b) => a.startLine - b.startLine);
	if (folds.some((fold, index) => !Number.isInteger(fold.startLine) || !Number.isInteger(fold.endLine)
		|| fold.startLine < 1 || fold.endLine > all.length || fold.endLine < fold.startLine
		|| (index > 0 && fold.startLine <= folds[index - 1]!.endLine))) {
		return { text: source, elidedLines: 0, ranges: [] };
	}
	for (const fold of folds) {
		for (; cursor < fold.startLine - 1; cursor++) out.push(all[cursor]!);
		const count = fold.endLine - fold.startLine + 1;
		const indent = (all[fold.startLine - 1] ?? "").match(/^\s*/)?.[0] ?? "";
		out.push(`${indent}… ${count} lines folded (${fold.startLine}-${fold.endLine}) …`);
		elidedLines += count;
		cursor = fold.endLine;
	}
	for (; cursor < all.length; cursor++) out.push(all[cursor]!);

	const ranges = [...folds]
		.sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
		.slice(0, 3)
		.map((fold) => ({ startLine: fold.startLine, endLine: fold.endLine }))
		.sort((a, b) => a.startLine - b.startLine);

	return { text: out.join("\n"), elidedLines, ranges };
}

/**
 * The recovery line. It names real ranges rather than describing the syntax,
 * because a model copies an example far more reliably than it follows a rule.
 */
export function recoveryHint(path: string, result: RenderResult): string {
	if (result.elidedLines === 0) return "";
	const ranges = result.ranges.map((range) => `read path=${JSON.stringify(path)} offset=${range.startLine} limit=${range.endLine - range.startLine + 1}`).join("; ");
	return `\n[juna folded ${result.elidedLines} lines of bodies. Re-read what you need: ${ranges}]`;
}
