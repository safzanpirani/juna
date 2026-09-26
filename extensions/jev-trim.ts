/**
 * Cut the system prompt down to what juna actually needs.
 *
 * Measured on a real juna session: the prompt was 99,548 bytes, of which the
 * Agent Skills catalog was 95,625. Everything else together was under 4 KB.
 * So the catalog is the whole problem, and `skills` is removed by default.
 *
 * The catalog is not lost. juna loads pi-jev-skill-picker alongside this
 * extension, which strips the same block and hands the model `skill_search`
 * and `skill_load` instead, so skills arrive as tool results when a task needs
 * them. Both strips are idempotent, and either extension alone is still
 * correct.
 *
 * Trimming is deterministic on purpose. See trim.ts for why Jev does not pick
 * the sections.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { estimateTokensFromBytes, thousands } from "./grid.ts";
import { parseTags, trimSections } from "./trim.ts";

/** Sections dropped unless `JUNA_TRIM_SECTIONS` says otherwise. */
export const DEFAULT_TRIM_TAGS = ["skills", "docs", "rules"] as const;

export default function (pi: ExtensionAPI) {
	const tags = parseTags(process.env.JUNA_TRIM_SECTIONS, DEFAULT_TRIM_TAGS);
	let reported = false;
	// TODO(review): Later third-party prompt handlers and tool-schema changes need a profile-wide cache policy.
	let stablePrompt: string | undefined;
	pi.on("session_start", () => { stablePrompt = undefined; reported = false; });

	pi.on("before_agent_start", (event, ctx) => {
		if (stablePrompt !== undefined) return { systemPrompt: stablePrompt };
		const result = trimSections(event.systemPrompt, tags);
		stablePrompt = result.prompt;

		if (!reported) {
			reported = true;
			// Bytes would read as tokens beside the other counters, so report the
			// estimate in the same currency and say that it is one.
			const total = estimateTokensFromBytes(result.removed.reduce((sum, entry) => sum + entry.bytes, 0));
			const detail = result.removed
				.map((entry) => `${entry.tag} ${thousands(estimateTokensFromBytes(entry.bytes))}`)
				.join(", ");
			ctx.ui.setStatus("juna-trim", `prompt ~-${thousands(total)} tok (${detail})`);
		}

		return { systemPrompt: result.prompt };
	});
}
