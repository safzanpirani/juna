import { describe, expect, test } from "bun:test";

import { spill, truncateMiddle } from "../extensions/spill.ts";
import { uselessNotice } from "../extensions/useless.ts";

const options = { threshold: 1000, headChars: 200, tailChars: 200 };

describe("truncateMiddle", () => {
	test("leaves text that already fits", () => {
		const result = truncateMiddle("short", options);
		expect(result.text).toBe("short");
		expect(result.droppedChars).toBe(0);
	});

	test("keeps the head and the tail", () => {
		const text = `${"a".repeat(500)}\n${"b".repeat(500)}\n${"c".repeat(500)}`;
		const result = truncateMiddle(text, options);
		expect(result.text.startsWith("a")).toBe(true);
		expect(result.text.endsWith("c".repeat(100))).toBe(true);
		expect(result.droppedChars).toBeGreaterThan(0);
	});
});

describe("spill", () => {
	test("passes small output through without writing", () => {
		let wrote = false;
		const result = spill("small", "bash", "s1", 1, options, () => {
			wrote = true;
		});
		expect(result.text).toBe("small");
		expect(result.path).toBeUndefined();
		expect(wrote).toBe(false);
	});

	test("writes the whole output and points at it", () => {
		const text = "x".repeat(5000);
		const written: { path: string; contents: string }[] = [];
		const result = spill(text, "bash", "s1", 3, options, (path, contents) =>
			written.push({ path, contents }),
		);
		expect(written).toHaveLength(1);
		expect(written[0]!.contents).toBe(text);
		expect(written[0]!.path).toContain("3-bash.txt");
		expect(result.text).toContain(result.path!);
		expect(result.text.length).toBeLessThan(text.length);
	});

	test("preserves the original when the write fails", () => {
		const result = spill("x".repeat(5000), "bash", "s1", 1, options, () => {
			throw new Error("disk full");
		});
		expect(result.path).toBeUndefined();
		expect(result.text).toBe("x".repeat(5000));
		expect(result.failed).toBe(true);
	});
});

describe("uselessNotice", () => {
	test("replaces a no-match search with one line", () => {
		const notice = uselessNotice("grep", "       No matches found       ");
		expect(notice).toBe("[juna: grep found nothing.]");
	});

	test("leaves an empty result alone, since silence is already free", () => {
		expect(uselessNotice("bash", "   \n ")).toBeUndefined();
	});

	test("leaves a real result alone", () => {
		expect(uselessNotice("grep", "src/a.ts:12: match")).toBeUndefined();
	});

	test("does not grow a result that is already shorter than the notice", () => {
		expect(uselessNotice("grep", "no results found")).toBeUndefined();
	});
});

test("literal sentinels and replacement metacharacters survive spill", () => {
	const text = "%%MIDDLE%%\n" + "x".repeat(5000);
	const result = spill(text, "bash", "s$&$`$'", 1, options, () => {});
	expect(result.text.startsWith("%%MIDDLE%%\n")).toBe(true);
	expect(result.text).toContain(result.path!);
	expect(result.text.match(/juna spilled/g)).toHaveLength(1);
});

test("tail boundary, zero tail, and actual removed length", () => {
	const result = truncateMiddle("aa\nbb\ncc\ndd\nee", { threshold: 1, headChars: 4, tailChars: 5 }, "NOTICE");
	expect(result.text).toBe("aa\n\nNOTICE\ndd\nee");
	expect(result.droppedChars).toBe(6);
	expect(truncateMiddle("abcdef", { threshold: 1, headChars: 2, tailChars: 0 }, "N").text).toBe("ab\nN\n");
});

test("quoted no-match and error phrases never erase real output", () => {
	for (const tool of ["bash", "read", "grep"]) {
		expect(uselessNotice(tool, "a real hit\nno matches found\nmore useful data")).toBeUndefined();
		expect(uselessNotice(tool, "No such file or directory: important/path")).toBeUndefined();
	}
});
