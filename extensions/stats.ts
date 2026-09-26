/**
 * The footer's content, as pure functions over plain numbers.
 *
 * Nothing here knows about Pi, themes or terminals, so the whole footer is
 * testable as strings. The extension does the wiring and the colour.
 */

export interface FooterStats {
	model: string | undefined;
	branch: string | undefined;
	/** Tokens in the window right now, from the last response. */
	used: number;
	contextWindow: number;
	/** Where auto-compaction fires, in tokens. Zero when it will not. */
	compactAt: number;
	lastFresh: number;
	lastCached: number;
	sessionFresh: number;
	sessionCached: number;
	savedChars: number;
}

export function thousands(value: number): string {
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(Math.round(value));
}

const FILLED = "█";
const EMPTY = "░";
const MARKER = "╎";

/**
 * A bar with a mark where auto-compaction fires, so the distance to it is
 * visible rather than arithmetic. The mark replaces a cell instead of adding
 * one, so the bar's width never changes.
 */
export function gauge(used: number, window: number, compactAt: number, width: number): string {
	if (!(window > 0) || width <= 0) return "";
	const filled = Math.min(width, Math.round((Math.max(0, used) / window) * width));
	const markAt = compactAt > 0 && compactAt < window ? Math.min(width - 1, Math.floor((compactAt / window) * width)) : -1;

	let bar = "";
	for (let cell = 0; cell < width; cell++) {
		bar += cell === markAt ? MARKER : cell < filled ? FILLED : EMPTY;
	}
	return bar;
}

/** The share of the last request that was served from cache. */
export function hitRate(fresh: number, cached: number): number {
	const total = fresh + cached;
	return total > 0 ? Math.round((cached / total) * 100) : 0;
}

export function renderFooter(stats: FooterStats, width: number): string[] {
	const percent = stats.contextWindow > 0 ? Math.round((stats.used / stats.contextWindow) * 100) : 0;
	const barWidth = Math.max(8, Math.min(24, width - 56));

	const top = [
		gauge(stats.used, stats.contextWindow, stats.compactAt, barWidth),
		`${String(percent).padStart(2)}%`,
		`${thousands(stats.used)}/${thousands(stats.contextWindow)}`,
	].join(" ");

	const parts = [
		`${thousands(stats.lastFresh)} new + ${thousands(stats.lastCached)} cached (${hitRate(stats.lastFresh, stats.lastCached)}%)`,
	];
	if (stats.savedChars > 0) parts.push(`juna saved ${thousands(stats.savedChars / 4)} tok`);
	if (stats.model) parts.push(stats.model);
	if (stats.branch) parts.push(stats.branch);

	return [top, parts.join("  ·  ")];
}
