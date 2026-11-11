#!/usr/bin/env bash
# Says whether a job's suite must run for this event: writes `run=true` or
# `run=false` to $GITHUB_OUTPUT (or stdout when it is unset) and one line on why.
#
#   affected.sh <scope>
#
# A push, a manual run, and anything that is not a pull request run everything:
# a merge into docs/one-oh or main is always tested in full. On a pull request,
# the files are the ones the pull request changes, read from the merge commit
# GitHub checks out (its first parent is the base). The job needs
# `fetch-depth: 2` for that parent. When the list can't be read, everything runs.
#
# A scope names the files its suite can be affected by. Each scope is a list of
# files it may skip, never a list it must run for, so a file nobody has
# classified runs every suite:
#
#   app       the app's suites (Route smoke, Window behavior): the e2e tests
#             launch the engine too, so only the site, the published docs/
#             (not its API contract), and root Markdown and license files skip.
#   frontend  Lint and Frontend: those, plus the engine's own files. The browser
#             extension is the frontend's: its tests are the frontend's.
#   engine    Backend on Python 3.10 and 3.11: those, plus the frontend's.
#             Backend on 3.12 always runs in full, because the suite also
#             checks the repository as a whole (spelling, workflows, the site,
#             and the API contract).
#
# Anything under .github/ runs everything. CHANGED_FILES, one path per line,
# replaces the git diff (for tests).
set -euo pipefail

scope="${1:?usage: affected.sh app|frontend|engine}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

decide() { echo "run=$1" >> "$out"; echo "$2"; exit 0; }

case "$scope" in app|frontend|engine) ;; *) echo "unknown scope: $scope" >&2; exit 2 ;; esac

if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
  decide true "Not a pull request (${GITHUB_EVENT_NAME:-local}): the full suite runs."
fi

if [ -n "${CHANGED_FILES+set}" ]; then
  files="$CHANGED_FILES"
elif ! files="$(git diff --name-only HEAD^1 HEAD 2>/dev/null)"; then
  decide true "Couldn't list the pull request's files: the full suite runs."
fi
[ -n "$files" ] || decide true "The pull request changes no files that git lists: the full suite runs."

# Paths no app suite reads.
skip='^site/|^docs/|^[^/]+\.md$|^LICENSE'
keep='^docs/api-contract/'
engine='^resmon_scripts/|^requirements[^/]*\.txt$|^pytest\.ini$|^conftest\.py$|^pyproject\.toml$|^setup\.cfg$'
frontend='^resmon_scripts/frontend/|^resmon_scripts/extension/|^\.nvmrc$'

mine=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [[ "$f" =~ ^\.github/ ]]; then
    decide true "$f changes the workflows: the full suite runs."
  fi
  skippable=false
  if [[ "$f" =~ $skip ]] && ! [[ "$f" =~ $keep ]]; then
    skippable=true
  elif [ "$scope" = frontend ] && [[ "$f" =~ $engine ]] && ! [[ "$f" =~ $frontend ]]; then
    skippable=true
  elif [ "$scope" = engine ] && [[ "$f" =~ $frontend ]]; then
    skippable=true
  fi
  if [ "$skippable" = false ]; then mine="$f"; break; fi
done <<< "$files"

if [ -n "$mine" ]; then
  decide true "$mine is in this suite's scope ($scope): the suite runs."
fi
decide false "Nothing this pull request changes is in this suite's scope ($scope): its steps are skipped, and the check passes. A merge runs it in full."
