#!/usr/bin/env bun
/**
 * MCP servers for the MCP benchmark: `bun bench/mcp/servers.ts <name>`.
 *
 * tracker, wiki and the three distractor servers (calendar, mail, chat) speak
 * the stateless 2026-07-28 protocol. warehouse speaks the legacy handshake, as
 * most servers still do. Tool descriptions are as wordy as real servers' are,
 * because that wording is what juna's compaction and search are meant to cut.
 *
 * State lives in the working directory (the benchmark workspace), so graders
 * can read what the agent did: tracker writes `tracker-state.json`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CUSTOMERS, ISSUES, LABELS, ORDERS, PAGES, USERS, type Issue } from "./data.ts";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (value: unknown): Text => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string): Text => ({ content: [{ type: "text", text: message }], isError: true });

type Register = (name: string, description: string, shape: z.ZodRawShape, handler: (args: any) => Text | Promise<Text>, readOnly?: boolean) => void;

// ---------------------------------------------------------------- tracker

const STATE = join(process.cwd(), "tracker-state.json");
const loadIssues = (): Issue[] => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : structuredClone(ISSUES));
const saveIssues = (issues: Issue[]) => writeFileSync(STATE, JSON.stringify(issues, null, 2));
const withIssue = (id: number, change: (issue: Issue) => void): Text => {
	const issues = loadIssues();
	const found = issues.find((issue) => issue.id === id);
	if (!found) return fail(`Issue #${id} does not exist.`);
	change(found);
	saveIssues(issues);
	return reply(found);
};
const userExists = (username: string) => USERS.some((user) => user.username === username);

function tracker(tool: Register) {
	tool("list_issues", "List issues in the project issue tracker. Returns issue number, title, state, labels, assignee and creation date for each matching issue. Results can be filtered by state (open or closed), by a single label, or by assignee username. Results are sorted by issue number ascending. Use this to browse issues; to find issues by words in their title or body use search_issues instead, which performs a case-insensitive full-text match.", {
		state: z.enum(["open", "closed", "all"]).optional().describe("Filter by issue state. Defaults to open. Use all to include closed issues."),
		label: z.string().optional().describe("Only return issues carrying this label name, for example bug or p1."),
		assignee: z.string().optional().describe("Only return issues assigned to this username, for example dana.w."),
		limit: z.number().int().optional().describe("Maximum number of issues to return. Defaults to 50."),
	}, ({ state = "open", label, assignee, limit = 50 }) =>
		reply(loadIssues().filter((issue) => (state === "all" || issue.state === state) && (!label || issue.labels.includes(label)) && (!assignee || issue.assignee === assignee)).slice(0, limit).map(({ comments: _c, body: _b, ...rest }) => rest)), true);
	tool("search_issues", "Search issues by free text. Performs a case-insensitive match of every word in the query against issue titles and bodies, across open and closed issues, and returns the matching issues with their number, title, state, labels and assignee. Words are matched independently, so the query 'login timeout' matches issues mentioning both words anywhere. Prefer this over list_issues when you know what an issue is about but not its number.", {
		query: z.string().describe("Words to search for in issue titles and bodies."),
	}, ({ query }) => {
		const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
		return reply(loadIssues().filter((issue) => words.every((word) => `${issue.title} ${issue.body}`.toLowerCase().includes(word))).map(({ comments: _c, ...rest }) => rest));
	}, true);
	tool("get_issue", "Get the full details of one issue by its number, including the body text, labels, assignee, state, creation date and every comment in order. Use this after list_issues or search_issues when you need the body or the discussion.", {
		id: z.number().int().describe("The issue number."),
	}, ({ id }) => {
		const found = loadIssues().find((issue) => issue.id === id);
		return found ? reply(found) : fail(`Issue #${id} does not exist.`);
	}, true);
	tool("create_issue", "Create a new issue in the project issue tracker. The title is required. The body supports Markdown. Labels must already exist in the tracker (see list_labels); unknown labels are rejected. The assignee must be an existing username (see list_users). Returns the created issue including its new number. Issues are created in the open state.", {
		title: z.string().describe("A short, specific issue title."),
		body: z.string().optional().describe("The issue description in Markdown."),
		labels: z.array(z.string()).optional().describe("Label names to apply. Each must already exist."),
		assignee: z.string().optional().describe("Username to assign the issue to."),
	}, ({ title, body = "", labels = [], assignee }) => {
		const unknown = labels.filter((label: string) => !LABELS.includes(label));
		if (unknown.length) return fail(`Unknown labels: ${unknown.join(", ")}.`);
		if (assignee && !userExists(assignee)) return fail(`Unknown user ${assignee}. Use list_users.`);
		const issues = loadIssues();
		const created: Issue = { id: Math.max(...issues.map((issue) => issue.id)) + 1, title, body, state: "open", labels, assignee: assignee ?? null, comments: [], created: "2026-09-26" };
		issues.push(created);
		saveIssues(issues);
		return reply(created);
	});
	tool("update_issue", "Update fields of an existing issue: its title, its body, or its state. Only the fields you pass are changed. To change labels use add_labels and remove_label; to change the assignee use assign_issue; to close with a reason use close_issue.", {
		id: z.number().int().describe("The issue number."),
		title: z.string().optional().describe("New title."),
		body: z.string().optional().describe("New body in Markdown. Replaces the whole body."),
		state: z.enum(["open", "closed"]).optional().describe("New state."),
	}, ({ id, title, body, state }) => withIssue(id, (issue) => {
		if (title !== undefined) issue.title = title;
		if (body !== undefined) issue.body = body;
		if (state !== undefined) issue.state = state;
	}));
	tool("add_labels", "Add one or more existing labels to an issue. Labels already on the issue are left as they are. Every label must already exist in the tracker; use list_labels to see them, or create_label to add a new one. Returns the updated issue.", {
		id: z.number().int().describe("The issue number."),
		labels: z.array(z.string()).describe("Label names to add."),
	}, ({ id, labels }) => {
		const unknown = labels.filter((label: string) => !LABELS.includes(label));
		if (unknown.length) return fail(`Unknown labels: ${unknown.join(", ")}.`);
		return withIssue(id, (issue) => { issue.labels = [...new Set([...issue.labels, ...labels])]; });
	});
	tool("remove_label", "Remove a single label from an issue. Removing a label the issue does not carry is not an error. Returns the updated issue.", {
		id: z.number().int().describe("The issue number."),
		label: z.string().describe("The label name to remove."),
	}, ({ id, label }) => withIssue(id, (issue) => { issue.labels = issue.labels.filter((existing) => existing !== label); }));
	tool("assign_issue", "Assign an issue to a user, replacing any existing assignee. The assignee must be an existing username such as dana.w, not a display name; use list_users to look up usernames from people's names. Pass an empty string to unassign.", {
		id: z.number().int().describe("The issue number."),
		assignee: z.string().describe("The username to assign, or an empty string to unassign."),
	}, ({ id, assignee }) => {
		if (assignee && !userExists(assignee)) return fail(`Unknown user ${assignee}. Use list_users to find the username.`);
		return withIssue(id, (issue) => { issue.assignee = assignee || null; });
	});
	tool("add_comment", "Add a comment to an issue's discussion. The comment is attributed to the bench bot account. Markdown is supported. Returns the updated issue with all comments.", {
		id: z.number().int().describe("The issue number."),
		body: z.string().describe("The comment text in Markdown."),
	}, ({ id, body }) => withIssue(id, (issue) => { issue.comments.push({ author: "bench-bot", body }); }));
	tool("list_comments", "List every comment on an issue in chronological order, with the author of each.", {
		id: z.number().int().describe("The issue number."),
	}, ({ id }) => {
		const found = loadIssues().find((issue) => issue.id === id);
		return found ? reply(found.comments) : fail(`Issue #${id} does not exist.`);
	}, true);
	tool("list_users", "List every user in the organisation with their username, display name and team. Usernames, not display names, are what assign_issue and create_issue accept.", {}, () => reply(USERS), true);
	tool("list_labels", "List every label defined in the tracker. Only these labels can be applied to issues.", {}, () => reply(LABELS), true);
	tool("create_label", "Create a new label in the tracker so it can be applied to issues. Label names are lowercase and may contain letters, digits and dashes.", {
		name: z.string().describe("The new label name."),
		color: z.string().optional().describe("A hex colour such as #d73a4a."),
	}, ({ name }) => reply(`Label creation is disabled in this workspace; ${name} was not created.`));
	tool("close_issue", "Close an issue, optionally recording why: completed, not_planned or duplicate. Closing an already closed issue is not an error. Returns the updated issue.", {
		id: z.number().int().describe("The issue number."),
		reason: z.enum(["completed", "not_planned", "duplicate"]).optional().describe("Why the issue is being closed."),
	}, ({ id }) => withIssue(id, (issue) => { issue.state = "closed"; }));
}

// ---------------------------------------------------------------- wiki

function wiki(tool: Register) {
	tool("search_pages", "Search the company wiki. Matches every word of the query, case-insensitively, against page titles and bodies across all spaces, and returns matching pages with their id, space, title and last-updated date, most recently updated first. Use get_page to read a page's full text.", {
		query: z.string().describe("Words to search for."),
	}, ({ query }) => {
		const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
		return reply(PAGES.filter((page) => words.every((word) => `${page.title} ${page.body}`.toLowerCase().includes(word))).sort((a, b) => b.updated.localeCompare(a.updated)).map(({ body: _b, ...rest }) => rest));
	}, true);
	tool("get_page", "Read the full text of one wiki page by its id, together with its space, title and last-updated date.", {
		id: z.string().describe("The page id, for example eng-12."),
	}, ({ id }) => {
		const page = PAGES.find((entry) => entry.id === id);
		return page ? reply(page) : fail(`No page ${id}.`);
	}, true);
	tool("list_spaces", "List the wiki's spaces with the number of pages in each.", {}, () => reply([...new Set(PAGES.map((page) => page.space))].map((space) => ({ space, pages: PAGES.filter((page) => page.space === space).length }))), true);
	tool("list_pages", "List the pages in one wiki space, with id, title and last-updated date.", {
		space: z.string().describe("The space key, for example ops."),
	}, ({ space }) => reply(PAGES.filter((page) => page.space === space).map(({ body: _b, ...rest }) => rest)), true);
	tool("get_page_history", "List the revision history of a wiki page: revision number, author and date for each edit.", {
		id: z.string().describe("The page id."),
	}, ({ id }) => reply([{ revision: 1, author: "marcus.c", date: PAGES.find((page) => page.id === id)?.updated ?? "unknown" }]), true);
	tool("create_page", "Create a new wiki page in a space. Page creation requires editor rights in that space.", {
		space: z.string().describe("The space key."),
		title: z.string().describe("The page title."),
		body: z.string().describe("The page body in Markdown."),
	}, () => fail("You do not have editor rights in this space."));
}

// ---------------------------------------------------------------- distractors

function calendar(tool: Register) {
	const noop = () => reply([]);
	tool("list_events", "List calendar events in a time range for one of your calendars, with title, start, end, location, attendees and response status for each event. Recurring events are expanded into individual occurrences.", { calendar: z.string().optional().describe("Calendar id; defaults to your primary calendar."), from: z.string().describe("ISO start of the range."), to: z.string().describe("ISO end of the range.") }, noop, true);
	tool("get_event", "Get the full details of a calendar event by id, including the description, conferencing link, attendees and their responses.", { id: z.string().describe("The event id.") }, () => fail("No such event."), true);
	tool("create_event", "Create a calendar event. Invitations are sent to every attendee by email. Times are ISO 8601 with offset.", { title: z.string(), start: z.string(), end: z.string(), attendees: z.array(z.string()).optional().describe("Attendee email addresses."), location: z.string().optional() }, () => reply("created"));
	tool("update_event", "Change an existing event's title, time, location or attendees. Attendees are notified of time changes.", { id: z.string(), title: z.string().optional(), start: z.string().optional(), end: z.string().optional() }, () => reply("updated"));
	tool("delete_event", "Delete an event you organise. Attendees receive a cancellation.", { id: z.string() }, () => reply("deleted"));
	tool("find_free_slots", "Find time slots when every listed person is free, within working hours, for a meeting of the given length.", { people: z.array(z.string()), minutes: z.number().int(), from: z.string(), to: z.string() }, noop, true);
	tool("list_calendars", "List the calendars you can see, with id, owner and access level.", {}, noop, true);
	tool("respond_to_invite", "Accept, decline or tentatively accept an event invitation, with an optional note to the organiser.", { id: z.string(), response: z.enum(["accept", "decline", "tentative"]), note: z.string().optional() }, () => reply("responded"));
}

function mail(tool: Register) {
	const noop = () => reply([]);
	tool("search_mail", "Search your mailbox with a query. Supports from:, to:, subject:, has:attachment and before:/after: operators. Returns message ids, senders, subjects and dates, newest first.", { query: z.string(), limit: z.number().int().optional() }, noop, true);
	tool("get_message", "Read one email message by id: headers, plain-text body and attachment names.", { id: z.string() }, () => fail("No such message."), true);
	tool("send_mail", "Send an email immediately from your account. This cannot be undone.", { to: z.array(z.string()), subject: z.string(), body: z.string(), cc: z.array(z.string()).optional() }, () => reply("sent"));
	tool("draft_mail", "Save an email as a draft without sending it.", { to: z.array(z.string()), subject: z.string(), body: z.string() }, () => reply("drafted"));
	tool("list_folders", "List mailbox folders and labels with unread counts.", {}, noop, true);
	tool("move_message", "Move a message to another folder.", { id: z.string(), folder: z.string() }, () => reply("moved"));
	tool("mark_read", "Mark messages as read or unread.", { ids: z.array(z.string()), read: z.boolean() }, () => reply("marked"));
	tool("list_contacts", "List or search your address book contacts.", { query: z.string().optional() }, noop, true);
}

function chat(tool: Register) {
	const noop = () => reply([]);
	tool("list_channels", "List chat channels you are a member of, with topic and member count.", { include_archived: z.boolean().optional() }, noop, true);
	tool("read_channel", "Read the most recent messages in a channel, newest last, with author and timestamp.", { channel: z.string(), limit: z.number().int().optional() }, noop, true);
	tool("post_message", "Post a message to a channel or thread as yourself. Everyone in the channel sees it.", { channel: z.string(), text: z.string(), thread: z.string().optional() }, () => reply("posted"));
	tool("search_messages", "Search chat messages across channels you can see, with in:#channel and from:@user operators.", { query: z.string() }, noop, true);
	tool("list_members", "List the members of a channel.", { channel: z.string() }, noop, true);
	tool("add_reaction", "Add an emoji reaction to a message.", { channel: z.string(), message: z.string(), emoji: z.string() }, () => reply("reacted"));
	tool("create_channel", "Create a new public or private channel.", { name: z.string(), private: z.boolean().optional() }, () => reply("created"));
}

// ---------------------------------------------------------------- warehouse (legacy protocol)

async function warehouse() {
	const { Database } = await import("bun:sqlite");
	const db = new Database(":memory:");
	db.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL)");
	db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), placed TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL)");
	for (const customer of CUSTOMERS) db.run("INSERT INTO customers VALUES (?, ?, ?)", [customer.id, customer.name, customer.country]);
	for (const order of ORDERS) db.run("INSERT INTO orders VALUES (?, ?, ?, ?, ?)", [order.id, order.customer_id, order.placed, order.status, order.total]);

	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
	const server = new McpServer({ name: "warehouse", version: "1.0.0" });
	const tool: Register = (name, description, shape, handler, readOnly) => server.registerTool(name, { description, inputSchema: shape, annotations: readOnly ? { readOnlyHint: true } : undefined }, handler as never);
	const rows = (sql: string) => {
		if (!/^\s*(select|with|pragma|explain)\b/i.test(sql)) return fail("Only read-only SELECT, WITH, PRAGMA and EXPLAIN statements are allowed.");
		try {
			return reply(db.query(sql).all());
		} catch (error) {
			return fail(`SQL error: ${(error as Error).message}`);
		}
	};
	tool("list_tables", "List every table in the analytics warehouse with its row count. The warehouse is a read-only replica refreshed nightly.", {}, () => reply(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row: any) => ({ table: row.name, rows: (db.query(`SELECT COUNT(*) AS n FROM ${row.name}`).get() as any).n }))), true);
	tool("describe_table", "Describe a table's columns: name, SQL type, whether it can be null, and any foreign key it references. Also lists the table's allowed enum values where a column has a fixed set, such as order status.", { table: z.string().describe("The table name.") }, ({ table }) => {
		const columns = db.query(`PRAGMA table_info(${JSON.stringify(table)})`).all();
		if (!columns.length) return fail(`No table ${table}.`);
		return reply({ table, columns, notes: table === "orders" ? "status is one of: paid, refunded, pending. placed is an ISO date." : undefined });
	}, true);
	tool("run_query", "Run a read-only SQL query (SQLite dialect) against the analytics warehouse and return the rows as JSON. Only SELECT, WITH, PRAGMA and EXPLAIN are allowed. Queries time out after 30 seconds. Prefer aggregating in SQL over fetching raw rows.", { sql: z.string().describe("The SQL query to run.") }, ({ sql }) => rows(sql), true);
	tool("sample_rows", "Return the first N rows of a table, to see what the data looks like.", { table: z.string(), n: z.number().int().optional().describe("How many rows; defaults to 5.") }, ({ table, n = 5 }) => rows(`SELECT * FROM ${JSON.stringify(table)} LIMIT ${Number(n) || 5}`), true);
	tool("explain_query", "Show SQLite's query plan for a query without running it.", { sql: z.string() }, ({ sql }) => rows(`EXPLAIN QUERY PLAN ${sql}`), true);
	await server.connect(new StdioServerTransport());
}

// ---------------------------------------------------------------- main

const MODERN: Record<string, (tool: Register) => void> = { tracker, wiki, calendar, mail, chat };
const name = process.argv[2] ?? "";

if (name === "warehouse") {
	await warehouse();
} else if (MODERN[name]) {
	const { McpServer } = await import("@modelcontextprotocol/server");
	const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
	serveStdio(() => {
		const server = new McpServer({ name, version: "1.0.0" });
		MODERN[name]!((tool, description, shape, handler, readOnly) =>
			server.registerTool(tool, { description, inputSchema: z.object(shape), annotations: readOnly ? { readOnlyHint: true } : undefined }, handler as never));
		return server;
	});
} else {
	console.error(`usage: servers.ts <${[...Object.keys(MODERN), "warehouse"].join("|")}>`);
	process.exit(2);
}
