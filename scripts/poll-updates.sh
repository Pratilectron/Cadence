#!/usr/bin/env bash
# Cron-friendly wrapper — run every 5–15 minutes if webhooks are unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/deploy.js
