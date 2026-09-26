/**
 * A picture of where the context went.
 *
 * A single percentage tells you the window is filling; it does not tell you
 * what is filling it. This renders the composition as a fixed grid, one cell
 * per half percent, so the shape of the problem is visible at a glance. The
 * idea is borrowed from oh-my-pi's status line; the code is our own.
 *
 * Colour is applied through an injected `paint`, so the renderer stays pure and
 * testable and the extension owns the theme. Without one it returns plain text,
 * which is what a pipe or a test wants anyway.
 */

/** Pi theme colour names, kept as strings so this module needs no Pi import. */
export type Paint = (color: string, text: string) => string;

const plain: Paint = (_color, text) => text;

export interface Slice {
	label: string;
	tokens: number;
	glyph: string;
	color: string;
}

export const CELL_FREE = "·";
export const FREE_COLOR = "dim";

export interface GridOptions {
	columns: number;
	rows: number;
	contextWindow: number;
}

interface Cell {
	glyph: string;
	color: string;
}

/**
 * Lay the slices into cells, one cell per window fraction. A slice with any
 * tokens at all gets at least one cell, so nothing disappears by rounding.
 * Anything past the grid is clipped rather than wrapped: an overfull window is
 * a different problem, and the number beside the grid already says so.
 */
export function planCells(slices: Slice[], options: GridOptions): Cell[] {
	const total = options.columns * options.rows;
	const free: Cell = { glyph: CELL_FREE, color: FREE_COLOR };
	const perCell = options.contextWindow / total;
	if (!(perCell > 0)) return Array.from({ length: total }, () => free);

	const cells: Cell[] = [];
	for (const slice of slices) {
		if (slice.tokens <= 0) continue;
		const count = Math.max(1, Math.round(slice.tokens / perCell));
		for (let index = 0; index < count && cells.length < total; index++) {
			cells.push({ glyph: slice.glyph, color: slice.color });
		}
	}
	while (cells.length < total) cells.push(free);
	return cells.slice(0, total);
}

/**
 * Tokens, estimated at four characters each.
 *
 * It is a rule of thumb and it is labelled as one wherever it is shown. Real
 * tokenization needs a tokenizer per model and a dependency loaded at startup;
 * scripts/context-report.ts does that when the exact number matters.
 */
export function estimateTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

/** The same estimate for a byte count that is already known. */
export function estimateTokensFromBytes(bytes: number): number {
	return Math.ceil(bytes / 4);
}

export function thousands(tokens: number): string {
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(Math.round(tokens));
}

/** The grid, with the legend beside it. */
export function renderGrid(slices: Slice[], options: GridOptions, paint: Paint = plain): string {
	const cells = planCells(slices, options);
	const used = slices.reduce((sum, slice) => sum + slice.tokens, 0);

	const legend = [
		...slices
			.filter((slice) => slice.tokens > 0)
			.map((slice) => {
				const share = options.contextWindow > 0 ? Math.round((slice.tokens / options.contextWindow) * 100) : 0;
				return paint(
					slice.color,
					`${slice.glyph}  ${slice.label.padEnd(16)} ${thousands(slice.tokens).padStart(6)}  ${String(share).padStart(3)}%`,
				);
			}),
		"",
		paint(FREE_COLOR, `${CELL_FREE}  ${"free".padEnd(16)} ${thousands(Math.max(0, options.contextWindow - used)).padStart(6)}`),
		paint("muted", `   ${"window".padEnd(16)} ${thousands(options.contextWindow).padStart(6)}`),
	];

	const lines: string[] = [];
	for (let row = 0; row < Math.max(options.rows, legend.length); row++) {
		const painted =
			row < options.rows
				? cells
						.slice(row * options.columns, (row + 1) * options.columns)
						.map((cell) => paint(cell.color, cell.glyph))
						.join(" ")
				: " ".repeat(options.columns * 2 - 1);
		const beside = legend[row] ?? "";
		lines.push(beside ? `${painted}   ${beside}` : painted);
	}
	return lines.join("\n");
}
