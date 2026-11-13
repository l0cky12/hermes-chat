#!/usr/bin/env bash
# Agents for the office shots, on a signed-in run. Needs HV_RUN and S (the scripts dir).
set -euo pipefail
. "$HV_RUN/state.env"
chat() {
  "$S/wd.mjs" click button "New chat (Ctrl+N)"
  for i in 1 2 3 4 5; do "$S/wd.mjs" click 'textarea[data-composer]' && break; sleep 2; done
  "$S/wd.mjs" keys "$1\n"
  sleep 3
}
chat 'delegate the audit and queue the summary'
chat 'approval: rotate the backup keys'
chat 'fail the nightly report'
live() { curl -sf -X POST "$DASHBOARD_URL/__live?profile=$1&id=$2&status=$3&title=$(printf %s "$4" | sed 's/ /%20/g')" >/dev/null; }
live forge f1 working "Release notes for v2.4"
live forge f2 working "Bump dependencies"
live argus a1 waiting "Approve firewall change"
live scribe s1 working "Weekly digest draft"
live wazuh w1 working "Triage overnight alerts"
live wazuh w2 waiting "Quarantine host db-02?"
live oracle o1 working "Forecast storage growth"
live hephaestus h1 working "Rebuild CI image"
live talos t1 working "Watch deploy of api-gateway"
live inbox-manager i1 working "Sort the inbox"
live agent-07 g7 working "Nightly crawl"
live agent-12 g12 working "Summarise PR #561"
echo seeded
