import { beforeEach, describe, expect, test } from "bun:test";

import { render, renderTps } from "../extensions/jev-meter.ts";
import { addSaved, resetSaved, totalSaved } from "../extensions/savings.ts";

describe("render", () => {
	// The savings counter is shared across the process, so each case owns it.
	beforeEach(() => resetSaved());

	test("reports the real context size, not just the uncached part", () => {
		expect(render({ fresh: 200, cached: 1920 })).toBe("ctx 2.1k = 200 new + 1.9k cached (91%)");
	});

	test("a first turn has nothing cached", () => {
		expect(render({ fresh: 2005, cached: 0 })).toBe("ctx 2.0k = 2.0k new + 0 cached (0%)");
	});

	test("rounds hard at ten thousand, where a decimal stops helping", () => {
		expect(render({ fresh: 1000, cached: 25_000 })).toBe("ctx 26k = 1.0k new + 25k cached (96%)");
	});

	test("says nothing when there is nothing to say", () => {
		expect(render({ fresh: 0, cached: 0 })).toBe("");
	});

	test("appends what juna has saved, once there is any", () => {
		addSaved(8000);
		expect(render({ fresh: 200, cached: 1920 })).toContain("juna −2.0k tok");
	});
});

describe("savings", () => {
	beforeEach(() => resetSaved());

	test("accumulates", () => {
		addSaved(100);
		addSaved(50);
		expect(totalSaved()).toBe(150);
	});

	test("ignores nonsense rather than corrupting the tally", () => {
		addSaved(-5);
		addSaved(Number.NaN);
		expect(totalSaved()).toBe(0);
	});

	test("hands the value back so callers can tally inline", () => {
		expect(addSaved(42)).toBe(42);
	});
});

describe("renderTps", () => {
	test("reports tokens per second", () => {
		expect(renderTps(500, 5000)).toBe("100 tok/s");
	});

	test("rounds to a whole number", () => {
		expect(renderTps(100, 3000)).toBe("33 tok/s");
	});

	test("says nothing for a burst too short to time", () => {
		expect(renderTps(40, 20)).toBe("");
	});

	test("says nothing with no tokens", () => {
		expect(renderTps(0, 5000)).toBe("");
	});
});
