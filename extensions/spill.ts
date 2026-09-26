/**
 * A hard ceiling on what any single tool result can cost.
 *
 * Scoring 2 MB of output is expensive even when it works, and a pathological
 * result should never be able to eat a window. Above the threshold the full
 * text goes to a file and the context gets its head and tail plus the path, so
 * nothing is lost and the worst case is bounded.
 *
 * The spill happens before the result has been sent, so the cached prefix is
 * untouched, like everything else in juna.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SpillOptions {
	/** Spill above this many characters. */
	threshold: number;
	/** Characters kept from the start and from the end. */
	headChars: number;
	tailChars: number;
}

export interface SpillResult {
	failed?: boolean;
	text: string;
	path: string | undefined;
	droppedChars: number;
}

/** Keep the head and the tail, both cut on line boundaries. */
export function truncateMiddle(text: string, options: SpillOptions, notice = "%%MIDDLE%%"): { text: string; droppedChars: number } {
	const headSize = Math.max(0, Math.floor(options.headChars));
	const tailSize = Math.max(0, Math.floor(options.tailChars));
	if (text.length <= headSize + tailSize) return { text, droppedChars: 0 };
	let head = text.slice(0, headSize);
	let tail = tailSize === 0 ? "" : text.slice(-tailSize);
	const headBreak = head.lastIndexOf("\n");
	if (headBreak >= 0) head = head.slice(0, headBreak + 1);
	// A tail already starting on a line boundary must keep its first line.
	if (tail && text[text.length - tailSize - 1] !== "\n") {
		const tailBreak = tail.indexOf("\n");
		if (tailBreak >= 0) tail = tail.slice(tailBreak + 1);
	}
	return {
		text: `${head}\n${notice}\n${tail}`,
		droppedChars: text.length - head.length - tail.length,
	};
}

export function spillDir(sessionId: string): string {
	return join(tmpdir(), `juna-${sessionId}`);
}

/**
 * Write the full output beside the session and return what should go into the
 * context. Failed writes retain the original because there is no recovery copy.
 */
export function spill(
	text: string,
	toolName: string,
	sessionId: string,
	sequence: number,
	options: SpillOptions,
	write: (path: string, contents: string) => void = (path, contents) => {
		mkdirSync(spillDir(sessionId), { recursive: true, mode: 0o700 });
		writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
	},
): SpillResult {
	if (text.length <= options.threshold) return { text, path: undefined, droppedChars: 0 };

	const path = join(spillDir(sessionId), `${sequence}-${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`);
	let saved: string | undefined;
	try {
		write(path, text);
		saved = path;
	} catch {
		return { text, path: undefined, droppedChars: 0, failed: true };
	}

	const cut = truncateMiddle(text, options);
	const notice = `[juna spilled ${Math.round(cut.droppedChars / 1000)}k characters. The whole output is at ${saved} — read the part you need.]`;
	return { ...truncateMiddle(text, options, notice), path: saved };
}
