/**
 * `/ctx` — what is in the context window right now, by category.
 *
 * The numbers come from the last provider payload, captured read-only in
 * `before_provider_request`. That hook is observational here: nothing is
 * mutated, so the cached prefix is untouched. It is the only place the real
 * wire content is visible, which is the point — an estimate of the context is
 * not the context.
 *
 * It draws in an overlay rather than the transcript. A snapshot of a moment is
 * wrong by the next turn, and a wrong number pinned to the scrollback is worse
 * than no number.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { estimateTokens, renderGrid, type Slice } from "./grid.ts";

interface Payload {
	/** Chat-completions shape. */
	messages?: { role?: string; content?: unknown }[];
	system?: unknown;
	/** Responses shape: a developer-role entry in `input`, or `instructions`. */
	input?: { role?: string; content?: unknown }[];
	instructions?: unknown;
	tools?: unknown[];
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => text((part as { text?: unknown }).text ?? part)).join("\n");
	return value === undefined || value === null ? "" : JSON.stringify(value);
}

const PROMPT_ROLES = new Set(["system", "developer"]);

/** Every conversation entry, whichever shape the provider uses. */
function entriesOf(payload: Payload): { role?: string; content?: unknown }[] {
	return payload.messages ?? payload.input ?? [];
}

export function promptTextOf(payload: Payload): string {
	if (payload.instructions !== undefined) return text(payload.instructions);
	if (payload.system !== undefined) return text(payload.system);
	return entriesOf(payload)
		.filter((entry) => PROMPT_ROLES.has(entry.role ?? ""))
		.map((entry) => text(entry.content))
		.join("\n");
}

export function slicesOf(payload: Payload): Slice[] {
	const conversation = entriesOf(payload).filter((entry) => !PROMPT_ROLES.has(entry.role ?? ""));
	const user = conversation.filter((entry) => entry.role === "user");
	const rest = conversation.filter((entry) => entry.role !== "user");

	return [
		{ label: "system prompt", tokens: estimateTokens(promptTextOf(payload)), glyph: "▓", color: "accent" },
		{ label: "tool schemas", tokens: estimateTokens(JSON.stringify(payload.tools ?? [])), glyph: "▒", color: "warning" },
		{ label: "your messages", tokens: estimateTokens(user.map((entry) => text(entry.content)).join("\n")), glyph: "░", color: "userMessageText" },
		{ label: "replies + tools", tokens: estimateTokens(rest.map((entry) => text(entry.content)).join("\n")), glyph: "▚", color: "success" },
	];
}

export default function (pi: ExtensionAPI) {
	let last: Payload | undefined;

	pi.on("before_provider_request", (event) => {
		// Read-only. Returning nothing leaves the payload exactly as it was.
		last = event.payload as Payload;
	});

	pi.registerCommand("ctx", {
		description: "Show what is filling the context window",
		handler: async (_args, ctx) => {
			if (!last) {
				ctx.ui.notify("Nothing has been sent yet this session, so there is no context to show.", "info");
				return;
			}
			const window = ctx.getContextUsage()?.contextWindow ?? 0;
			if (window <= 0) {
				ctx.ui.notify("No context window is known for this model.", "warning");
				return;
			}

			const slices = slicesOf(last);
			const layout = { columns: 20, rows: 10, contextWindow: window };
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`\n${renderGrid(slices, layout)}\n`, "info");
				return;
			}
			const theme = ctx.ui.theme;
			const body = renderGrid(slices, layout, (color, text) => theme.fg(color as never, text)).split("\n");

			// An overlay, so the snapshot leaves with the keypress that dismisses it.
			await ctx.ui.custom<void>(
				(_tui, overlayTheme, _keybindings, done) => ({
					render: () => [
						...body,
						"",
						overlayTheme.fg("muted", "tokens estimated at 4 chars each · any key to close"),
					],
					invalidate: () => {},
					handleInput: () => done(undefined),
				}),
				{ overlay: true },
			);
		},
	});
}
