import { describe, expect, test } from "bun:test";

import { fingerprint, OutputMemory, repeatMarker } from "../extensions/dedup.ts";

describe("OutputMemory", () => {
	test("the first sighting is not a repeat", () => {
		const memory = new OutputMemory();
		expect(memory.remember("read", "hello")).toBeUndefined();
	});

	test("identical bytes from the same tool are a repeat", () => {
		const memory = new OutputMemory();
		memory.remember("read", "a\nb\nc");
		expect(memory.remember("read", "a\nb\nc")).toEqual({ call: 1, tool: "read", lines: 3 });
	});

	test("the same bytes from a different tool are not a repeat", () => {
		const memory = new OutputMemory();
		memory.remember("read", "same");
		expect(memory.remember("bash", "same")).toBeUndefined();
	});

	test("a changed file is not a repeat", () => {
		const memory = new OutputMemory();
		memory.remember("read", "version 1");
		expect(memory.remember("read", "version 2")).toBeUndefined();
	});

	test("remembers each distinct output once", () => {
		const memory = new OutputMemory();
		for (const text of ["a", "b", "a", "b", "c"]) memory.remember("read", text);
		expect(memory.size).toBe(3);
	});
});

describe("fingerprint", () => {
	test("is stable and tool-scoped", () => {
		expect(fingerprint("read", "x")).toBe(fingerprint("read", "x"));
		expect(fingerprint("read", "x")).not.toBe(fingerprint("bash", "x"));
	});

	test("does not collide when the tool name runs into the output", () => {
		expect(fingerprint("read", "er")).not.toBe(fingerprint("reader", ""));
	});
});

describe("repeatMarker", () => {
	test("names the tool and says where to look", () => {
		const marker = repeatMarker({ call: 2, tool: "bash", lines: 1 });
		expect(marker).toContain("bash");
		expect(marker).toContain("1 line)");
		expect(marker).toContain("Scroll up");
	});
});

test("memory is bounded and can reset after history changes", () => {
	const memory = new OutputMemory(2);
	for (const text of ["a", "b", "c"]) memory.remember("read", text);
	expect(memory.size).toBe(2);
	expect(memory.lookup("read", "a")).toBeUndefined();
	expect(memory.lookup("read", "c")).toBeDefined();
	memory.clear();
	expect(memory.size).toBe(0);
});
