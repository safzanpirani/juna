/**
 * Three coding tasks against commander.js v14.0.0. Each one is graded by code,
 * never by the agent's own claim.
 *
 * - fix:     a one-line bug in lib/command.js fails 38 tests; fix it without editing tests.
 * - explain: answer a question that needs reading across a 2,778-line file.
 * - feature: add Command#envPrefix(), checked by a hidden test file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Grade {
	passed: boolean;
	note: string;
}

export interface Task {
	id: string;
	prompt: string;
	/** Break or prepare the workspace before the agent starts. */
	setup?: (dir: string) => void;
	/** `changed` lists files that differ from the state the agent started in. */
	grade: (dir: string, sh: (command: string) => { code: number; out: string }, changed: (paths: string) => string[]) => Grade;
}

/** Run Jest, and once more on failure: a few commander tests are timing-sensitive under load. */
const suite = (sh: (command: string) => { code: number; out: string }) => {
	let summary = "no summary";
	for (let attempt = 1; attempt <= 2; attempt++) {
		const run = sh("npx jest 2>&1 | tail -6");
		summary = run.out.split("\n").find((line) => line.startsWith("Tests:")) ?? "no summary";
		if (run.code === 0 && !/failed/.test(summary)) return { passed: true, summary: attempt === 1 ? summary : `${summary} (second attempt)` };
	}
	return { passed: false, summary };
};

const HIDDEN_ENV_PREFIX_TEST = `const { Command } = require('../');

describe('envPrefix (hidden benchmark test)', () => {
  afterEach(() => {
    delete process.env.APP_CHEESE_TYPE;
    delete process.env.APP_VERBOSE;
    delete process.env.OTHER_CHEESE;
  });

  test('returns the command for chaining', () => {
    const program = new Command();
    expect(program.envPrefix('APP_')).toBe(program);
  });

  test('an option with a value reads PREFIX + upper snake case long name', () => {
    process.env.APP_CHEESE_TYPE = 'brie';
    const program = new Command();
    program.envPrefix('APP_').option('--cheese-type <type>');
    program.parse([], { from: 'user' });
    expect(program.opts().cheeseType).toBe('brie');
  });

  test('a boolean option is set when the variable is defined', () => {
    process.env.APP_VERBOSE = '1';
    const program = new Command();
    program.envPrefix('APP_').option('--verbose');
    program.parse([], { from: 'user' });
    expect(program.opts().verbose).toBe(true);
  });

  test('the command line wins over the environment', () => {
    process.env.APP_CHEESE_TYPE = 'brie';
    const program = new Command();
    program.envPrefix('APP_').option('--cheese-type <type>');
    program.parse(['--cheese-type', 'cheddar'], { from: 'user' });
    expect(program.opts().cheeseType).toBe('cheddar');
  });

  test('an explicit .env() name wins over the prefix', () => {
    process.env.APP_CHEESE_TYPE = 'brie';
    process.env.OTHER_CHEESE = 'gouda';
    const program = new Command();
    program.envPrefix('APP_');
    program.addOption(program.createOption('--cheese-type <type>').env('OTHER_CHEESE'));
    program.parse([], { from: 'user' });
    expect(program.opts().cheeseType).toBe('gouda');
  });

  test('without a prefix nothing is read', () => {
    process.env.APP_CHEESE_TYPE = 'brie';
    const program = new Command();
    program.option('--cheese-type <type>');
    program.parse([], { from: 'user' });
    expect(program.opts().cheeseType).toBeUndefined();
  });
});
`;

export const TASKS: Task[] = [
	{
		id: "fix",
		prompt:
			"The test suite in this repository fails (run it with `npx jest`). Find the bug in the library source under lib/ and fix it. Do not modify any test files. Finish when the whole suite passes.",
		setup(dir) {
			const path = join(dir, "lib", "command.js");
			const before = readFileSync(path, "utf8");
			const after = before.replace("this.getOptionValue(optionKey) === undefined ||", "this.getOptionValue(optionKey) !== undefined ||");
			if (after === before) throw new Error("fix task: mutation target not found");
			writeFileSync(path, after);
		},
		grade(_dir, sh, changed) {
			const tests = suite(sh);
			const touched = changed("tests typings");
			if (touched.length) return { passed: false, note: `edited tests: ${touched.join(", ")}` };
			return { passed: tests.passed, note: tests.summary };
		},
	},
	{
		id: "explain",
		prompt:
			"When a user passes a command-line option that the program never defined, how does commander decide whether that is an error? Name the methods in lib/command.js involved, in the order they run, and every public API setting that changes the behaviour. Write the answer to ANSWER.md in the repository root. Do not change any other file.",
		grade(dir, _sh, changed) {
			const path = join(dir, "ANSWER.md");
			if (!existsSync(path)) return { passed: false, note: "no ANSWER.md" };
			const answer = readFileSync(path, "utf8");
			const required = ["unknownOption", "allowUnknownOption", "parseOptions", "passThroughOptions"];
			const missing = required.filter((word) => !answer.includes(word));
			const touched = changed("lib tests typings");
			if (touched.length) return { passed: false, note: `changed files: ${touched.join(", ")}` };
			return { passed: missing.length === 0, note: missing.length ? `missing: ${missing.join(", ")}` : `all ${required.length} named` };
		},
	},
	{
		id: "feature",
		prompt:
			"Add a chainable `envPrefix(prefix)` method to Command. After `program.envPrefix('APP_')`, every option that has no explicit `.env()` reads its value from the environment variable named by the prefix plus the option's long name in upper snake case, so `--cheese-type` reads `APP_CHEESE_TYPE`. It must follow the same priority rules as `.env()`: the command line wins over the environment. Add tests for it, add it to typings/index.d.ts, and make sure the whole suite passes.",
		grade(dir, sh) {
			writeFileSync(join(dir, "tests", "zz-hidden-envprefix.test.js"), HIDDEN_ENV_PREFIX_TEST);
			const hidden = sh("npx jest tests/zz-hidden-envprefix.test.js 2>&1 | tail -6");
			// The hidden file is deterministic, so it gets no retry.
			const hiddenSummary = hidden.out.split("\n").find((line) => line.startsWith("Tests:")) ?? "no summary";
			const tests = suite(sh);
			const typed = readFileSync(join(dir, "typings", "index.d.ts"), "utf8").includes("envPrefix");
			const passed = hidden.code === 0 && tests.passed && typed;
			return { passed, note: `hidden ${hiddenSummary}; suite ${tests.summary}; typings ${typed ? "yes" : "no"}` };
		},
	},
];
