/**
 * Row-level focus for window reads. A big window lists hundreds of controls,
 * and every row is input the calling model must read. Chunk pruning would cut
 * the list mid-way; here each row is judged on its own, and only rows Jev is
 * confident the task does not need are hidden. Everything fails open.
 */

import { type El } from "./model.ts";

export interface Row { ref: string; el: El; line: string }

/** Rows that merely repeat the control above them: a combo box's own label and value, echoed as Text. Free to drop. */
export function dropMirrors(rows: Row[]): Row[] {
	return rows.filter((row, i) => {
		const prev = rows[i - 1]?.el;
		return !(prev && /^(Text|StaticText)$/i.test(row.el.role) && row.el.label === prev.label && (row.el.value ?? "") === (prev.value ?? "") && prev.role !== row.el.role);
	});
}

const ITEM = /^(ListItem|DataItem|TreeItem|Row|Cell|Outline(Row)?)$/i;
const CELL = /^(Edit|Text|StaticText|DataItem|Cell)$/i;

/**
 * Fold a list row's cells into the row itself: Explorer lists each file as a
 * ListItem plus one Edit per column, four lines where one says it all.
 * Deterministic and free; `all=true` still shows the cells as their own rows.
 */
export function foldCells(rows: Row[]): Row[] {
	const byIndex = new Map(rows.map((row) => [row.el.index, row]));
	const extra = new Map<number, string[]>();
	const folded = new Set<Row>();
	for (const row of rows) {
		const parent = row.el.parent === undefined ? undefined : byIndex.get(row.el.parent);
		if (!parent || !ITEM.test(parent.el.role) || !CELL.test(row.el.role)) continue;
		const value = (row.el.value ?? "").trim();
		folded.add(row);
		if (!value || value === parent.el.label) continue;
		const cells = extra.get(parent.el.index) ?? [];
		cells.push(row.el.label && row.el.label !== value ? `${row.el.label}: ${value}` : value);
		extra.set(parent.el.index, cells);
	}
	return rows.filter((row) => !folded.has(row)).map((row) => {
		const cells = extra.get(row.el.index);
		return cells ? { ...row, line: `${row.line} · ${cells.join(" · ")}` } : row;
	});
}

export function focusRequest(model: string, task: string, window: string, rows: Row[]): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const [i, row] of rows.entries()) {
		questions[`r${i}`] = {
			type: "noul",
			instructions: {
				judgement: "The agent needs this one row to do the task: it is a control the task acts on, text the task reads, or the way to reach them. Generic scrolling, window chrome, view switches, column headers and unrelated items are not needed unless the task is about them. Judge only this row; the others are judged separately.",
				row: row.line.slice(row.ref.length + 1),
			},
		};
	}
	return { model, state: { task: task || "operate this window", window }, questions };
}

/**
 * Keep a row unless Jev answered for it AND is confident it is unneeded.
 * An unanswered or malformed answer keeps the row.
 */
export function decideFocus(rows: Row[], answers: Record<string, { noul?: number } | undefined>, floor: number): boolean[] {
	return rows.map((_row, i) => {
		const p = answers[`r${i}`]?.noul;
		return typeof p !== "number" || !Number.isFinite(p) || p >= floor;
	});
}

/** One footer line naming what was hidden, by role, so the model knows what to ask for. */
export function hiddenNote(hidden: Row[]): string {
	if (!hidden.length) return "";
	const byRole = new Map<string, number>();
	for (const row of hidden) byRole.set(row.el.role || "control", (byRole.get(row.el.role || "control") ?? 0) + 1);
	const roles = [...byRole.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([role, n]) => `${n} ${role}`).join(", ");
	return `[juna hid ${hidden.length} controls judged unrelated to the task (${roles}). ui_look find="…" or all=true shows them.]`;
}
