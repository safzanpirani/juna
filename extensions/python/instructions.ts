export const PYTHON_INSTRUCTIONS = `
<juna_python>
Use python for substantial scripted work: batch reads, parsing, joins, calculations,
bulk file generation, validation, or reuse of large intermediate data. Prefer it to
repeated bash Python heredocs. Use ordinary tools for a simple read, edit, or command.
Execute the parts whose logic you can specify now; print evidence and stop when the
next decision needs your judgment. Do not hide evidence needed for that decision.

Python variables, imports, functions and cwd persist between cells in this session.
Top-level await works. Use print() for results; expressions are not auto-displayed.
Keep complete documents and parsed data in named variables, then inspect or transform
them in later cells without rereading/refetching. Use globals() to inspect names and
del to release large values. Persist important artifacts to files when appropriate.
State is checkpointed after each completed cell, including ordinary exceptions.
Restart, reload and resume restore the last checkpoint without replaying code.
Timeout/cancellation can lose only uncheckpointed changes; external effects remain.
Checkpoint failures are errors: live resources such as sockets, open files and tasks
must be closed and deleted, or their durable data saved separately. Never assume an
unsaved value survives restart. Only explicit reset clears the saved namespace.
Tree navigation retains the latest session state, not historical branch state.
A fork/new session has its own namespace. Inspect globals() before assuming names.
Ordinary Python exceptions keep the namespace and any partial side effects. Inspect
what completed before retrying; never blindly repeat paid or non-idempotent work.

Async helpers return text and raise RuntimeError on tool failure:
  await tools.read(path, offset=1, limit=100)  # optional line range; normal Pi limits
  await tools.write(path, content)             # creates parents; records mutation
  await tools.edit(path, old_text, new_text)   # exact replacement; records diff
  await tools.bash(command, timeout=30)        # seconds; nonzero exit raises
  await tools.web_search(query, count=4)       # complete information need
  await tools.web_fetch(url)                  # full page up to normal Exa limit
  await tools.call("grep", pattern="...", path=".")  # also find and ls, Pi arguments
Bridge paths are relative to the session project, independent of Python os.chdir.
For full bulk local reads, pathlib.Path.read_text() and standard Python libraries
are available. Use tools.write/edit for project mutations so receipts are recorded.
Native Python runs with the same local access as bash; it is not a sandbox. Nested
bridge calls use Pi's built-in implementations and Juna web tools, not other
extensions' overrides or per-tool hooks. Use direct tools when those hooks matter.

Batch independent I/O with await asyncio.gather(...), at most 16 concurrent calls;
use asyncio.Semaphore for larger batches. Await every operation before ending a cell.
Do not leave background tasks, threads or subprocesses running. Never parallelize
writes to the same file. For expected failures use try/except or gather with
return_exceptions=True, and inspect every result. Shell failures are not successes.
Print compact conclusions, excerpts with sources, and useful errors. Printed output
is capped at 12,000 characters with a recovery file for larger output; excessive
output stops execution. Stored data does not enter the conversation unless printed.

Example: retain several pages, then inspect them in a later cell:
  import asyncio
  urls = ["https://example.com/api", "https://example.com/examples"]
  pages = dict(zip(urls, await asyncio.gather(*(tools.web_fetch(u) for u in urls))))
  print({url: len(body) for url, body in pages.items()})
  # A later cell can select complete relevant sections from pages.

Example: write several files and verify them in one cell:
  files = {"src/a.py": "VALUE = 1\\n", "src/b.py": "VALUE = 2\\n"}
  for path, content in files.items():
      await tools.write(path, content)
  print(await tools.bash("python3 -m compileall -q src", timeout=30))
</juna_python>`;
