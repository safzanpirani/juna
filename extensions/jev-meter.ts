/**
 * Show what a request actually costs, and how close compaction is.
 *
 * Pi's own counters report cumulative uncached input and a cache hit rate.
 * Neither answers "how big is my context right now", and the hit rate is
 * actively misleading once the prefix is small: it is cached over
 * cached-plus-fresh, so shrinking the prefix makes the percentage fall while
 * the bill drops. This reports the real per-request numbers instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { gauge, hitRate, thousands } from "./stats.ts";
import { totalSaved } from "./savings.ts";

/** Pi reserves tokens for the reply; compaction fires at the window minus that. */
const DEFAULT_RESERVE_TOKENS = 16_384;

export interface Meter {
	fresh: number;
	cached: number;
}

/** What the model was actually sent, and how much of it was free. */
export function render(meter: Meter): string {
	const total = meter.fresh + meter.cached;
	if (total === 0) return "";
	const saved = totalSaved();
	const parts = [
		`ctx ${thousands(total)} = ${thousands(meter.fresh)} new + ${thousands(meter.cached)} cached (${hitRate(meter.fresh, meter.cached)}%)`,
	];
	if (saved > 0) parts.push(`juna −${thousands(saved / 4)} tok`);
	return parts.join("  ");
}

/** Chars per token, for a live estimate before the provider reports usage. */
const CHARS_PER_TOKEN = 4;
/** Below this, one burst of chunks gives a rate that means nothing. */
const MIN_ELAPSED_MS = 100;
/** How often the live rate repaints while streaming. */
const PAINT_EVERY_MS = 250;

/**
 * Decode speed in tokens per second, timed from the first streamed token so
 * the wait for the first token does not drag the number down.
 */
export function renderTps(tokens: number, elapsedMs: number): string {
	if (!(tokens > 0) || elapsedMs < MIN_ELAPSED_MS) return "";
	return `${Math.round((tokens * 1000) / elapsedMs)} tok/s`;
}

export default function (pi: ExtensionAPI) {
	const reserve = Number.parseInt(process.env.JUNA_RESERVE_TOKENS ?? "", 10) || DEFAULT_RESERVE_TOKENS;

	// Streaming state for the tokens-per-second counter, reset per assistant message.
	let firstTokenAt = 0;
	let streamedChars = 0;
	let lastPaint = 0;

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		firstTokenAt = 0;
		streamedChars = 0;
		lastPaint = 0;
	});

	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") return;
		const now = Date.now();
		if (firstTokenAt === 0) firstTokenAt = now;
		streamedChars += update.delta.length;
		if (now - lastPaint < PAINT_EVERY_MS) return;
		lastPaint = now;
		const live = renderTps(streamedChars / CHARS_PER_TOKEN, now - firstTokenAt);
		if (live) ctx.ui.setStatus("juna-tps", live);
	});

	pi.on("message_end", (event, ctx) => {
		const usage = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number } }).usage;
		if (event.message.role === "assistant" && firstTokenAt > 0) {
			// The provider's output count replaces the estimate once it exists.
			const tokens = usage?.output || streamedChars / CHARS_PER_TOKEN;
			const final = renderTps(tokens, Date.now() - firstTokenAt);
			if (final) ctx.ui.setStatus("juna-tps", final);
			firstTokenAt = 0;
		}
		if (!usage || typeof usage.input !== "number") return;
		ctx.ui.setStatus("juna-ctx", render({ fresh: usage.input, cached: usage.cacheRead ?? 0 }));

		// The bar carries a mark where auto-compaction fires, so the distance to
		// it is visible rather than arithmetic.
		const contextUsage = ctx.getContextUsage();
		const window = contextUsage?.contextWindow ?? 0;
		const used = contextUsage?.tokens ?? 0;
		if (window > 0) {
			const percent = Math.round((used / window) * 100);
			ctx.ui.setStatus(
				"juna-gauge",
				`${gauge(used, window, Math.max(0, window - reserve), 16)} ${percent}% of ${thousands(window)}`,
			);
		}
	});
}
