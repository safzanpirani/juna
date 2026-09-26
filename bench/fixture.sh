#!/usr/bin/env bash
# Build the benchmark fixture: commander.js v14.0.0 with its dev dependencies.
# The runner copies it once per run, so every agent starts from the same tree.
set -euo pipefail
dest="${1:?usage: bench/fixture.sh <dir>}"
if [ -d "$dest/node_modules" ]; then
	echo "fixture already at $dest"
	exit 0
fi
git clone -q --depth 1 --branch v14.0.0 https://github.com/tj/commander.js "$dest"
# Jest starts one worker per core by default. Many agents running the suite at
# once would start hundreds of workers and exhaust memory, so cap it.
node -e '
const fs = require("fs"), path = process.argv[1] + "/jest.config.js";
const source = fs.readFileSync(path, "utf8");
if (!source.includes("maxWorkers")) fs.writeFileSync(path, source.replace("const config = {", "const config = {\n  maxWorkers: 2,"));
if (!fs.readFileSync(path, "utf8").includes("maxWorkers: 2")) { console.error("could not cap jest workers"); process.exit(1); }
' "$dest"
(cd "$dest" && npm ci --silent --no-audit --no-fund && npx jest 2>&1 | grep -E '^Tests:')
echo "fixture ready at $dest"
