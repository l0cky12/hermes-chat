#!/usr/bin/env bash
# The verify skill's `hv`, with the stand-in holding every profile in HV_PROFILES (comma-separated) besides `default`
# and `work`, and Xvfb on a display in :170-:179 (this task's range on a box shared with other sessions).
# A patched copy of the skill's scripts goes in <repo>/.hv-459/skills/verify-hermes-chat/scripts (kept out of git by .git/info/exclude), so `hv`'s
# own repo lookup still finds this checkout. Use it as you would `hv`: `hv.sh build`, `HV_PROFILES=a,b hv.sh up`.
set -euo pipefail
REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
# As deep as the original, so the stand-in's relative imports of src/ still resolve.
COPY=$REPO/.hv-459/skills/verify-hermes-chat/scripts
grep -qx '/.hv-459/' "$(git -C "$REPO" rev-parse --git-path info/exclude)" 2>/dev/null || echo '/.hv-459/' >>"$(git -C "$REPO" rev-parse --git-path info/exclude)"
mkdir -p "$COPY"
cp -a "$REPO/.claude/skills/verify-hermes-chat/scripts/." "$COPY/"
sed -i 's/for n in $(seq 140 199); do/for n in $(seq 170 179); do/' "$COPY/hv"
grep -q 'seq 170 179' "$COPY/hv"
sed -i 's|^server.otherProfiles = { work: \[\] };$|&\nfor (const p of (process.env.HV_PROFILES ?? "").split(",").filter(Boolean)) server.otherProfiles[p] ??= [];|' "$COPY/bridge.ts"
grep -q 'HV_PROFILES' "$COPY/bridge.ts"
exec "$COPY/hv" "$@"
