#!/bin/zsh
# Publish the static site to GitHub Pages under your own GitHub account.
#
# One-time prerequisites (both need you, not a script):
#   sudo xcodebuild -license accept     # unblocks git and Homebrew on this Mac
#   gh auth login --web                 # log in to YOUR personal GitHub account
#
# Usage:  scripts/publish.sh [repo-name]      (default: civics-trainer)
# Re-running it redeploys: it rebuilds and force-pushes the built site.
set -euo pipefail

REPO="${1:-civics-trainer}"
SITE="$(cd "$(dirname "$0")/.." && pwd)"

command -v gh >/dev/null || brew install gh git
gh auth status >/dev/null 2>&1 || gh auth login --web

OWNER="$(gh api user -q .login)"
NOREPLY="$(gh api user -q .id)+${OWNER}@users.noreply.github.com"

echo "Building for https://${OWNER}.github.io/${REPO}/ ..."
cd "$SITE"
NEXT_PUBLIC_BASE_PATH="/${REPO}" npm run build
touch out/.nojekyll

STAGE="$(mktemp -d)"
/bin/cp -R out/. "$STAGE/"
cd "$STAGE"
git init -q -b main
# Personal noreply address, so the work email in ~/.gitconfig never lands on GitHub.
git config user.name "$OWNER"
git config user.email "$NOREPLY"
git add -A
git commit -q -m "Deploy civics interview trainer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

if gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
  git remote add origin "https://github.com/${OWNER}/${REPO}.git"
  git push -q -f origin main
else
  gh repo create "$REPO" --public --source . --push \
    --description "Mock USCIS civics interview, runs entirely in the browser"
fi

gh api -X POST "repos/${OWNER}/${REPO}/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || echo "(Pages already enabled)"

echo
echo "Live in about a minute at: https://${OWNER}.github.io/${REPO}/"
echo "Send that link to your dad. He should open it in Chrome and allow the microphone."
