import { describe, expect, test } from "bun:test";

import { digest, failureHead, isRunner, OUTCOME_ID, REPEAT_ID, verdictLine, verifyQuestions } from "../extensions/verify.ts";

describe("isRunner", () => {
	test("recognises the common runners", () => {
		for (const command of [
			"bun test",
			"bun run check",
			"npm test -- --watch=false",
			"pnpm run lint",
			"pytest -q tests/",
			"cargo test --all",
			"go test ./...",
			"npx tsc --noEmit",
			"make check",
			"mvn verify",
		]) {
			expect(isRunner(command)).toBe(true);
		}
	});

	test("leaves ordinary commands alone", () => {
		for (const command of ["ls -la", "cat package.json", "git status", "rg testing src/", "echo build"]) {
			expect(isRunner(command)).toBe(false);
		}
	});
});

describe("verifyQuestions", () => {
	test("asks only the outcome when there is no earlier failure", () => {
		const questions = verifyQuestions("bun test", "ok 1\nok 2");
		expect(Object.keys(questions)).toEqual([OUTCOME_ID]);
		expect((questions[OUTCOME_ID] as { type: string }).type).toBe("choice");
		expect(Object.keys((questions[OUTCOME_ID] as { criteria: object }).criteria)).toEqual([
			"passed",
			"failed",
			"did_not_run",
			"mixed",
		]);
	});

	test("asks whether a failure repeats when one is remembered", () => {
		const questions = verifyQuestions("bun test", "1 fail", "AssertionError: expected 2 to be 3");
		expect(Object.keys(questions)).toContain(REPEAT_ID);
		expect(JSON.stringify(questions[REPEAT_ID])).toContain("expected 2 to be 3");
	});
});

describe("verdictLine", () => {
	const confident = { minConfidence: 0.55 };

	test("states a pass and a failure plainly", () => {
		expect(verdictLine({ [OUTCOME_ID]: { choice: "passed", confidence: 0.9 } }, confident)).toBe("[juna: passed]");
		expect(verdictLine({ [OUTCOME_ID]: { choice: "failed", confidence: 0.9 } }, confident)).toBe("[juna: FAILED]");
		expect(verdictLine({ [OUTCOME_ID]: { choice: "did_not_run", confidence: 0.9 } }, confident)).toBe(
			"[juna: did not run]",
		);
	});

	test("says nothing when Jev is not confident", () => {
		expect(verdictLine({ [OUTCOME_ID]: { choice: "failed", confidence: 0.2 } }, confident)).toBeUndefined();
	});

	test("says nothing when there is no usable answer", () => {
		expect(verdictLine({}, confident)).toBeUndefined();
		expect(verdictLine({ [OUTCOME_ID]: { choice: "nonsense", confidence: 1 } }, confident)).toBeUndefined();
	});

	test("notes a repeated failure, but never on a pass", () => {
		const repeat = { [REPEAT_ID]: { noul: 0.95 } };
		expect(verdictLine({ [OUTCOME_ID]: { choice: "failed", confidence: 0.9 }, ...repeat }, confident)).toBe(
			"[juna: FAILED, same failure as before]",
		);
		expect(verdictLine({ [OUTCOME_ID]: { choice: "passed", confidence: 0.9 }, ...repeat }, confident)).toBe(
			"[juna: passed]",
		);
	});

	test("a weak repeat signal is not reported as a repeat", () => {
		const answers = { [OUTCOME_ID]: { choice: "failed", confidence: 0.9 }, [REPEAT_ID]: { noul: 0.4 } };
		expect(verdictLine(answers, confident)).toBe("[juna: FAILED]");
	});
});

describe("failureHead", () => {
	test("starts at the first failing line", () => {
		const head = failureHead("Running 40 tests\nok 1\nok 2\nFAIL src/a.test.ts\n  expected 2 to be 3\ndone");
		expect(head).toContain("FAIL src/a.test.ts");
		expect(head).not.toContain("Running 40 tests");
	});

	test("falls back to the first lines when nothing looks like a failure", () => {
		expect(failureHead("one\ntwo\nthree\nfour")).toBe("one\ntwo\nthree");
	});

	test("returns nothing for empty output", () => {
		expect(failureHead("   \n  ")).toBeUndefined();
	});
});

describe("digest", () => {
	test("passes short output through whole", () => {
		expect(digest("short run", 100)).toBe("short run");
	});

	test("keeps the head and the tail, where the verdict lives", () => {
		const text = `${"H".repeat(500)}${"M".repeat(2000)}${"T".repeat(500)}`;
		const out = digest(text, 200);
		expect(out.startsWith("H")).toBe(true);
		expect(out.endsWith("T")).toBe(true);
		expect(out).toContain("middle omitted");
		expect(out).not.toContain("M".repeat(50));
	});
});
