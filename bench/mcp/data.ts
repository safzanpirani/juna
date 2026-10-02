/**
 * Seed data for the MCP benchmark servers. Deterministic, so every run starts
 * from the same state and the graders can compute the right answer.
 */

export interface User {
	username: string;
	name: string;
	team: string;
}

export interface Comment {
	author: string;
	body: string;
}

export interface Issue {
	id: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: string[];
	assignee: string | null;
	comments: Comment[];
	created: string;
}

export const USERS: User[] = [
	{ username: "priya.n", name: "Priya Nair", team: "platform" },
	{ username: "priyanka.s", name: "Priyanka Sharma", team: "design" },
	{ username: "marcus.c", name: "Marcus Chen", team: "security" },
	{ username: "dana.w", name: "Dana Whitfield", team: "platform" },
	{ username: "omar.f", name: "Omar Farouk", team: "support" },
	{ username: "lena.k", name: "Lena Kowalski", team: "growth" },
];

export const LABELS = ["bug", "p1", "p2", "p3", "feature", "design", "security", "docs", "needs-info", "wontfix"];

const issue = (id: number, title: string, body: string, state: Issue["state"], labels: string[], assignee: string | null, created: string): Issue => ({
	id, title, body, state, labels, assignee, comments: [], created,
});

export const ISSUES: Issue[] = [
	issue(1, "Dark mode colours are too low-contrast on settings", "Several settings labels fail WCAG AA in dark mode.", "open", ["design"], "priyanka.s", "2026-06-02"),
	issue(2, "Export to CSV drops the last row", "When exporting a report with more than 100 rows the final row is missing.", "open", ["bug", "p2"], "dana.w", "2026-06-11"),
	issue(3, "Add SSO login via Okta", "Enterprise customers want Okta SSO.", "open", ["feature"], null, "2026-06-15"),
	issue(4, "Login page times out on slow networks", "Old report from the 2025 infra. Fixed by raising the gateway timeout.", "closed", ["bug"], "dana.w", "2025-11-03"),
	issue(5, "Login button colour does not match brand guide", "The primary login button uses the old blue.", "open", ["design"], null, "2026-07-01"),
	issue(6, "Password reset email arrives twice", "Users report two identical reset emails.", "open", ["bug"], "omar.f", "2026-07-09"),
	issue(7, "Rate limiter returns 500 instead of 429", "Clients cannot back off properly.", "open", ["bug", "p2"], null, "2026-07-20"),
	issue(8, "Document webhook retry policy", "The docs do not say how often webhooks retry.", "open", ["docs"], "lena.k", "2026-08-01"),
	issue(9, "Session cookie missing SameSite attribute", "Security review finding.", "open", ["security"], "marcus.c", "2026-08-04"),
	issue(10, "Sign-in page hangs, then times out, for users on the EU cluster", "Since the 2026-09 deploy, the sign-in page spins for 30 s and then shows a gateway timeout. Affects roughly 8% of EU logins.", "open", [], null, "2026-09-18"),
	issue(11, "Search results page slow for large workspaces", "p95 latency above 4 s.", "open", ["p3"], null, "2026-09-19"),
	issue(12, "Typo in onboarding checklist", "\"Recieve\" should be \"Receive\".", "open", ["docs"], null, "2026-09-20"),
];

export interface Page {
	id: string;
	space: string;
	title: string;
	updated: string;
	body: string;
}

export const PAGES: Page[] = [
	{
		id: "ops-104",
		space: "ops",
		title: "Runbook: rotating the API signing key",
		updated: "2026-08-14",
		body: [
			"Owner: the on-call owner for this runbook is Marcus Chen (marcus.c).",
			"",
			"Steps:",
			"1. Generate a new Ed25519 key pair in the vault under signing/next.",
			"2. Publish the new public key to the JWKS endpoint alongside the current key.",
			"3. Wait 30 minutes for edge caches to pick up the new JWKS.",
			"4. Switch the token service to sign with signing/next.",
			"5. After 24 hours, remove the old public key from the JWKS endpoint.",
			"6. Revoke the old private key in the vault and record the rotation in the security log.",
		].join("\n"),
	},
	{
		id: "ops-031",
		space: "ops",
		title: "Runbook: rotating the API signing key (2023, superseded)",
		updated: "2023-04-02",
		body: "SUPERSEDED by ops-104. Old RSA procedure: 1. Run rotate.sh. 2. Restart all API pods. Owner: Dana Whitfield.",
	},
	{ id: "ops-120", space: "ops", title: "Runbook: failing over the primary database", updated: "2026-07-30", body: "1. Freeze writes. 2. Promote the replica. 3. Update DNS. Owner: Dana Whitfield (dana.w)." },
	{ id: "eng-12", space: "eng", title: "Coding standards", updated: "2026-05-01", body: "Use TypeScript strict mode. Prefer small modules." },
	{ id: "eng-40", space: "eng", title: "Release process", updated: "2026-06-20", body: "Cut a release branch every Tuesday. Tag with semver." },
	{ id: "sup-7", space: "support", title: "Escalation matrix", updated: "2026-08-22", body: "P1: page on-call. P2: next business day." },
];

export interface Order {
	id: number;
	customer_id: number;
	placed: string;
	status: "paid" | "refunded" | "pending";
	total: number;
}

export const CUSTOMERS = [
	{ id: 1, name: "Acme Robotics", country: "US" },
	{ id: 2, name: "Borealis Foods", country: "CA" },
	{ id: 3, name: "Cobalt Health", country: "DE" },
	{ id: 4, name: "Dunmore Freight", country: "UK" },
	{ id: 5, name: "Everline Studio", country: "IN" },
];

// Built so the obvious mistakes give the wrong answer: counting refunds makes
// Acme the leader, and counting orders outside 2025 makes Dunmore the leader.
export const ORDERS: Order[] = [
	{ id: 1, customer_id: 1, placed: "2025-01-14", status: "paid", total: 4200.0 },
	{ id: 2, customer_id: 1, placed: "2025-03-02", status: "refunded", total: 9800.0 },
	{ id: 3, customer_id: 1, placed: "2025-07-19", status: "paid", total: 3100.5 },
	{ id: 4, customer_id: 2, placed: "2025-02-08", status: "paid", total: 5400.0 },
	{ id: 5, customer_id: 2, placed: "2025-05-21", status: "paid", total: 4990.25 },
	{ id: 6, customer_id: 2, placed: "2025-11-30", status: "pending", total: 1200.0 },
	{ id: 7, customer_id: 3, placed: "2025-04-11", status: "paid", total: 6100.0 },
	{ id: 8, customer_id: 3, placed: "2025-09-05", status: "refunded", total: 2000.0 },
	{ id: 9, customer_id: 4, placed: "2024-12-28", status: "paid", total: 15000.0 },
	{ id: 10, customer_id: 4, placed: "2025-06-17", status: "paid", total: 3300.0 },
	{ id: 11, customer_id: 5, placed: "2025-08-09", status: "paid", total: 2750.75 },
	{ id: 12, customer_id: 5, placed: "2025-10-12", status: "paid", total: 1999.99 },
	{ id: 13, customer_id: 3, placed: "2026-01-04", status: "paid", total: 8000.0 },
];

/** The answer to the revenue task: only paid orders placed in 2025 count. */
export function revenueLeader(): { name: string; total: number } {
	const totals = new Map<number, number>();
	for (const order of ORDERS) {
		if (!order.placed.startsWith("2025") || order.status !== "paid") continue;
		totals.set(order.customer_id, (totals.get(order.customer_id) ?? 0) + order.total);
	}
	const [id, total] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]!;
	return { name: CUSTOMERS.find((customer) => customer.id === id)!.name, total: Math.round(total * 100) / 100 };
}
