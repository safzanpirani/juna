import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBridge, receiptSummary, type Receipt } from "./bridge.ts";
import { PYTHON_INSTRUCTIONS } from "./instructions.ts";
import { PythonRuntime } from "./runtime.ts";

/** Loaded only by juna --codemode (or an explicit -e). No kernel until first use. */
export default function (pi: ExtensionAPI) {
	const runtime = new PythonRuntime();
	pi.on("before_agent_start", event => {
		if (!pi.getActiveTools().includes("python")) return;
		return { systemPrompt: event.systemPrompt.includes("<juna_python>") ? event.systemPrompt : event.systemPrompt + "\n" + PYTHON_INSTRUCTIONS };
	});
	pi.on("session_shutdown", () => { runtime.reset("session ended"); });
	pi.on("session_start", (_event, ctx) => {
		const identity = ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId();
		const key = createHash("sha256").update(identity).digest("hex");
		runtime.useSession(join(process.env.JUNA_DIR || join(homedir(), ".pi/juna"), "python-state", key));
	});
	pi.on("session_tree", () => {
		pi.sendMessage({ customType: "python-state", content: "Python retains the latest state for this session. Tree navigation does not rewind Python state, files, or external effects.", display: true }, { deliverAs: "nextTurn" });
	});
	pi.registerCommand("python-reset", {
		description: "Clear the Python namespace and stop its process",
		async handler(_args, ctx) {
			if (!ctx.isIdle()) { ctx.ui.notify("Stop the active turn before resetting Python.", "warning"); return; }
			runtime.clear();
			await runtime.run("", ctx.cwd, async () => { throw new Error("No bridge during reset"); });
			pi.sendMessage({ customType: "python-state", content: "Python namespace cleared and checkpointed by /python-reset. Files and external effects remain.", display: true }, { deliverAs: "nextTurn" });
		},
	});
	pi.registerTool({
		name: "python",
		label: "Python",
		description: "Run Python with top-level await and tools helpers. State is checkpointed across restart/resume. Print selected output; keep large data in variables. Interrupted cells restore the last checkpoint without replay. reset=true explicitly clears the namespace.",
		promptSnippet: "Execute persistent Python for batching, data processing and multi-step work",
		parameters: Type.Object({
			code: Type.String({ description: "Python statements. Use print() for results; top-level await is supported." }),
			timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Cell timeout in seconds (default 120)." })),
			reset: Type.Optional(Type.Boolean({ description: "Clear previous Python state before running this cell." })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (params.reset) runtime.clear();
			const receipts: Receipt[] = [];
			const overridden = new Set(pi.getAllTools().filter(t =>
				["read", "write", "edit", "bash", "grep", "find", "ls"].includes(t.name) && t.sourceInfo.source !== "builtin",
			).map(t => t.name));
			try {
				const result = await runtime.run(params.code, ctx.cwd, createBridge(ctx, receipts, overridden), signal, (params.timeout ?? 120) * 1000);
				return { content: [{ type: "text", text: [result.text, receiptSummary(receipts)].filter(Boolean).join("\n\n") }], details: { generation: result.generation, receipts } };
			} catch (error) {
				throw new Error([error instanceof Error ? error.message : String(error), receiptSummary(receipts)].filter(Boolean).join("\n\n"));
			}
		},
		renderResult(result, { expanded }) {
			const text = result.content.filter(p => p.type === "text").map(p => p.text).join("\n");
			const receipts = (result.details as { receipts?: Receipt[] } | undefined)?.receipts ?? [];
			const diffs = expanded ? receipts.filter(r => r.diff).map(r => `${r.path}\n${r.diff}`).join("\n") : "";
			return new Text([text, diffs].filter(Boolean).join("\n"), 0, 0);
		},
	});
}
