# juna

juna is a lean profile for the [Pi coding agent](https://github.com/earendil-works/pi). It keeps the model's context small. Smaller context means fewer tokens billed on every request.

juna wraps [TypeSafe Jev](https://docs.typesafe.ai), a small and cheap judgment model, around Pi's context pipeline. Jev costs $0.042 per million input tokens. gpt-6-sol costs $0.20 per million cached input tokens (5 times more) and $2 per million uncached (48 times more). gpt-6-astra costs $1 and $10. juna spends a Jev call to decide what the frontier model does not need to read.

juna never breaks the provider prompt cache. Every saving below comes on top of normal prompt caching, never at its expense.

- [What it saves](#what-it-saves)
- [Setup guide for agents](#setup-guide-for-agents)
- [Features](#features)
- [Configuration](#configuration)
- [Measuring it yourself](#measuring-it-yourself)
- [Troubleshooting](#troubleshooting)

## What it saves

The numbers come from three measurements. Each one can be reproduced with a script in this repo.

### 1. The prompt Pi sends on every request

Pi re-sends its system prompt and tool schemas on every request. `scripts/context-report.ts --stock` captures the real turn-0 payload of stock Pi and of juna and exits before anything is sent, so it costs nothing to run.

| Setup | Stock Pi | juna | Change |
|---|---:|---:|---:|
| No skills installed | 1,355 tok | 1,850 tok | +495 tok |
| 179 skills installed | 25,794 tok | 1,850 tok | −23,944 tok (−93%) |

With no skills installed, juna's prompt is larger. It adds four tools stock Pi does not have (`web_search`, `web_fetch`, `skill_search`, `skill_load`, 509 tokens of schema) and a 435-token `AGENTS.md` with batching rules. With a skill catalogue installed, stock Pi lists every skill's name and description in the prompt. juna removes that list and gives the model `skill_search` instead.

That prefix is paid on every request of every session. The 24k-token catalogue costs this much in a 30-request session:

| Model | All requests cached | All requests uncached |
|---|---:|---:|
| gpt-6-sol ($0.20 / $2 per M) | $0.14 | $1.44 |
| gpt-6-astra ($1 / $10 per M) | $0.72 | $7.18 |

Real sessions land between the two columns, because provider caches miss.

### 2. End-to-end tasks, stock Pi vs juna

`bench/run.ts` runs the same coding tasks through stock Pi and juna with the same model and reasoning effort. Code grades every run afterwards.

The fixture is [commander.js](https://github.com/tj/commander.js) v14.0.0: a 2,778-line `lib/command.js` and a 1,365-test Jest suite. The three tasks:

- **fix**: a one-line bug in `lib/command.js` fails 38 tests. The agent must fix it without editing tests.
- **explain**: name the methods and settings that decide whether an unknown option is an error, written to `ANSWER.md`. The grader checks for four required names.
- **feature**: add a chainable `envPrefix()` method with typings and tests. A hidden six-test file grades it.

Three arms ran each task three times, 27 runs in all:

- **Stock Pi, no skills**: a fresh profile with default settings and `--no-skills`. This is the smallest prompt stock Pi can send.
- **Stock Pi, skills**: the same profile with skill discovery on. The test machine has 179 skills installed, so every request carries the skill catalogue.
- **juna**: a freshly seeded juna profile with the skill picker.

Each run starts from a fresh copy of the fixture with no `.git`, so `git diff` cannot reveal the injected bug. The grading baseline lives in a separate repository outside the workspace. Graders retry a failing Jest run once, because a few commander tests are timing-sensitive under load.

Model: `gpt-6-sol` at medium reasoning effort. Prices: $2 per million uncached input tokens, $0.20 cached, $10 output, and $0.042 for Jev input. Totals over nine runs per arm:

| | Stock Pi, no skills | Stock Pi, skills | juna |
|---|---:|---:|---:|
| Tasks passed | 9/9 | 9/9 | 9/9 |
| Model requests | 107 | 84 | 77 |
| Uncached input tokens | 213k | 353k | 230k |
| Cached input tokens | 1,367k | 2,872k | 788k |
| Output tokens | 16k | 17k | 16k |
| Jev input tokens | 0 | 0 | 402k |
| **Total cost** | **$0.86** | **$1.45** | **$0.79** |
| Mean time per run | 93 s | 86 s | 96 s |

Per task, mean cost per run:

| Task | Stock Pi, no skills | Stock Pi, skills | juna |
|---|---:|---:|---:|
| fix | $0.090 | $0.164 | $0.080 |
| explain | $0.066 | $0.114 | $0.072 |
| feature | $0.131 | $0.207 | $0.111 |

What the numbers say:

- **Against stock Pi with skills installed, juna cost 46% less** at the same pass rate. Most of the difference is the skill catalogue, which stock Pi re-sends on every request: cached input fell from 2.9M tokens to 0.8M.
- **Against stock Pi with no skills, juna cost 8% less.** juna made 28% fewer requests, mostly from the batching rules in its `AGENTS.md`, and sent 42% fewer cached tokens. This margin is within run-to-run noise. An earlier 18-run pass of the same benchmark measured juna 6% more expensive than stock Pi without skills.
- **Jev cost $0.017** across all nine juna runs.
- **Wall time was about the same.** Each Jev call adds a few hundred milliseconds, and fewer requests win some of that back.

In these tasks the agents narrowed their own tool output with `rg`, `sed -n` and `tail`, so Jev pruning removed little. Pruning pays off most when a command prints a large result that the model did not filter first.

### 3. Individual stages

| Stage | Measurement |
|---|---|
| Structural folding | juna's own `jev-prune.ts` read whole: 315 lines to 138, 3,377 tokens to 1,390 (−59%). Free and deterministic. |
| Jev pruning | `cat extensions/*.ts` (417 lines) against a question about one function: 33% of characters removed in 1.7 s, and the function survived. |
| Jev pruning, large file | A 164 KB model catalogue, asked for one entry: 47% removed in 3.9 s, all three mentions of the target kept. |
| Repeat dedup | A re-read of unchanged bytes becomes a one-line pointer. Free. |
| Computer use focus | File Explorer at `C:\Windows`, "open the Fonts folder": 6,111 characters (capped at 200 rows, Fonts missing) became 981 characters over 15 rows, with Fonts in it. |
| Computer use schema | `--cua` adds 782 tokens per request. Loading the same driver's MCP tool list costs 23,051 tokens. |

Jev pruning is conservative on purpose. It drops only chunks it is confident are irrelevant, and it keeps everything when a call fails. On code the task depends on, it often keeps the whole output. The biggest steady savings come from the prompt, from batching, and from the free stages.

### What juna costs to run

Jev bills input tokens only, at $42 per billion. A pruning call on a 40-chunk tool result reads about 12,000 tokens, which costs $0.0005. Across the nine benchmark runs above, Jev read 402k tokens in total, which cost $0.017. Without a TypeSafe key, juna skips the Jev stage and keeps every free stage.

## Setup guide for agents

This section is written for a coding agent doing the install. Run each step in order. Every step ends with a check. Stop at the first check that fails and fix it before going on.

### Step 1. Check the prerequisites

```bash
bun --version      # needs 1.4 or newer: https://bun.sh
node --version     # needs 22.6 or newer (Pi runs on Node)
pi --version       # needs 0.86.1 or newer
git --version
```

If `bun` is missing, install it with `curl -fsSL https://bun.sh/install | bash` and open a new shell.

If `pi` is missing or older than 0.86.1, install it with npm:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
```

Do not use `pi update` for this. On some installs it refuses to self-update.

**Check:** all four commands print a version.

### Step 2. Clone juna and the skill picker side by side

juna loads the [skill picker](https://github.com/safzanpirani/pi-jev-skill-picker) when it finds it in a sibling directory. The skill picker removes Pi's skill catalogue from the prompt.

```bash
mkdir -p ~/src && cd ~/src
git clone https://github.com/safzanpirani/juna.git
git clone https://github.com/safzanpirani/pi-jev-skill-picker.git
cd juna
bun install
bun run check
```

Any parent directory works in place of `~/src`. Keep the two repos next to each other. To keep the picker somewhere else, set `JUNA_SKILL_PICKER` to the path of its `extensions/skill-jev.ts` before step 4.

**Check:** `bun run check` ends with `0 fail`. The Python CodeMode tests need Python 3.10+ with `dill`; if only those fail, do step 7 and run the check again, or skip them if you will not use CodeMode.

### Step 3. Put `juna` on PATH

```bash
./scripts/install.sh
```

The script links `~/.local/bin/juna` to `bin/juna`. It warns when `~/.local/bin` is not on PATH. In that case add `export PATH="$HOME/.local/bin:$PATH"` to the shell profile and open a new shell. Set `JUNA_BIN_DIR` to link somewhere else.

**Check:** `juna --version` prints the Pi version from any directory.

### Step 4. Let juna build its profile

The first launch creates the profile at `~/.pi/juna`. Stock Pi keeps its own profile at `~/.pi/agent`, and the two never share settings.

```bash
juna --version
ls ~/.pi/juna
grep -A 8 '"extensions"' ~/.pi/juna/settings.json
```

The launcher copies `config/settings.json` and `config/AGENTS.md` into the profile. It writes the real repo path in place of `{{JUNA}}`. It adds the skill picker when it finds it. It symlinks `auth.json`, `models.json` and `models-store.json` from `~/.pi/agent` when they exist, so juna uses the same model logins as stock Pi without a second copy of any secret.

**Check:** `~/.pi/juna/settings.json` lists five or six extension paths, and every path exists. None of them contains `{{JUNA}}`.

The profile files are copies. Later edits to `config/` do not reach an existing profile. Delete `~/.pi/juna/settings.json` or `~/.pi/juna/AGENTS.md` and run `juna` again to re-seed either one. Extensions load straight from the repo, so edits to `extensions/*.ts` take effect on `/reload`.

### Step 5. Give it a model

If stock Pi already works on this machine, juna already has its credentials through the symlinks. Otherwise run `pi`, sign in with `/login`, exit, then run `rm -rf ~/.pi/juna && juna --version` so the links get made.

The template's default model is `opencode-go/deepseek-v4.1-flash`. Set a model this machine can reach:

```bash
pi --list-models | head -40                 # see what is available
```

Then edit `defaultProvider` and `defaultModel` in `~/.pi/juna/settings.json`, or pass `juna --model <provider>/<id>` on each run.

**Check:** `juna -p "Reply with exactly: OK"` prints `OK`.

### Step 6. Add the API keys

juna uses two optional keys. Both live in the profile, never in the repo.

| Key | Used for | Get one at |
|---|---|---|
| TypeSafe | Jev pruning, test verdicts, skill ranking, search ranking | https://typesafe.ai |
| Exa | `web_search` and `web_fetch` | https://exa.ai |

```bash
cat > ~/.pi/juna/juna.json <<'JSON'
{
  "apiKey": "YOUR_TYPESAFE_KEY",
  "exaApiKey": "YOUR_EXA_KEY"
}
JSON
chmod 600 ~/.pi/juna/juna.json
```

`TYPESAFE_API_KEY` and `EXA_API_KEY` in the environment also work and take precedence over the file.

Either key can be left out. Without the TypeSafe key, the free stages still run: empty results collapse, repeats become pointers, code reads fold and oversized output spills to a file. Only the Jev stage goes quiet. Without the Exa key, `web_search` reports that it has no key. Nothing else changes.

**Check:** `ls -l ~/.pi/juna/juna.json` shows `-rw-------`.

### Step 7. Optional: Python for CodeMode

Skip this step unless you plan to run `juna --codemode`.

```bash
python3 -m venv ~/.pi/juna/python-venv
~/.pi/juna/python-venv/bin/python -m pip install 'dill==0.4.1'
```

**Check:** `~/.pi/juna/python-venv/bin/python -c 'import dill; print(dill.__version__)'` prints `0.4.1`.

### Step 8. Verify with numbers

```bash
bun scripts/context-report.ts --stock
```

This costs nothing. It captures the turn-0 payload of stock Pi and of juna and exits before either request is sent. With skills installed, the last line shows a large saving. With no skills installed, juna comes out about 500 tokens larger, which is expected (see [What it saves](#what-it-saves)).

Then run one real turn that produces long output:

```bash
cd "$(mktemp -d)"
juna -p "Run this exact bash command: ls -la /usr/bin /usr/lib | head -400. Then reply with only the number of lines you were shown."
grep -o '\[juna[^]]*' $(ls -t ~/.pi/juna/sessions/*/*.jsonl | head -1) | head
```

**Check:** with a TypeSafe key set, the grep prints at least one `[juna pruned lines …` marker. If it prints nothing, confirm the key from step 6 is readable and that the output was over 3,000 characters.

With an Exa key, one more:

```bash
juna -p "Use web_search to find the latest release of the Pi coding agent. Reply with only the version."
```

**Check:** the reply is a version number.

### Step 9. Use it

```bash
cd ~/some/project
juna                        # interactive, like pi
juna -p "task"              # one-shot
juna --model <provider>/<id>
```

Every Pi flag works. Type `/ctx` in a session to see where the context went.

## Features

### The cache rule

juna never breaks the provider prompt cache.

A tool result is edited exactly once, in Pi's `tool_result` hook, before any provider has seen it. juna registers no `context` handler, rewrites no earlier message and keeps its system prompt identical between turns. The cached prefix stays byte-identical for the life of the session. Pruning only changes what enters it.

Retroactive pruning (walking the history and shrinking old results) is deliberately not implemented. It invalidates the cache from the first edited message onward and usually costs more than it saves.

### The tool-output pipeline

Each tool result runs through a ladder of checks, cheapest first. The free stages return early when they apply.

| # | Stage | Cost | What it catches |
|---|---|---|---|
| 1 | Empty-result collapse | free | A search that found nothing becomes one line |
| 2 | Repeat dedup | free | Bytes this tool already returned this session |
| 3 | Structural folding | free | A whole-file code read keeps signatures and folds bodies |
| 4 | Spill | free | A hard ceiling, so one result can never eat the window |
| 5 | Jev pruning | one API call | Everything else, judged against the task, plus a test verdict when the command ran tests |

Results from `edit`, `write` and the skill tools are never touched, and neither are errors or images.

#### Structural folding

A bare `read` of a long code file rarely needs every function body. ast-grep parses the file and every body starts folded. Regions are revealed outermost first until the file is legible. The reveal stops before any single region would blow the limit, so one enormous function cannot starve its siblings. Signatures, imports and braces all survive.

The footer shows the model how to get a body back, with real line numbers:

```
[juna folded 186 lines of bodies. Re-read what you need: read path="sample.ts" offset=88 limit=20]
```

Folding covers the languages in ast-grep's core package: TypeScript, TSX and JavaScript. Other files pass through whole.

#### Repeat dedup

Before any Jev call, juna fingerprints the output. If the same tool already returned those exact bytes this session, the repeat collapses to `[juna: identical to the read output earlier in this session (602 lines) …]`. The check needs no model call.

#### Spill

Above 50 KB, juna writes the full output to a file. The context gets the head, the tail and the file path. A failed write keeps the original output.

#### Jev pruning

1. `before_agent_start` records the user's prompt as the task.
2. `tool_result` splits the output on line boundaries into at most 40 chunks.
3. One Jev call scores every chunk in parallel on a three-level scale: irrelevant, background, load-bearing. The task goes in the shared `state` and each chunk goes in its own question, so a long output never crowds the task out.
4. Chunks below the score floor become `[juna pruned lines 12-98: 87 lines judged irrelevant to the task. Re-run the tool if you need them.]`. Adjacent drops merge into one marker.

The score floor starts at `minScore` and climbs towards `maxScore` as the window fills, so a long session prunes harder than a fresh one. A higher floor only affects results not yet sent, so it never touches the cached prefix.

Large outputs are sharded across parallel Jev requests, never truncated. Any failed shard keeps the original output. Above `hardMaxChunks`, juna cuts coarser chunks instead of asking thousands of questions.

Pruning fails open. The original output is kept when a Jev call errors or times out, or when every chunk would be dropped. Unanswered, invalid and low-confidence chunks are kept.

#### Test verdicts

When a `bash` call runs a test, build or lint command and its output is long enough to prune, two extra questions ride in the same Jev batch. The result gets its outcome on the line above it:

```
[juna: FAILED, same failure as before]
```

Outcomes are `passed`, `FAILED`, `did not run` and `partly failed`. Below the confidence floor no line is written, because a confident wrong verdict is worse than none. juna remembers the head of each failure per command, so a rerun can say it is the same failure.

Measured against real runs: a passing suite came back `passed` at confidence 1.0, a failing one `FAILED` at 0.76, and a filter that matched no test files `did not run` at 0.67.

### Prompt trimming

`jev-trim` removes whole sections of Pi's system prompt by tag. The default list is `skills`, `docs` and `rules`.

| Section | Size | What it is |
|---|---|---|
| `skills` | ~23k tok with 179 skills | Every skill's name and description |
| `docs` | ~316 tok | Paths to Pi's own documentation |
| `rules` | ~178 tok | Pi's default tool guidance |

The skill picker replaces the catalogue with `skill_search` and `skill_load`. juna's `AGENTS.md` carries a shorter rewrite of the load-bearing lines from `<rules>`, so the model still knows that `edit` matches `oldText` exactly.

Trimming pins the first prompt for the session. Changes to prompt inputs such as the working directory or an edited `AGENTS.md` take effect in the next session. The system prompt is the head of the cached prefix, so a prompt that changed per turn would invalidate the whole cache every turn. For that reason Jev never decides what to cut from the prompt. Jev only judges tool output, which is appended once and never re-sent differently.

### Batching instructions

juna's `AGENTS.md` (435 tokens) tells the model that the unit of cost is the turn. Independent calls go in one response. Verification happens once per batch. Output requests stay narrow. In a controlled test with gpt-6-astra, two added batching rules cut requests by 27% and total tokens by 19% across eight runs.

### Skill search

With the skill picker installed, the model sees two tools instead of a catalogue. `skill_search` ranks every enabled skill against the task with Jev and returns the full `SKILL.md` of the best matches. `skill_load` reads named skills directly. Skills still work as `/skill:name` commands. See the [skill picker README](https://github.com/safzanpirani/pi-jev-skill-picker).

### Web search and fetch

`web_search` asks Exa for highlights across the requested results (four by default, up to ten). The query controls which evidence Exa selects, so include required facts, constraints and edge cases in it. juna keeps the returned highlights whole, including headings and code indentation.

`web_fetch` returns page text up to 60,000 characters. Without a `question`, the text passes through unchanged. Use that mode to read API docs, schemas and examples. With a `question`, Jev pruning removes only boilerplate it is confident is irrelevant. Code blocks, uncertain passages and unscored chunks survive.

The two tools cost 242 tokens of schema.

Dynamic highlights use the `Exa-Beta: dynamic-highlights-2026-08-28` preview header. A crawl failure reports Exa's status, such as `CRAWL_NOT_FOUND (HTTP 404)`.

### `/ctx`: where the context went

`/ctx` draws the window's contents by category, one cell per half percent, in an overlay that any key dismisses:

```
▓ ▒ ░ · · · · · · · · · · · · · · · · ·   ▓  system prompt       786    0%
· · · · · · · · · · · · · · · · · · · ·   ▒  tool schemas       1.0k    1%
· · · · · · · · · · · · · · · · · · · ·   ░  your messages         1    0%
· · · · · · · · · · · · · · · · · · · ·   ▚  replies + tools       0    0%
· · · · · · · · · · · · · · · · · · · ·   ·  free               162k
· · · · · · · · · · · · · · · · · · · ·      window             164k
```

The numbers come from the last provider payload. The overlay estimates four characters per token and says so. `scripts/context-report.ts` uses a real tokenizer when the exact number matters.

### The status line

`jev-meter` shows per-request numbers and the distance to compaction:

```
████████╎░░░░░░░  38% of 262k     ctx 2.5k = 190 new + 2.3k cached (92%)  juna −24k tok
```

The `╎` marks where auto-compaction fires. `juna −24k tok` is the running total the pipeline has removed this session. `jev-trim` reports its own saving the same way: `prompt ~-24k tok (skills 23k, docs 316, rules 178)`. A `~` marks an estimate.

Cache hit rate misleads once the prefix is small. It is `cached / (cached + fresh)`, and the fresh part of each turn (your message, the reply, reasoning) stays roughly constant. A 26k prefix shows 99% hits. The same conversation on a 1.9k prefix shows 90% while costing strictly less. Judge cost per turn, not the hit rate.

### Optional: Python CodeMode

`juna --codemode` (or `JUNA_CODEMODE=1`) adds a `python` tool with a persistent namespace and top-level `await`. Imports, functions, parsed files and fetched pages survive between cells, including across restart and resume. Only printed output enters the conversation. Python results bypass Jev pruning.

It needs Python 3.10+ with `dill==0.4.1` (setup step 7). juna uses `JUNA_PYTHON` when set, then `~/.pi/juna/python-venv/bin/python`, then `python3`.

```python
import asyncio
pages = await asyncio.gather(*(tools.web_fetch(url) for url in urls))
print([len(page) for page in pages])
# Later cells can inspect pages without fetching again.
```

The async helpers are `tools.read`, `write`, `edit`, `bash`, `web_search` and `web_fetch`. `tools.call(name, **arguments)` also reaches Pi's `grep`, `find` and `ls`. The kernel runs locally with the same filesystem and network access as bash. It is not a sandbox.

Every completed cell checkpoints its namespace and cwd under `~/.pi/juna/python-state/`. A timeout, cancellation or crash restores the last completed checkpoint and warns that interrupted work may have had external effects. No cell is replayed. Checkpoints contain executable Python serialization, so keep them private. `/python-reset` clears the namespace. The default cell timeout is 120 seconds, configurable per call up to 600. Printed output above 12,000 characters spills to a private file.

CodeMode stays opt-in because it did not save tokens in a benchmark: with two models on data and migration tasks, it passed every completed run but used 25–33% more total tokens than plain juna. Both models already batch Python through bash.

### Optional: async bash

`juna --async` (or `JUNA_ASYNC=1`) moves slow bash calls to the background, after the design of [Unreal Agent](https://github.com/unreallabsai/unreal-agent). A call that finishes within 10 seconds returns exactly what Pi's bash returns. A slower call returns a placeholder at once and keeps running. Its output arrives later as a `<bash_result>` message. When the model ends a turn while calls are still running, juna holds the run open until a result lands, so `pi -p` works unchanged. `/jobs` lists running calls and `/jobs kill` stops them.

The cache rule holds: the placeholder is an ordinary tool result that nothing edits later, and the late result is a new message.

The gain needs work the model can do while a call runs. On a toy task, async used 4 requests against 3 for plain juna. Measure it on your own long builds before making it the default.

### Optional: computer use

`juna --cua` (or `JUNA_CUA=1`) drives desktop apps through [cua-driver](https://cua.ai/driver) on macOS, Windows and Linux. It reads each window's accessibility tree and acts on controls, so the model works from text instead of screenshots.

- `ui_look` lists windows, or one window's controls, one short line each: `e3 CheckBox "Advanced view" (unchecked)`. A ref stays stable across reads while the control keeps its role and label. `image=true` adds a screenshot.
- `ui_act` performs one input on one control: `click`, `double`, `right`, `set`, `type`, `key`, `scroll_up`, `scroll_down` or `menu`. `do=open` starts an app or opens a URL. `then` chains further steps into the same call. `expect` asks Jev whether a stated outcome holds. `look=true` appends the resulting window.
- `ui_do` works toward one small outcome in a single tool call. Each step asks Jev for the next action, the control, whether the goal is met and whether the next action is hard to undo. It stops before send, delete or pay controls and hands back `ambiguous` or `stuck` instead of guessing.

A target resolves by ref first, then by exact label, then by tie-breaking among exact labels, and only then by asking Jev to pick from a description. Past 40 rows, one sharded Jev request per window hides rows the task confidently does not need.

One `cua-driver mcp` process serves the whole session. Measured on Windows: `ui_look` in about 0.4 s, an action with its change report in about 0.5 s, a two-step chain in 0.95 s. Complete tasks with gpt-6-luna at medium effort:

| Task | Requests | Wall time |
|---|---|---|
| Tick a checkbox, then type into the field it reveals | 2-3 | 9.9-11.3 s |
| Compute 1234 × 5678 in Calculator | 3 | 16.4 s |
| Read the Windows edition and device name in Settings | 4 | 17.8 s |
| Create a named folder in File Explorer | 3-4 | 16.1-18.4 s |

Setup:

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"   # macOS, Linux
irm https://cua.ai/driver/install.ps1 | iex                      # Windows
cua-driver permissions grant                                     # macOS: Accessibility + Screen Recording
```

On macOS, rerun `cua-driver permissions grant` until it reports all three grants. If CuaDriver is missing from Screen & System Audio Recording, add `/Applications/CuaDriver.app` there with **+** first.

`JUNA_CUA_COMMAND` replaces the driver command, as a JSON argv array or a shell string. That drives a desktop on another machine through one persistent ssh session:

```bash
JUNA_CUA_COMMAND='["ssh","-o","BatchMode=yes","winbox","& \"C:\\Users\\me\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe\" mcp --socket \\\\.\\pipe\\cua-driver"]' juna --cua
```

Build that JSON with a program. A shell `echo` turns `\U` into a control character and silently breaks the command. With `JUNA_CUA_COMMAND` set, the prompt tells the model the desktop is a different machine from its shell.

Input goes to background windows by default, so the real mouse does not move. When a window refuses background input, the action retries in the foreground and says so. `JUNA_CUA_CURSOR=1` shows the driver's agent cursor moving to each target.

Privacy: Jev requests carry the window title, the task, and control labels and values. Do not point `ui_look` focus, `ui_act` descriptions or `ui_do` at windows holding secrets.

## Configuration

Keys come from the environment or `~/.pi/juna/juna.json` (`apiKey`, `exaApiKey`). The TypeSafe key also falls back to the skill picker's `skill-jev.json`. Everything else is an environment variable.

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | | TypeSafe key; overrides `apiKey` in `juna.json` |
| `EXA_API_KEY` | | Exa key; overrides `exaApiKey` in `juna.json` |
| `JUNA_DIR` | `~/.pi/juna` | The profile directory |
| `PI_MAIN_AGENT_DIR` | `~/.pi/agent` | The profile juna borrows credentials from |
| `JUNA_SKILL_PICKER` | sibling repo | Path to the skill picker's `extensions/skill-jev.ts` |
| `JUNA_BIN_DIR` | `~/.local/bin` | Where `scripts/install.sh` links `juna` |
| `JUNA_PRUNE_MIN_CHARS` | `3000` | Below this, output passes through untouched |
| `JUNA_FOLD_UNTIL` | `50` | Unfold bodies until this many lines are visible |
| `JUNA_FOLD_LIMIT` | `100` | Never let one unfold push past this |
| `JUNA_FOLD_MIN_TOTAL` | `100` | Files shorter than this are sent whole |
| `JUNA_SPILL_THRESHOLD` | `50000` | Characters above which the result goes to a file |
| `JUNA_PRUNE_MAX_CHUNKS` | `40` | Target chunk count before the character budget applies |
| `JUNA_PRUNE_MIN_LINES` | `8` | Never cut finer than this |
| `JUNA_PRUNE_MIN_SCORE` | `0.7` | Score floor on the 0–2 scale while the window has room |
| `JUNA_PRUNE_MAX_SCORE` | `1.4` | Floor once the window is full |
| `JUNA_PRUNE_FLOOR_FROM` | `50` | Context percentage where the floor starts rising |
| `JUNA_PRUNE_MIN_CONFIDENCE` | `0.55` | Below this, the chunk is kept whatever it scored |
| `JUNA_PRUNE_CHUNK_LIMIT` | `4000` | Characters per chunk, and the most Jev sees of one |
| `JUNA_PRUNE_SHARD_SIZE` | `40` | Questions per Jev request; shards run in parallel |
| `JUNA_PRUNE_HARD_MAX_CHUNKS` | `240` | Ceiling on chunks for one output |
| `JUNA_MODEL` | `jev-latest` | TypeSafe model |
| `JUNA_TIMEOUT_MS` | `15000` | Per-request Jev timeout |
| `JUNA_JEV_LOG` | | Append one JSON line per Jev request (questions, billed input tokens) to this file |
| `JUNA_EXA_TIMEOUT_MS` | `20000` | Exa request timeout |
| `JUNA_TRIM_SECTIONS` | `skills,docs,rules` | Prompt sections to remove; empty keeps everything |
| `JUNA_RESERVE_TOKENS` | `16384` | Pi's reply reserve, which sets the compaction mark |
| `JUNA_VERSION_CHECK` | `0` | Set to 1 to let Pi's update banner through |
| `JUNA_CODEMODE` | `0` | Set to 1 to enable the Python tool at launch |
| `JUNA_PYTHON` | managed venv, then `python3` | Python executable for CodeMode |
| `JUNA_ASYNC` | `0` | Set to 1 to enable async bash at launch |
| `JUNA_ASYNC_GRACE_MS` | `10000` | How long a bash call may run before it moves to the background |
| `JUNA_ASYNC_HEARTBEAT_MS` | `600000` | Idle wait before a held turn gets a heartbeat; 0 disables it |
| `JUNA_CUA` | `0` | Set to 1 to enable computer use at launch |
| `JUNA_CUA_BIN` | PATH, then installer paths | The cua-driver binary |
| `JUNA_CUA_COMMAND` | `<bin> mcp` | Full driver command, as a JSON argv array or a shell string |
| `JUNA_CUA_MIN_CONFIDENCE` | `0.6` | Below this, Jev's pick is handed back instead of acted on |
| `JUNA_CUA_SETTLE_MS` | `350` | Longest wait for a change after an input |
| `JUNA_CUA_CURSOR` | `0` | Set to 1 to show the agent cursor moving to each target |
| `JUNA_CUA_CURSOR_GLIDE_MS` | `120` | How long the visible cursor takes to reach a target |
| `JUNA_CUA_CURSOR_DWELL_MS` | `0` | How long the visible cursor pauses on a click |
| `JUNA_CUA_FOCUS_MIN_ROWS` | `40` | Rows above which Jev focuses a window's list on the task |
| `JUNA_CUA_FOCUS_FLOOR` | `0.15` | Jev's "needed" probability below which a row is hidden |
| `JUNA_CUA_BOUNDED_ELEMENTS` | `200` | Element cap for the retry after a tree walk times out |
| `JUNA_CUA_AUTO_FOREGROUND` | `1` | Retry in the foreground when a window takes no background input |
| `JUNA_CUA_OPEN_WAIT_MS` | `6000` | How long `do=open` waits for the new window |
| `JUNA_CUA_REUSE_MS` | `30000` | How long an action may start from the last reported state |
| `JUNA_CUA_MAX_ROWS` | `200` | Controls listed per window before asking for `find` |
| `JUNA_CUA_IMAGE_DIMENSION` | `1280` | Longest edge of a requested screenshot |

Launch flags: `--codemode`/`--no-codemode`, `--async`/`--no-async`, `--cua`/`--no-cua`. The launcher removes them before starting Pi. Everything else goes to Pi unchanged.

To tune the pruning thresholds against real output:

```bash
bun scripts/prune-demo.ts --task "find the failing assertion" --cmd "bun test"
```

It prints each chunk's score, confidence and verdict to stderr and the pruned output to stdout.

## Measuring it yourself

| Script | What it measures | Cost |
|---|---|---|
| `bun scripts/context-report.ts --stock [--no-skills]` | Turn-0 payload of stock Pi against juna, by prompt section and tool schema | free |
| `bun scripts/context-report.ts --diff` | juna with and without its extensions | free |
| `bun scripts/session-anatomy.ts <session.jsonl>` | Token share per message kind in a real session | free |
| `bench/run.ts` + `bench/report.ts` | End-to-end stock Pi vs juna on graded tasks | model and Jev spend |

The context report runs Pi with `scripts/dump-context.ts`, which captures the provider payload in `before_provider_request` and exits before the request leaves the machine. Token counts use `gpt-tokenizer`. They are estimates, not provider billing.

To rerun the benchmark:

```bash
bench/fixture.sh /tmp/commander                     # clone commander.js v14.0.0 and install
bun bench/run.ts --fixture /tmp/commander --out /tmp/juna-bench \
  --model <provider>/<id> --thinking medium --repeats 3 --concurrency 2
bun bench/report.ts /tmp/juna-bench/results.json --input 2 --output 10 --cache-read 0.2
```

`fixture.sh` caps Jest at two workers per run. Without the cap, many agents running the suite at once start one worker per core each and can exhaust memory. The runner also waits before starting a run while free disk is under 3 GB (`--min-free-gb`). `--arms stock,juna` skips the stock-with-skills arm.

Each run gets a fresh copy of the fixture, a fresh profile, its own session directory and its own Jev usage log under `--out`. Stock Pi borrows credentials from `~/.pi/agent`. Set the prices to your model's rates per million tokens.

`bun bench/regrade.ts --fixture /tmp/commander --out /tmp/juna-bench` grades every run again, one at a time, from its saved `diff.patch`. Use it when parallel runs may have disturbed a grade.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `juna` runs but nothing is pruned | No TypeSafe key, or output under 3,000 characters |
| Extensions do not load | `settings.json` still holds `{{JUNA}}` or points at an old path. Delete it and run `juna` again |
| Credit or auth errors | No `auth.json` link, or a `defaultProvider` this machine cannot reach |
| The skill catalogue is still in the prompt | The skill picker is not a sibling directory and `JUNA_SKILL_PICKER` is unset. Delete `~/.pi/juna/settings.json` after fixing it |
| `bun run check` fails on a fresh clone | bun older than 1.4, `bun install` skipped, or no Python venv for the CodeMode tests |
| A read is folded but the file is not TypeScript | Expected. ast-grep ships TS, TSX and JS only; other files are never folded |
| `web_search` says it has no key | No `exaApiKey` in `juna.json` and no `EXA_API_KEY` |
| Search results look unranked | No TypeSafe key, so Exa's order is used |
| Edits to `config/` have no effect | The profile holds copies. Delete the copied file and run `juna` again |
| `--cua` fails with `permissions_pending` | macOS grants are incomplete. Rerun `cua-driver permissions grant` |

## Layout

| Path | What |
|---|---|
| `bin/juna` | The launcher: seeds the profile, links credentials, handles opt-in flags |
| `config/` | The profile template: settings, a short `AGENTS.md`, four built-in tools |
| `extensions/jev.ts` | Shared Jev client: config, retry, abort, usage log |
| `extensions/jev-prune.ts` | The tool-output pipeline: hooks, question building, thresholds |
| `extensions/chunk.ts` | Pure splitting and reassembly |
| `extensions/dedup.ts` | Output fingerprints, so repeats collapse to a pointer |
| `extensions/fold.ts`, `structure.ts` | Fold planning and ast-grep parsing |
| `extensions/spill.ts` | The per-result ceiling |
| `extensions/useless.ts` | One-line stand-ins for results that found nothing |
| `extensions/verify.ts` | Test-runner detection and the verdict line |
| `extensions/jev-trim.ts`, `trim.ts` | System-prompt section removal |
| `extensions/jev-search.ts`, `exa.ts` | `web_search` and `web_fetch` |
| `extensions/jev-ctx.ts`, `grid.ts` | `/ctx` |
| `extensions/jev-meter.ts`, `stats.ts`, `savings.ts` | The status line and the savings counter |
| `extensions/python/` | Opt-in CodeMode |
| `extensions/async-bash.ts` | Opt-in async bash |
| `extensions/cua/` | Opt-in computer use |
| `scripts/` | Context report, session anatomy, pruning demo, installer |
| `bench/` | The stock-vs-juna benchmark |

## License

MIT
