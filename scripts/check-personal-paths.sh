#!/usr/bin/env bash
# Block personal machine paths in tracked files. Generic dotdirs (~/.pi,
# ~/.config) are allowed; machine-specific locations (/Users/<name>,
# /home/<name>, C:\Users\<name>, and personal home subdirs) are not.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

patterns=(
  '/Users/[A-Za-z0-9._-]+/'
  '/home/[A-Za-z0-9._-]+/'
  'C:\\Users\\[A-Za-z0-9._-]+'
  '~/(Documents|Desktop|Downloads|dev|projects|work)/'
)
placeholders=('/Users/me/' '/Users/you/' '/home/me/' '/home/you/' '/Users/username/' '/home/username/')

allow_regex=(
  '^docs/guides/assets/'
  '^promo/'
  '^demo/'
)

files=$(git ls-files)
found=0
for f in $files; do
  skip=0
  for a in "${allow_regex[@]}"; do
    [[ $f =~ $a ]] && skip=1 && break
  done
  [[ $skip -eq 1 ]] && continue
  for p in "${patterns[@]}"; do
    hits=$(grep -nIE "$p" -- "$f" 2>/dev/null | grep -v 'x-ison-personal-path-allow' || true)
    [[ -z $hits ]] && continue
    is_placeholder=0
    for ph in "${placeholders[@]}"; do
      [[ $hits == *"$ph"* ]] && is_placeholder=1 && break
    done
    if [[ $is_placeholder -eq 0 ]]; then
      echo "ERROR: personal path in $f (pattern: $p)" >&2
      echo "$hits" >&2
      echo "  fix the path, or add a trailing 'x-ison-personal-path-allow' marker to the line" >&2
      found=1
    fi
  done
done

exit $found
