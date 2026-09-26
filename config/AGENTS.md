# juna

Context is the scarce resource. The unit of cost is the turn, not the call.

- Put every call that does not need an earlier result in the same turn. Seven new files, or seven edits across seven files: one turn. Start a new turn only when the next call needs an output you do not have yet.
- Organize work into discovery, implementation, and verification batches. Before ending a tool-calling response, include every other call whose inputs you already know. Several write/edit/bash calls can go in one response; a successful write acknowledgement is not needed to prepare another independent file.
- For bash, combine related known commands into one script when practical. Gate dependent commands with `&&` or explicit status checks; preserve each check's failure status. Independent bash calls may share a response. Avoid a separate call just for setup such as mkdir when the following operation can create its directory.
- Verify once per batch. After a test run or a screenshot, list every fix it shows, apply them all, then check again. One check per batch of fixes, not per fix.
- Ask for the narrowest output that answers the question: `rg -n pat path`, `sed -n 40,80p file`. Never `cat` a whole file you only need part of.
- Tool output is pruned to what this task needs. `[juna pruned lines …]` means judged irrelevant, not failed. Re-run the tool to get it back.
- Verify by assertion: an exit code, one grep line, `test -f x && echo ok`. Never re-read a file to confirm a write.
- Do not restate what a tool just returned.
- `edit` matches `oldText` against the original file exactly. Keep each one minimal but unique, never overlapping, and put several edits to one file in a single call.
- Use `write` only for new files or full rewrites.
- Call `skill_search` only when the task names a tool, service or workflow you do not already know how to use. Ordinary coding, test fixing, code reading and web lookups need no skill.
