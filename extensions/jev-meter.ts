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

export default function (pi: ExtensionAPI) {
	const reserve = Number.parseInt(process.env.JUNA_RESERVE_TOKENS ?? "", 10) || DEFAULT_RESERVE_TOKENS;

	pi.on("message_end", (event, ctx) => {
		const usage = (event.message as { usage?: { input?: number; cacheRead?: number } }).usage;
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
