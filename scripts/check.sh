#!/usr/bin/env bash
# Runs the same checks locally that CI runs: lint -> test -> build.
set -euo pipefail

echo "== Veltravia AI: local verification =="
echo "-- Lint --"
npm run lint
echo "-- Tests --"
npm test
echo "-- Build --"
npm run build
echo "== All checks passed =="
