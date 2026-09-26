/**
 * A Pi extension that captures the exact provider payload for turn 0, then
 * exits before the request is sent. No model call, no tokens spent.
 *
 * Loaded by scripts/context-report.ts with `-e`. Only the payload is recorded:
 * `before_agent_start` would report this extension's own position in the
 * handler chain rather than the final prompt, and the payload is what actually
 * goes on the wire.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	const path = process.env.JUNA_DUMP_PATH;
	if (!path) throw new Error("JUNA_DUMP_PATH is required for the capture subprocess.");

	pi.on("before_provider_request", (event) => {
		try {
			writeFileSync(path, JSON.stringify({ payload: event.payload }, null, 2), { mode: 0o600 });
		} catch {
			// Pi catches hook exceptions and continues to the provider, so throwing is unsafe here.
			process.exit(1);
		}
		// Exit before the request leaves the machine.
		process.exit(0);
	});
}
