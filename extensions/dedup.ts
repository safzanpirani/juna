/**
 * Remember what each tool already returned, so the same bytes never enter the
 * context twice.
 *
 * Re-reading an unchanged file is the cheapest waste there is: the agent pays
 * full price for something already above it in the conversation. Replacing the
 * repeat with a pointer costs nothing and needs no model call.
 *
 * Like everything in juna, this only rewrites a result that has not been sent
 * yet, so the cached prefix is untouched.
 */

import { createHash } from "node:crypto";

export interface Seen {
	/** 1-based order of the call that first produced these bytes. */
	call: number;
	tool: string;
	lines: number;
}

/** The length prefix keeps a tool name from colliding with the output's head. */
export function fingerprint(toolName: string, text: string): string {
	return createHash("sha256").update(`${toolName.length}:${toolName}`).update(text).digest("hex");
}

export class OutputMemory {
	private readonly seen = new Map<string, Seen>();
	private calls = 0;

	constructor(private readonly capacity = 512) {}

	clear(): void {
		this.seen.clear();
		this.calls = 0;
	}

	lookup(toolName: string, text: string): Seen | undefined {
		return this.seen.get(fingerprint(toolName, text));
	}

	/**
	 * Record an output. Returns the earlier sighting when these exact bytes have
	 * been returned by this tool before, and undefined the first time.
	 */
	remember(toolName: string, text: string): Seen | undefined {
		this.calls += 1;
		const key = fingerprint(toolName, text);
		const earlier = this.seen.get(key);
		if (earlier) return earlier;
		if (this.seen.size >= this.capacity) this.seen.delete(this.seen.keys().next().value!);
		this.seen.set(key, { call: this.calls, tool: toolName, lines: text.split("\n").length });
		return undefined;
	}

	get size(): number {
		return this.seen.size;
	}
}

export function repeatMarker(earlier: Seen): string {
	return (
		`[juna: identical to the ${earlier.tool} output earlier in this session ` +
		`(${earlier.lines} line${earlier.lines === 1 ? "" : "s"}).]`
	);
}
