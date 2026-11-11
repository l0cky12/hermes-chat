#!/usr/bin/env bash
# Starts one reply in each profile named in HV_PROFILES, through the stand-in's `POST /__live`, so every floor of the
# tower has an agent at work, as in the issue. Needs HV_RUN and the HV_PROFILES the run was started with.
set -euo pipefail
. "$HV_RUN/state.env"
i=0
for p in ${HV_PROFILES//,/ }; do
  i=$((i + 1))
  curl -sf -X POST "$DASHBOARD_URL/__live?profile=$p&id=c$i&status=working&title=Task%20$i" >/dev/null
done
echo "seeded $i profiles"
