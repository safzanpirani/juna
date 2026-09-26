import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import webTools from "../jev-search.ts";
import type { Bridge } from "./runtime.ts";

export interface Receipt {
	tool: string;
	status: "completed" | "failed";
	path?: string;
	diff?: string;
}

export function createBridge(ctx: ExtensionContext, receipts: Receipt[], overridden: Set<string> = new Set()): Bridge {
	// Heterogeneous tool schemas are validated before execution below.
	const available = new Map<string, ToolDefinition<any, any>>();
	for (const create of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]) {
		const tool = create(ctx.cwd);
		available.set(tool.name, tool);
	}
	webTools({ registerTool(tool) { available.set(tool.name, tool); } });
	return async (name, args, signal) => {
		signal.throwIfAborted();
		const tool = available.get(name);
		if (!tool) throw new Error(`Unsupported Python bridge tool: ${name}`);
		if (overridden.has(name)) throw new Error(`${name} is overridden by another extension; call it directly.`);
		if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}; use its documented Pi schema.`);
		const receipt: Receipt = { tool: name, status: "failed" };
		if ((name === "write" || name === "edit") && typeof args.path === "string") receipt.path = args.path;
		receipts.push(receipt);
		const result = await tool.execute(`python-${receipts.length}`, args, signal, undefined, ctx);
		if (result.content.some(part => part.type !== "text")) throw new Error("Python bridge supports text only; read images with the direct read tool.");
		receipt.status = "completed";
		if (result.details && typeof result.details === "object" && "diff" in result.details && typeof result.details.diff === "string") receipt.diff = result.details.diff;
		return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	};
}

export function receiptSummary(receipts: Receipt[]) {
	if (!receipts.length) return "";
	const counts = new Map<string, number>();
	for (const r of receipts) counts.set(`${r.tool} ${r.status}`, (counts.get(`${r.tool} ${r.status}`) ?? 0) + 1);
	const mutations = receipts.filter(r => r.path).map(r => `${r.tool} ${JSON.stringify(r.path)}: ${r.status}`);
	return [`Bridge: ${[...counts].map(([key, count]) => `${key} ×${count}`).join(", ")}`, ...mutations].join("\n");
}
