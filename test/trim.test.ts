import { describe, expect, test } from "bun:test";

import { parseTags, trimSections } from "../extensions/trim.ts";

const prompt = [
	"You are an agent.",
	"",
	"<tools>",
	"- bash",
	"</tools>",
	"",
	"<docs>",
	"read the manual",
	"</docs>",
	"",
	"<skills>",
	"<available_skills>",
	"  many skills",
	"</available_skills>",
	"</skills>",
	"",
	"<cwd>",
	"/tmp",
	"</cwd>",
].join("\n");

describe("trimSections", () => {
	test("removes a section and keeps its neighbours separated", () => {
		const result = trimSections(prompt, ["docs"]);
		expect(result.prompt).not.toContain("read the manual");
		expect(result.prompt).toContain("</tools>\n\n<skills>");
		// The count covers the blank lines the section took with it.
		expect(result.removed).toEqual([{ tag: "docs", bytes: "<docs>\nread the manual\n</docs>".length + 2 }]);
	});

	test("removes a nested catalog with its wrapper", () => {
		const result = trimSections(prompt, ["skills"]);
		expect(result.prompt).not.toContain("available_skills");
		expect(result.prompt).toContain("<cwd>");
	});

	test("is idempotent, so chaining after another stripper is safe", () => {
		const once = trimSections(prompt, ["skills", "docs"]).prompt;
		const twice = trimSections(once, ["skills", "docs"]);
		expect(twice.prompt).toBe(once);
		expect(twice.removed).toEqual([]);
	});

	test("is deterministic across calls, which is what keeps the cache alive", () => {
		expect(trimSections(prompt, ["skills"]).prompt).toBe(trimSections(prompt, ["skills"]).prompt);
	});

	test("skips an unclosed or absent tag", () => {
		expect(trimSections("<open>\nno end", ["open"]).prompt).toBe("<open>\nno end");
		expect(trimSections(prompt, ["nope"]).removed).toEqual([]);
	});

	test("leading section removal does not leave a blank head", () => {
		const result = trimSections("<a>\nx\n</a>\n\nrest", ["a"]);
		expect(result.prompt).toBe("rest");
	});
});

describe("parseTags", () => {
	test("falls back when unset and tolerates angle brackets", () => {
		expect(parseTags(undefined, ["skills"])).toEqual(["skills"]);
		expect(parseTags("<docs>, skills ,", ["x"])).toEqual(["docs", "skills"]);
		expect(parseTags("", ["skills"])).toEqual([]);
	});
});
