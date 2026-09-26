/**
 * Pure chunking for tool output. No Jev, no I/O, so it is fully testable.
 *
 * Output is cut on line boundaries into a bounded number of chunks. Jev scores
 * each chunk; whatever falls below the floor is replaced by a marker that says
 * exactly what was removed, so the model can go and re-read it if the judgement
 * was wrong.
 */

export interface Chunk {
	index: number;
	/** 1-based inclusive line range in the original output. */
	startLine: number;
	endLine: number;
	text: string;
}

export interface SplitOptions {
	/** Upper bound on chunks, which is also the upper bound on Jev questions. */
	maxChunks: number;
	/** Never cut finer than this, so small outputs stay whole. */
	minLines: number;
	/**
	 * Hard cap on a chunk's characters. A chunk longer than what Jev is shown
	 * would be scored on a truncated excerpt, so long lines force an extra cut
	 * even when the line budget has room.
	 */
	maxChars: number;
}

export function splitChunks(text: string, options: SplitOptions): Chunk[] {
	const lines = text.split("\n");
	const perChunk = Math.max(options.minLines, Math.ceil(lines.length / Math.max(1, options.maxChunks)));
	const chunks: Chunk[] = [];

	let start = 0;
	while (start < lines.length) {
		let taken = 0;
		let chars = 0;
		// Take lines until either budget runs out, but always take at least one.
		while (start + taken < lines.length && taken < perChunk) {
			const next = lines[start + taken]!.length + 1;
			if (taken > 0 && chars + next > options.maxChars) break;
			chars += next;
			taken += 1;
		}
		const slice = lines.slice(start, start + taken);
		chunks.push({
			index: chunks.length,
			startLine: start + 1,
			endLine: start + taken,
			text: slice.join("\n"),
		});
		start += taken;
	}

	return chunks;
}

export interface AssembleResult {
	text: string;
	keptChunks: number;
	droppedChunks: number;
	keptLines: number;
	droppedLines: number;
}

/**
 * Rebuild the output from the chunks marked kept. Adjacent drops collapse into
 * one marker so a mostly-irrelevant output does not become a wall of markers.
 */
export function assemble(chunks: Chunk[], kept: readonly boolean[]): AssembleResult {
	const parts: string[] = [];
	let keptChunks = 0;
	let droppedChunks = 0;
	let keptLines = 0;
	let droppedLines = 0;
	let runStart: number | undefined;
	let runEnd = 0;
	let runLines = 0;

	function flushRun() {
		if (runStart === undefined) return;
		parts.push(`[juna pruned lines ${runStart}-${runEnd} as irrelevant to the task. Re-run the tool to see them.]`);
		runStart = undefined;
		runLines = 0;
	}

	for (const chunk of chunks) {
		const lineCount = chunk.endLine - chunk.startLine + 1;
		if (kept[chunk.index] !== false) {
			flushRun();
			parts.push(chunk.text);
			keptChunks += 1;
			keptLines += lineCount;
			continue;
		}
		droppedChunks += 1;
		droppedLines += lineCount;
		if (runStart === undefined) runStart = chunk.startLine;
		runEnd = chunk.endLine;
		runLines += lineCount;
	}
	flushRun();

	return { text: parts.join("\n"), keptChunks, droppedChunks, keptLines, droppedLines };
}

/**
 * What Jev is shown for a chunk. A chunk that fits is sent whole; an oversized
 * one is sent as its head and tail with the gap named, because a silently
 * truncated excerpt would be scored on evidence the chunk does not represent.
 */
export function excerpt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 0.6);
	const tail = limit - head;
	const skipped = text.length - head - tail;
	return `${text.slice(0, head)}\n[… ${skipped} characters omitted from the middle of this excerpt …]\n${(tail > 0 ? text.slice(-tail) : "")}`;
}

/**
 * Split so the chunk count stays under `hardMax`, whatever the output size.
 * Cost is bounded by the number of Jev questions, so a 700k-token file is cut
 * coarsely rather than into thousands of chunks.
 */
export function splitBounded(text: string, options: SplitOptions & { hardMax: number }): Chunk[] {
	let chunks = splitChunks(text, options);
	const lineCount = text.split("\n").length;
	const hardMax = Math.max(1, Math.floor(options.hardMax));
	if (chunks.length > hardMax) {
		// Whole lines are indivisible; relaxing the character budget guarantees the cap.
		chunks = splitChunks(text, {
			maxChunks: hardMax,
			minLines: Math.ceil(lineCount / hardMax),
			maxChars: Infinity,
		});
	}
	return chunks;
}
