#!/usr/bin/env bash
# Opens the app on a fresh `hv.sh up` run and signs in to the stand-in, as features/sign-in.md does. Needs HV_RUN and S.
set -euo pipefail
. "$HV_RUN/state.env"
"$S/wd.mjs" open
"$S/wd.mjs" wait button "Get started" 60000
"$S/wd.mjs" click button "Get started"
"$S/wd.mjs" select select "Connect through" -- "Web address"
"$S/wd.mjs" fill input "Dashboard URL" -- "$DASHBOARD_URL"
"$S/wd.mjs" click button "Test the route"
"$S/wd.mjs" wait '[role=status]' "Reached Hermes" 60000
"$S/wd.mjs" click button Next
"$S/wd.mjs" fill input "Dashboard username" -- verify
"$S/wd.mjs" fill input "Dashboard password" -- verify-pass
"$S/wd.mjs" click button "Test connection"
"$S/wd.mjs" wait '[role=status]' "At least one route works" 90000
"$S/wd.mjs" click button "Save and connect"
"$S/wd.mjs" wait .setup-ok "You're ready to chat" 60000
"$S/wd.mjs" click button Skip
"$S/wd.mjs" gone '[role=dialog]' 30000
