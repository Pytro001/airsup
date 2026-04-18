#!/usr/bin/env bash
# Minimal smoke: health + one job poll (requires CRON_SECRET and a running API).
# Usage from repo root:
#   export API_BASE="http://localhost:3001"   # or your Vercel preview URL
#   export CRON_SECRET="your-secret"
#   bash scripts/smoke-jobs.sh

set -euo pipefail
API_BASE="${API_BASE:-http://localhost:3001}"
echo "GET ${API_BASE}/health"
curl -sSf "${API_BASE}/health" | head -c 200
echo ""
if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "Skip /api/internal/jobs (set CRON_SECRET to test job poll)."
  exit 0
fi
echo "GET ${API_BASE}/api/internal/jobs"
curl -sSf -H "Authorization: Bearer ${CRON_SECRET}" "${API_BASE}/api/internal/jobs" | head -c 500
echo ""
