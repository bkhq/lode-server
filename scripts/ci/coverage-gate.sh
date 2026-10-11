#!/usr/bin/env bash
# Coverage ratchet for apps/api. Bun 1.4.2 does not fail a run on bunfig
# `coverageThreshold` (it only prints the table), so parse the text reporter's
# "All files" row (which honours apps/api/bunfig.toml's
# coveragePathIgnorePatterns) and fail below the floor.
#
# Run from apps/api. Inputs (env): MIN_LINE, MIN_FUNC (percent integers).
set -euo pipefail

bun --env-file=/dev/null test --coverage 2>&1 | tee /tmp/cov.txt
# "All files | <func%> | <line%> |"
line="$(grep -E '^All files' /tmp/cov.txt | tail -1 | awk -F'|' '{gsub(/ /,"",$3); print $3}')"
func="$(grep -E '^All files' /tmp/cov.txt | tail -1 | awk -F'|' '{gsub(/ /,"",$2); print $2}')"
echo "Measured: lines=${line}% functions=${func}% (floor: lines>=${MIN_LINE}% functions>=${MIN_FUNC}%)"
awk -v l="$line" -v f="$func" -v ml="$MIN_LINE" -v mf="$MIN_FUNC" 'BEGIN{
  if (l=="" || f=="") { print "::error::could not parse coverage from text reporter"; exit 1 }
  if (l+0 < ml+0) { printf "::error::line coverage %.2f%% below floor %s%%\n", l, ml; exit 1 }
  if (f+0 < mf+0) { printf "::error::function coverage %.2f%% below floor %s%%\n", f, mf; exit 1 }
  print "coverage gate passed"
}'
