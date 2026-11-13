#!/usr/bin/env bash
# The verify skill's `hv`, with the stand-in holding every profile in HV_PROFILES (comma-separated) besides `default`
# and `work`, and Xvfb on a display in :184-:193 (this task's range on a box shared with other sessions).
# Use it as you would `hv`: `hv.sh build`, `HV_PROFILES=a,b hv.sh up`.
set -euo pipefail
REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
COPY=$REPO/.hv-569/skills/verify-hermes-chat/scripts
grep -qx '/.hv-569/' "$(git -C "$REPO" rev-parse --git-path info/exclude)" 2>/dev/null || echo '/.hv-569/' >>"$(git -C "$REPO" rev-parse --git-path info/exclude)"
mkdir -p "$COPY"
cp -a "$REPO/.claude/skills/verify-hermes-chat/scripts/." "$COPY/"
sed -i 's/for n in $(seq 140 199); do/for n in $(seq 184 193); do/' "$COPY/hv"
grep -q 'seq 184 193' "$COPY/hv"
sed -i 's|^server.otherProfiles = { work: \[\] };$|&\nfor (const p of (process.env.HV_PROFILES ?? "").split(",").filter(Boolean)) server.otherProfiles[p] ??= [];|' "$COPY/bridge.ts"
grep -q 'HV_PROFILES' "$COPY/bridge.ts"
exec "$COPY/hv" "$@"
