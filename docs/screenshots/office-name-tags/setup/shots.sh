#!/usr/bin/env bash
# The shots, on a signed-in and seeded run (hv.sh up, signin.sh, seed.sh): the office at its home view, the same seen
# from above, and the real X pointer over a character, then on its tag. Prints every floor label's box after each.
# Needs HV_RUN and FLOORS (how many profiles the tower shows). $1 is a prefix for the shot names ("before", "after").
set -euo pipefail
S=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)/.hv-459/skills/verify-hermes-chat/scripts
p=${1:-shot}
boxes='const r=document.querySelector(".office-canvas").getBoundingClientRect();
  const b=[...document.querySelectorAll(".office-floor-tag")].map(t=>[t.textContent,t.getBoundingClientRect(),t.hasAttribute("data-off")]);
  const hit=(a,c)=>a.left<c.right&&c.left<a.right&&a.top<c.bottom&&c.top<a.bottom;
  const over=b.flatMap(([n,a],i)=>b.slice(i+1).filter(([,c])=>hit(a,c)).map(([m])=>n+"/"+m));
  const out=b.filter(([,a,off])=>off||a.left<r.left||a.top<r.top||a.right>r.right||a.bottom>r.bottom).map(([n])=>n);
  return b.length+" labels; overlapping pairs: "+(over.join(", ")||"none")+"; hidden or not wholly inside the canvas: "+(out.join(", ")||"none");'
# A delegating reply on the open floor, so there are characters to hover.
"$S/wd.mjs" click button "New chat (Ctrl+N)"
# Right after sign-in the first click into the composer can be intercepted while the window settles.
for i in 1 2 3 4 5; do "$S/wd.mjs" click 'textarea[data-composer]' && break; sleep 2; done
"$S/wd.mjs" keys 'delegate the audit\n'
"$S/wd.mjs" wait .msg Delegating 60000
"$S/wd.mjs" click button Office
"$S/wd.mjs" wait .office-building
# The app learns other profiles 20 per check, every 30 s while the office is open; FLOORS is how many the tower should
# show. Then the counts, which come from session.active_list every 15 s.
for i in $(seq 1 30); do [ "$("$S/wd.mjs" eval 'return document.querySelectorAll(".office-floor-tag").length')" -ge "${FLOORS:-0}" ] && break; sleep 5; done
sleep 25
"$S/wd.mjs" shot "$p-1-home"
"$S/wd.mjs" eval "$boxes"
# From above: drag the canvas down with real X input, as the owner turns the building.
"$S/hv" x mousemove 900 450; sleep 0.2; "$S/hv" x mousedown 1
for y in $(seq 470 25 720); do "$S/hv" x mousemove 900 "$y"; sleep 0.1; done
"$S/hv" x mouseup 1; sleep 2
"$S/wd.mjs" shot "$p-2-from-above"
"$S/wd.mjs" eval "$boxes"
"$S/wd.mjs" click button "Reset view"; sleep 3
# The window's offset on screen, from a real pointer move, then the pointer onto the reply's character: 25 px under
# where its (hidden) tag stands, which is over its head.
"$S/wd.mjs" eval 'window.__off=undefined; addEventListener("mousemove",(e)=>{window.__off=[e.screenX-e.clientX,e.screenY-e.clientY]},{capture:true,once:true}); return "listening"'
"$S/hv" x mousemove 700 400; sleep 0.2; "$S/hv" x mousemove 701 401; sleep 0.5
read -r ox oy < <("$S/wd.mjs" eval 'return window.__off.join(" ")' | tr -d '"')
read -r tx ty < <("$S/wd.mjs" eval 'const t=document.querySelector(".office-tag:not(.is-stale)"), m=new DOMMatrix(getComputedStyle(t).transform), c=document.querySelector(".office-canvas").getBoundingClientRect(); return Math.round(c.left+m.m41)+" "+Math.round(c.top+m.m42)' | tr -d '"')
"$S/hv" x mousemove $((ox + tx)) $((oy + ty + 25)); sleep 0.3; "$S/hv" x mousemove $((ox + tx)) $((oy + ty + 26)); sleep 1
"$S/wd.mjs" eval 'const t=document.querySelector(".office-tag[data-hover]"); return t ? "hovered: "+t.getAttribute("aria-label") : "no tag shown"'
"$S/wd.mjs" shot "$p-3-hover-character"
# From the head up onto its tag, which takes longer than nothing but less than the grace: the tag stays.
"$S/hv" x mousemove $((ox + tx)) $((oy + ty - 8)); sleep 1
"$S/wd.mjs" eval 'const t=document.querySelector(".office-tag[data-hover]"); return t ? "still shown, pointer on it: "+t.matches(":hover")+", "+t.getAttribute("aria-label") : "no tag shown"'
"$S/wd.mjs" shot "$p-4-pointer-on-tag"
# The top floor's label (the issue's clipped one, talos) is a real button: a click opens its floor.
"$S/wd.mjs" eval 'const t=[...document.querySelectorAll(".office-floor-tag")].at(-1); return t.getAttribute("aria-label")'
"$S/wd.mjs" click .office-floor-tag talos
sleep 2
"$S/wd.mjs" text .office-floor-open
"$S/wd.mjs" shot "$p-5-top-floor-opened"
