#!/bin/sh
# The version the next release gets.
#
# A release is named after its month and counts up inside it:
# 2026.10.0, 2026.10.1, 2026.10.2, then 2026.11.0 in November. The patch counter
# resets every month, so a version never grows past the month plus one digit.
#
#   sh scripts/release-version.sh              # this month, in UTC
#   sh scripts/release-version.sh 2026-10      # a month of your choosing
#
# Reads this checkout's tags, so `git fetch --tags` first.
set -eu

month="$(printf '%s' "${1:-$(date -u +%Y-%m)}" | tr '-' '.')"
prefix="${month%%.*}.$(printf '%02d' "${month#*.}")"

# Every `.N` tag this month holds; the next release is one past the highest.
highest=-1
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  patch="${tag#"$prefix"}"
  patch="${patch#.}"
  case "$patch" in '' | *[!0-9]*) continue ;; esac
  [ "$patch" -gt "$highest" ] && highest="$patch"
done <<EOF
$(git tag -l "$prefix" "$prefix.*")
EOF

printf '%s.%s\n' "$prefix" "$((highest + 1))"
