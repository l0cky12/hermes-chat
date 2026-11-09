#!/bin/bash
# Signs the run named by $HV_RUN in to the throwaway dashboard at $HV_DASHBOARD, following features/sign-in.md.
set -e
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
URL=${HV_DASHBOARD:-http://127.0.0.6:19819}
$S/wd.mjs open
$S/wd.mjs wait button "Get started" 60000
$S/wd.mjs click button "Get started"
$S/wd.mjs select select "Connect through" -- "Web address"
$S/wd.mjs fill input "Dashboard URL" -- "$URL"
$S/wd.mjs click button "Test the route"
$S/wd.mjs wait '[role=status]' "Reached Hermes" 60000
$S/wd.mjs click button Next
$S/wd.mjs fill input "Dashboard username" -- verify
$S/wd.mjs fill input "Dashboard password" -- verify-pass
$S/wd.mjs click button "Test connection"
$S/wd.mjs wait '[role=status]' "At least one route works" 90000
$S/wd.mjs click button "Save and connect"
$S/wd.mjs wait '[role=dialog]' "Model providers" 60000
$S/wd.mjs wait button Skip 60000
sleep 3
$S/wd.mjs click button Skip
$S/wd.mjs gone '[role=dialog]' 30000
$S/wd.mjs wait button "Search all chats (Ctrl+K)" 30000
