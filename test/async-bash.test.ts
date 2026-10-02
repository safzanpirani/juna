import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import asyncBash, { PLACEHOLDER, formatHeartbeat } from "../extensions/async-bash.ts";
import { PRUNE_CHANNEL, type PruneRequest } from "../extensions/jev-prune.ts";

type Sent = { content: string; options: Record<string, unknown> | undefined };

function harness(env: Record<string, string> = {}) {
	for (const [key, value] of Object.entries({ JUNA_ASYNC_GRACE_MS: "100", JUNA_ASYNC_HEARTBEAT_MS: "0", ...env })) process.env[key] = value;
	const handlers = new Map<string, (...args: any[]) => any>();
	const sent: Sent[] = [];
	const bus = new EventEmitter();
	let tool: any;
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerTool: (definition: unknown) => { tool = definition; },
		registerCommand() {},
		sendMessage: (message: { content: string }, options?: Record<string, unknown>) => sent.push({ content: message.content, options }),
		events: { emit: (channel: string, data: unknown) => bus.emit(channel, data), on: (channel: string, h: (d: unknown) => void) => { bus.on(channel, h); return () => bus.off(channel, h); } },
	} as unknown as ExtensionAPI;
	asyncBash(pi);
	const state = { idle: false, pending: false, abort: new AbortController() };
	const ctx = {
		cwd: process.cwd(),
		ui: { setStatus() {}, notify() {} },
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		get signal() { return state.abort.signal; },
	};
	const run = (id: string, command: string) => tool.execute(id, { command }, undefined, undefined, ctx);
	const endTurn = (withCalls: boolean) =>
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: withCalls ? "toolUse" : "stop", content: withCalls ? [{ type: "toolCall" }] : [{ type: "text", text: "waiting" }] } }, ctx);
	return { handlers, sent, bus, run, endTurn, state, ctx };
}

afterEach(() => {
	for (const key of ["JUNA_ASYNC_GRACE_MS", "JUNA_ASYNC_HEARTBEAT_MS"]) delete process.env[key];
});

test("a call inside the grace window returns the built-in result, errors included", async () => {
	const h = harness({ JUNA_ASYNC_GRACE_MS: "5000" });
	const result = await h.run("a", "echo hi");
	expect(result.content[0].text.trim()).toBe("hi");
	const failed = await h.run("b", "echo oops; exit 3");
	expect(failed.isError).toBe(true);
	expect(failed.content[0].text).toContain("Command exited with code 3");
	expect(h.sent).toHaveLength(0);
});

test("a codemode script's bash call is never detached", async () => {
	const h = harness();
	const result = await h.run("script/1", "sleep 0.3; echo whole");
	expect(result.content[0].text.trim()).toBe("whole");
	expect(h.sent).toHaveLength(0);
});

test("a slow call that exits nonzero arrives as failed", async () => {
	const h = harness();
	await h.run("bad", "sleep 0.3; echo oops; exit 3");
	await h.endTurn(false);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.content).toContain('<bash_result tool_call_id="bad" status="failed"');
	expect(h.sent[0]!.content).toContain("Command exited with code 3");
});

test("a slow call returns a placeholder, and a held turn continues with its result", async () => {
	const h = harness();
	const result = await h.run("slow", "sleep 0.4; echo finished");
	expect(result.content[0].text).toBe(PLACEHOLDER);
	const started = Date.now();
	await h.endTurn(false);
	expect(Date.now() - started).toBeGreaterThan(150);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.options).toEqual({ deliverAs: "steer" });
	expect(h.sent[0]!.content).toContain('<bash_result tool_call_id="slow" status="ok"');
	expect(h.sent[0]!.content).toContain("finished");
});

test("results that land together arrive in one message at the next turn boundary", async () => {
	const h = harness();
	await Promise.all([h.run("x", "sleep 0.2; echo one"), h.run("y", "sleep 0.25; echo two")]);
	await Bun.sleep(500);
	await h.endTurn(true);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.content).toContain("one");
	expect(h.sent[0]!.content).toContain("two");
});

test("a turn that called tools is never held", async () => {
	const h = harness();
	await h.run("slow", "sleep 1; echo late");
	const started = Date.now();
	await h.endTurn(true);
	expect(Date.now() - started).toBeLessThan(100);
	expect(h.sent).toHaveLength(0);
	await h.endTurn(false);
	expect(h.sent[0]!.content).toContain("late");
});

test("late output goes through jev-prune when it listens", async () => {
	const h = harness();
	h.bus.on(PRUNE_CHANNEL, (data) => {
		const request = data as PruneRequest;
		expect(request.event.input.command).toContain("echo raw");
		request.reply(Promise.resolve({ content: [{ type: "text", text: "pruned text" }] }));
	});
	await h.run("p", "sleep 0.2; echo raw");
	await h.endTurn(false);
	expect(h.sent[0]!.content).toContain("pruned text");
	expect(h.sent[0]!.content).not.toContain("\nraw\n");
});

test("user input releases a held turn without delivering", async () => {
	const h = harness();
	await h.run("slow", "sleep 1");
	h.state.pending = true;
	const started = Date.now();
	await h.endTurn(false);
	expect(Date.now() - started).toBeLessThan(400);
	expect(h.sent).toHaveLength(0);
});

test("the heartbeat wakes a held turn that has waited too long", async () => {
	const h = harness({ JUNA_ASYNC_HEARTBEAT_MS: "300" });
	await h.run("hb", "sleep 2");
	await h.endTurn(false);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.content).toStartWith("Heartbeat:");
	expect(h.sent[0]!.content).toContain("hb");
	h.handlers.get("session_shutdown")!();
});

test("after an abort, a result lands as context for the next prompt, not a new turn", async () => {
	const h = harness();
	await h.run("ab", "sleep 0.3; echo done");
	h.state.abort.abort();
	await h.endTurn(false);
	expect(h.sent).toHaveLength(0);
	h.state.idle = true;
	h.handlers.get("agent_end")!({}, h.ctx);
	await Bun.sleep(600);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
});

test("a result finishing while idle starts a new turn", async () => {
	const h = harness();
	await h.run("idle", "sleep 0.3; echo woke");
	h.handlers.get("before_agent_start")!({ systemPrompt: "" });
	h.state.idle = true;
	h.handlers.get("agent_end")!({}, h.ctx);
	await Bun.sleep(600);
	expect(h.sent[0]!.options).toEqual({ triggerTurn: true });
	expect(h.sent[0]!.content).toContain("woke");
});

test("instructions are appended once and the heartbeat lists running calls", () => {
	const h = harness();
	const first = h.handlers.get("before_agent_start")!({ systemPrompt: "base" });
	expect(first.systemPrompt).toContain("<juna_async>");
	expect(h.handlers.get("before_agent_start")!({ systemPrompt: first.systemPrompt })).toBeUndefined();
	const text = formatHeartbeat(600_000, [{ callId: "c1", command: "make", startedAt: 0, abort: new AbortController() }], 700_000);
	expect(text).toContain("600s");
	expect(text).toContain("c1 (700s): make");
});
