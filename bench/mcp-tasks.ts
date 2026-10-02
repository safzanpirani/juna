/**
 * Tasks for the MCP suite. The agent reaches six local MCP servers (48 tools)
 * through juna's MCP client; bench/mcp/servers.ts holds their state in the
 * workspace, so every grade reads what the servers recorded, never the agent's
 * own claim. `control` needs no MCP at all: it measures what having the
 * servers configured costs a task that never uses them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ISSUES, revenueLeader, type Issue } from "./mcp/data.ts";
import type { Grade, Task } from "./tasks.ts";

function issues(dir: string): Issue[] {
	const path = join(dir, "tracker-state.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Issue[]) : structuredClone(ISSUES);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The seeded issues other than `except`, unchanged. */
function othersUntouched(state: Issue[], except: number[]): string | undefined {
	for (const seed of ISSUES) {
		if (except.includes(seed.id)) continue;
		const now = state.find((issue) => issue.id === seed.id);
		if (!now || !same(now, seed)) return `issue #${seed.id} was changed`;
	}
	return undefined;
}

export const MCP_TASKS: Task[] = [
	{
		id: "triage",
		mcp: true,
		prompt:
			"Users report that the login page times out. Find the open issue for this problem in the issue tracker, add the labels bug and p1 to it, assign it to Priya from the platform team, and add the comment \"Reproduced on staging\". Do not change any other issue.",
		grade(dir): Grade {
			const state = issues(dir);
			const target = state.find((issue) => issue.id === 10)!;
			const problems: string[] = [];
			if (!target.labels.includes("bug") || !target.labels.includes("p1")) problems.push(`labels ${JSON.stringify(target.labels)}`);
			if (target.assignee !== "priya.n") problems.push(`assignee ${target.assignee}`);
			if (!target.comments.some((comment) => /reproduced on staging/i.test(comment.body))) problems.push("no comment");
			const other = othersUntouched(state, [10]);
			if (other) problems.push(other);
			if (state.length !== ISSUES.length) problems.push(`${state.length - ISSUES.length} issues created`);
			return { passed: problems.length === 0, note: problems.join("; ") || "issue #10 triaged" };
		},
	},
	{
		id: "revenue",
		mcp: true,
		prompt:
			"Using the analytics warehouse, find which customer had the highest total order value for orders placed in 2025. Only orders with status paid count. Write exactly two lines to ANSWER.md: `customer: <customer name>` and `total: <amount with two decimals>`.",
		grade(dir): Grade {
			const path = join(dir, "ANSWER.md");
			if (!existsSync(path)) return { passed: false, note: "no ANSWER.md" };
			const body = readFileSync(path, "utf8");
			const expected = revenueLeader();
			const customer = /customer:\s*(.+)/i.exec(body)?.[1]?.trim();
			const total = Number(/total:\s*\$?([\d,.]+)/i.exec(body)?.[1]?.replace(/,/g, ""));
			const passed = customer === expected.name && Math.abs(total - expected.total) < 0.005;
			return { passed, note: passed ? `${customer} ${total}` : `got ${customer} ${total}, want ${expected.name} ${expected.total}` };
		},
	},
	{
		id: "runbook",
		mcp: true,
		prompt:
			"Our wiki has a runbook for rotating the API signing key. Open a new issue in the tracker titled \"Rotate API signing key\" whose body lists every step of the current runbook, in order, and assign it to the on-call owner the runbook names.",
		grade(dir): Grade {
			const state = issues(dir);
			const created = state.filter((issue) => issue.id > ISSUES.length && /^rotate api signing key$/i.test(issue.title.trim()));
			if (created.length !== 1) return { passed: false, note: `${created.length} matching issues` };
			const issue = created[0]!;
			const problems: string[] = [];
			if (issue.assignee !== "marcus.c") problems.push(`assignee ${issue.assignee}`);
			const body = issue.body.toLowerCase();
			const steps = ["ed25519", "publish", "30 minutes", "switch", "24 hours", "revoke"];
			let last = -1;
			for (const step of steps) {
				const at = body.indexOf(step, last + 1);
				if (at === -1) {
					problems.push(`step "${step}" missing or out of order`);
					break;
				}
				last = at;
			}
			if (/rotate\.sh|restart all api pods/.test(body)) problems.push("copied the superseded runbook");
			const other = othersUntouched(state, []);
			if (other) problems.push(other);
			return { passed: problems.length === 0, note: problems.join("; ") || `issue #${issue.id} created` };
		},
	},
	{
		id: "control",
		mcp: false,
		prompt: "Write a Python script primes.py that prints the first 20 prime numbers, one per line, then run it to check the output.",
		grade(dir, sh): Grade {
			if (!existsSync(join(dir, "primes.py"))) return { passed: false, note: "no primes.py" };
			const run = sh("python3 primes.py");
			const want = "2 3 5 7 11 13 17 19 23 29 31 37 41 43 47 53 59 61 67 71";
			const got = run.out.trim().split(/\s+/).join(" ");
			return { passed: run.code === 0 && got === want, note: got === want ? "20 primes" : `got ${got.slice(0, 80)}` };
		},
	},
];

/** Short server descriptions for Pi's mcp_servers prompt section and tool search, as a user would write them. */
export const SERVER_DESCRIPTIONS: Record<string, string> = {
	tracker: "project issue tracker: issues, labels, assignees, comments",
	wiki: "company wiki: runbooks and docs",
	warehouse: "analytics SQL warehouse: customers and orders",
	calendar: "calendar events and invitations",
	mail: "email",
	chat: "team chat channels",
};
