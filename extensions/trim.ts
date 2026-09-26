/**
 * Deterministic system-prompt trimming. Pure string work, no Jev, no I/O.
 *
 * Trimming must produce the same output for the same input on every turn. The
 * system prompt is the head of the cached prefix, so a prompt that varies per
 * turn invalidates the entire cache every turn. That is why Jev does not choose
 * what to cut here: a per-turn judgement would cost more than the sections are
 * worth. Jev's place is tool output, which is appended, not re-sent.
 */

export interface TrimResult {
	prompt: string;
	/** Bytes removed, per section tag, in removal order. */
	removed: { tag: string; bytes: number }[];
}

/**
 * Remove `<tag> … </tag>` blocks, including the blank line that follows them.
 * A tag that is absent, unclosed, or already removed is skipped, so trimming is
 * idempotent and safe to chain after another extension.
 */
export function trimSections(prompt: string, tags: readonly string[]): TrimResult {
	let out = prompt;
	const removed: { tag: string; bytes: number }[] = [];

	for (const tag of tags) {
		const open = `<${tag}>`;
		const close = `</${tag}>`;
		const start = out.indexOf(open);
		if (start === -1) continue;
		const end = out.indexOf(close, start + open.length);
		if (end === -1) continue;

		let stop = end + close.length;
		while (stop < out.length && out[stop] === "\n") stop += 1;
		let from = start;
		while (from > 0 && out[from - 1] === "\n") from -= 1;
		// Keep one blank line between the surviving neighbours.
		const joiner = from > 0 && stop < out.length ? "\n\n" : "";

		removed.push({ tag, bytes: stop - from - joiner.length });
		out = out.slice(0, from) + joiner + out.slice(stop);
	}

	return { prompt: out, removed };
}

/** Parse a comma-separated tag list, ignoring blanks and stray angle brackets. */
export function parseTags(value: string | undefined, fallback: readonly string[]): string[] {
	if (value === undefined) return [...fallback];
	const tags = value
		.split(",")
		.map((tag) => tag.trim().replace(/^<|>$/g, ""))
		.filter(Boolean);
	return tags;
}
