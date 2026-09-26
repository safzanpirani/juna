#!/usr/bin/env bash
# Put `juna` on PATH. Re-run after moving the repo.
set -euo pipefail
here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${JUNA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$target"
ln -sfn "$here/bin/juna" "$target/juna"
echo "linked $target/juna -> $here/bin/juna"
case ":$PATH:" in
	*":$target:"*) ;;
	*) echo "warning: $target is not on PATH" >&2 ;;
esac
