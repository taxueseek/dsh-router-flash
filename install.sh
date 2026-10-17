#!/bin/sh
# dsh-router-flash installer — git-channel install through the dsh CLI.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/taxueseek/dsh-router-flash/main/install.sh | sh
#   sh install.sh [--profile <name>]   (default profile: web; Windows: Git Bash)
#
# Why the git channel: this package is not published to npm at all — the
# preset is delivered as a bundle patch layer, so installs go through
# git+https. Pinning the tag keeps the install reproducible; drop the
# `#v0.4.1` suffix to track main.
set -eu

PROFILE="web"
REF="v0.4.1"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || { echo "[dsh-router-flash] error: --profile needs a value" >&2; exit 1; }
      PROFILE="$2"; shift 2 ;;
    --profile=*)
      PROFILE="${1#*=}"; shift ;;
    --ref)
      [ $# -ge 2 ] || { echo "[dsh-router-flash] error: --ref needs a value" >&2; exit 1; }
      REF="$2"; shift 2 ;;
    --ref=*)
      REF="${1#*=}"; shift ;;
    -h|--help)
      echo "usage: install.sh [--profile <name>] [--ref <tag|branch>]  (default: web, v0.4.1)"; exit 0 ;;
    *)
      echo "[dsh-router-flash] error: unknown argument '$1' (usage: install.sh [--profile <name>] [--ref <tag|branch>])" >&2; exit 1 ;;
  esac
done

say() { printf '[dsh-router-flash] %s\n' "$*"; }

if ! command -v dsh >/dev/null 2>&1; then
  say "error: dsh CLI not found on PATH."
  say "install DeepSeek Harness first:  npm install -g @deepseek-ai/dsh"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  say "error: pnpm not found on PATH (dsh plugin manages profile packages through pnpm)."
  say "install pnpm first:  npm install -g pnpm"
  exit 1
fi

say "installing dsh-router-flash ($REF) into profile \"$PROFILE\" via the git channel..."
exec dsh plugin --profile "$PROFILE" add -w "github:taxueseek/dsh-router-flash#$REF"
