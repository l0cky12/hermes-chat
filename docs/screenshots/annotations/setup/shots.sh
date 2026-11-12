#!/usr/bin/env bash
# Annotations (#96) in the real Linux app, against the stand-in dashboard and the synthetic pages in site/ and other/.
# Needs a run from `hv up` (HV_RUN), the app signed in once (features/sign-in.md), the window at hv's 1400x900, and
#   python3 -m http.server 5187 --bind 127.0.0.1 -d site   and   python3 -m http.server 5188 --bind 127.0.0.1 -d other
# The screen coordinates below are the page's elements as hv's 1400x900 Xvfb and openbox place the window.
set -uo pipefail
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
X="$S/hv x"
. "$HV_RUN/state.env"
captures() { find "$HV_RUN/cache/hermes-chat/captures" -name '*.png' -printf '%P\n' 2>/dev/null | sort | tr '\n' ' '; echo; }
point() { $X mousemove $(($1 - 6)) $(($2 - 4)); sleep 0.3; $X mousemove "$1" "$2"; sleep 1.5; }
press() { $X mousedown 1; sleep 0.12; $X mouseup 1; }
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fi; }

$W click button "Nightly backup failing" || true
$W wait textarea[data-composer] "" 20000
$W click button "Open the side panel" || true
$W fill input Address -- "localhost:5187/"
$W press Enter
$W click button "Open on this computer instead" || true
$W wait 'button[aria-label=Annotate]:not([disabled])' "" 30000
sleep 2
$S/hv shot 01-page
echo "captures before: $(captures)"

# Point at the Save button, climb to its form and back, and pick it.
$W click 'button[aria-label=Annotate]'
$W wait '.annotate-stage img' "" 20000
sleep 1
point 1010 303
check "hover names the real button" '[ "$($W text .annotate-tag)" = "html > body > main > form#profile > button.primary" ]'
$S/hv shot 02-picking
$X key Up; sleep 1.2
check "Up climbs to the form" '[ "$($W text .annotate-tag)" = "html > body > main > form#profile" ]'
$X key Down; sleep 1.2
press
$W wait '[aria-label="Review the annotation"]' "" 20000
$W fill 'textarea[placeholder="What should change here?"]' -- "make this match the secondary button"
$S/hv shot 03-review
check "the card has the real computed colour" '$W text .annotate-lines | grep -q "background-color rgb(30, 160, 80)"'
$W click button "Add to message"
$W wait .chip "annotation-1.png" 20000
sleep 1
$S/hv shot 04-staged
$W value 'textarea[data-composer]' >"$EVIDENCE/04-composer.txt"
check "the words are in the composer" 'grep -q "Note: make this match the secondary button" "$EVIDENCE/04-composer.txt"'
check "no secret from the page is in the words" '! grep -qE "hunter2|CSRF999|TOK123|SECRETSIG|session-8f3a|owner@example.com|LIED" "$EVIDENCE/04-composer.txt"'
check "nothing was sent" '! grep -qE "image.attach_bytes|prompt.submit" "$EVIDENCE/bridge.log"'
echo "captures after Add: $(captures)"

# Another site's frame gives a region; Escape steps back, and Escape again cancels and deletes the still.
$W click 'button[aria-label=Annotate]'
$W wait '.annotate-stage img' "" 20000
sleep 1
point 1005 545
press
$W wait '[aria-label="Review the annotation"]' "" 20000
$S/hv shot 05-other-site
check "another site's frame is a region naming its host" '$W text .annotate-lines | grep -q "Region: This part comes from 127.0.0.1:5188"'
echo "captures while reviewing: $(captures)"
$X key Escape; sleep 0.5; $X key Escape
$W gone .annotate "" 10000
sleep 1
echo "captures after Escape: $(captures)"
check "Escape twice cancels and keeps only annotation-1" '[ "$(captures | tr -d " \n" | sed "s#^[0-9]*/[0-9]*/##")" = "annotation-1.png" ]'

# A dragged region.
$W click 'button[aria-label=Annotate]'
$W wait '.annotate-stage img' "" 20000
sleep 1
$W drag .annotate-stage -- 10 280 330 330
$W wait '[aria-label="Review the annotation"]' "" 20000
$S/hv shot 06-region
check "a dragged region has no element details" '$W text .annotate-lines | grep -q "Region: You drew this region"'
$W click button "Cancel"
$W gone .annotate "" 10000

# The page moves on: the staged chip says so.
$X mousemove 924 382; sleep 0.2; press; sleep 2
$W wait .chip-note "page changed" 10000
$S/hv shot 07-page-changed
check "the chip says the page changed" '$W eval "return document.querySelector(\".chip\").title" | grep -q "The page has changed since"'
