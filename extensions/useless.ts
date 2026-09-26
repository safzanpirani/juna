/**
 * Results that say nothing, recognised without asking anyone.
 *
 * A search with no matches is a real answer, and one short line carries it. The
 * check is free and skips the Jev call entirely.
 *
 * An empty result is deliberately left alone: it already costs nothing, and a
 * notice explaining that nothing came back would cost more than the silence it
 * replaces.
 */

/**
 * A one-line stand-in for an output that found nothing, or undefined when the
 * output is either meaningful or already short enough that replacing it would
 * cost more than it saves.
 */
export function uselessNotice(toolName: string, text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;

	// Free-form command output can quote these phrases beside real results.
	if (!["grep", "find", "ls"].includes(toolName)) return undefined;
	if (!/^(?:no matches found|no files found|no results found|0 matches)[.!]?$/i.test(trimmed)) return undefined;

	const notice = `[juna: ${toolName} found nothing.]`;
	return text.length > notice.length ? notice : undefined;
}
