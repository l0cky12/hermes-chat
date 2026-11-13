#!/usr/bin/env bash
# The office redesign's shots on a signed-in, seeded run. $1: a prefix for the names. Needs HV_RUN and S.
set -uo pipefail
p=${1:-r}
W="$S/wd.mjs"
open_office() { "$W" click button Office >/dev/null; "$W" wait '.office' "" 20000 >/dev/null; }
design() { "$W" click '.office-design .office-pop-btn' >/dev/null; "$W" click '.office-design-item' "$1" >/dev/null; sleep 1; }
scope() { "$W" click '.office-scope .office-pop-btn' >/dev/null; sleep 0.5; "$W" click '.office-scope-item' "$1" >/dev/null; sleep 1; }
overlap='const els=[...document.querySelectorAll(".plan-desk-name,.plan-desk-state,.plan-pod-title,.plan-room-head,.board-chip-name,.board-chip-state,.board-chat-name,.office-scope-name,.office-design-name")].filter(e=>e.offsetParent);
  const r=els.map(e=>e.getBoundingClientRect()); let n=0; for(let i=0;i<r.length;i++)for(let j=i+1;j<r.length;j++){const a=r[i],b=r[j]; if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1&&!els[i].contains(els[j])&&!els[j].contains(els[i]))n++}
  const h=document.querySelector(".office-scroll"); return els.length+" text boxes, "+n+" overlapping; horizontal overflow: "+(h?h.scrollWidth>h.clientWidth:"n/a");'
check() { echo "$1: $("$W" eval "$overlap")"; }
size() {
  . "$HV_RUN/state.env"
  curl -s -X POST -H 'Content-Type: application/json' -d "{\"width\":$1,\"height\":$2}" "http://127.0.0.1:$DRIVER_PORT/session/$(cat "$HV_RUN/session")/window/rect" >/dev/null
  sleep 2
  echo "window $1x$2: $("$W" eval 'return innerWidth+"x"+innerHeight+", office "+Math.round(document.querySelector(".office").getBoundingClientRect().width)')"
}
open_office
SEEDED_PROFILES=11
for i in $(seq 1 24); do
  [ "$("$W" eval 'return new Set([...document.querySelectorAll(".plan-pod-profile")].map((e) => e.textContent)).size' | tr -d '"')" -ge $SEEDED_PROFILES ] && break
  sleep 5
done
design "Floor plan"; "$W" shot "$p-01-plan-dark"; check plan
"$W" eval 'const s=document.querySelector(".office-scroll"); s.scrollTop=s.scrollHeight; return s.scrollTop' >/dev/null; sleep 0.5; "$W" shot "$p-01b-plan-scrolled"; "$W" eval 'document.querySelector(".office-scroll").scrollTop=0; return 0' >/dev/null
"$W" click '.plan-desk' "Read the auth code" >/dev/null; sleep 1; "$W" shot "$p-02-plan-card"; "$W" press Escape >/dev/null; sleep 0.5
"$W" click '.office-design .office-pop-btn' >/dev/null; sleep 0.5; "$W" shot "$p-03-design-menu"; "$W" press Escape >/dev/null
design "Board"; "$W" shot "$p-04-board-dark"; check board
"$W" eval 'const s=document.querySelector(".office-scroll"); s.scrollTop=300; return s.scrollTop' >/dev/null; sleep 0.5; "$W" shot "$p-04c-board-scrolled"; "$W" eval 'const s=document.querySelector(".office-scroll"); const h=document.querySelector(".board-head").getBoundingClientRect(), r=s.getBoundingClientRect(); s.scrollTop=0; return "board head top "+Math.round(h.top)+" vs scroll top "+Math.round(r.top)'
"$W" click '.board-chip' "Read the auth code" >/dev/null; sleep 1; "$W" shot "$p-04b-board-card"; check board-card; "$W" press Escape >/dev/null; sleep 0.5
"$W" click '.office-scope .office-pop-btn' >/dev/null; sleep 0.5; "$W" shot "$p-05-profile-menu"; "$W" press Escape >/dev/null
design "Floor plan"; scope default; "$W" shot "$p-06-plan-default-only"; check plan-default
scope forge; "$W" shot "$p-06b-plan-forge-only"; "$W" text .office-elsewhere
scope aegis; "$W" shot "$p-07-plan-empty-profile"
scope "All profiles"
design "List"; "$W" shot "$p-08-list"
design "Floor plan"
"$W" press Control+, >/dev/null; sleep 1; "$W" click button Appearance >/dev/null; sleep 0.5; "$W" click '[role=radio]' Light >/dev/null; sleep 0.5; "$W" press Escape >/dev/null; sleep 1
"$W" count .office >/dev/null 2>&1 || open_office
"$W" wait .plan "" 10000 >/dev/null || open_office
"$W" shot "$p-09-plan-light"
design "Board"; "$W" shot "$p-10-board-light"
"$W" press Control+, >/dev/null; sleep 1; "$W" click button Appearance >/dev/null; sleep 0.5; "$W" click '[role=radio]' Dark >/dev/null; sleep 0.5; "$W" press Escape >/dev/null; sleep 1
"$W" wait .board "" 10000 >/dev/null || open_office
size 900 820
"$W" shot "$p-11-board-narrow"; check board-narrow
design "Floor plan"; "$W" shot "$p-12-plan-narrow"; check plan-narrow
size 1090 820
"$W" shot "$p-13-plan-760"; check plan-760
design "Board"; "$W" shot "$p-14-board-760"; check board-760
echo "shots done"
