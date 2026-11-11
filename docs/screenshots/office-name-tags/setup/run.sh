#!/usr/bin/env bash
# One full pass: a fresh run whose stand-in holds the profiles in HV_PROFILES, the app binary $2 signed in, a reply
# started in each profile, then shots.sh with prefix $1, then the run stopped. Build first with `hv.sh build` and copy
# the binary aside (the target dir is shared). Example, from the repo root:
#   HV_PROFILES=talos,studio-gateway,... docs/screenshots/office-name-tags/setup/run.sh after ~/.cache/hermes-verify/hermes-chat-459-after
set -euo pipefail
D=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
run=$("$D/hv.sh" up | sed -n 's/^export HV_RUN=//p')
export HV_RUN=$run
trap '"$(git -C "$D" rev-parse --show-toplevel)/.hv-459/skills/verify-hermes-chat/scripts/hv" down' EXIT
sed -i "s|^APP=.*|APP='$2'|" "$HV_RUN/state.env"
"$D/signin.sh" >/dev/null
"$D/seed.sh"
# Every profile but the open one (default) is a floor of the tower: HV_PROFILES and the stand-in's own `work`.
FLOORS=$(($(tr ',' '\n' <<<"$HV_PROFILES" | grep -c .) + 1)) "$D/shots.sh" "$1"
