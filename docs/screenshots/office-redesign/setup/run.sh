#!/usr/bin/env bash
# One full pass: a fresh run whose stand-in holds 41 profiles and the inbox, signed in, seeded with agents in every
# state, then shots.sh with prefix $1, then the run stopped. Build first with `hv.sh build`. From the repo root:
#   docs/screenshots/office-redesign/setup/run.sh r1
set -uo pipefail
D=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$(git -C "$D" rev-parse --show-toplevel)"
export HV_TARGET=${HV_TARGET:-~/.cache/hermes-verify/target-569} HV_INBOX=1
export HV_PROFILES=aegis,anvil,argus,cerberus,codex-reviewer,daedalus,forge,hephaestus,inbox-manager,oracle,orchestrator,prometheus,scribe,studio-gateway,talos,tasks-reader,vista,wazuh,wiki-researcher,work-email-manager,agent-01,agent-02,agent-03,agent-04,agent-05,agent-06,agent-07,agent-08,agent-09,agent-10,agent-11,agent-12,agent-13,agent-14,agent-15,agent-16,agent-17,agent-18,agent-19
export S=$PWD/.hv-569/skills/verify-hermes-chat/scripts
run=$("$D/hv.sh" up | sed -n 's/^export HV_RUN=//p')
export HV_RUN=$run
. "$HV_RUN/state.env"
echo "evidence: $EVIDENCE"
trap '"$S/hv" down >/dev/null 2>&1' EXIT
"$D/signin.sh" >/dev/null && "$D/seed.sh" && "$D/shots.sh" "$1"
