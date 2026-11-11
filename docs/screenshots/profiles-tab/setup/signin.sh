#!/bin/sh
# Setup → Web address route → sign in to the throwaway dashboard, through the real app (verify-hermes-chat skill).
# Needs S (the skill's scripts) and HV_RUN set.
set -e
$S/wd.mjs click button "Get started"
$S/wd.mjs select select "Connect through" -- "Web address"
$S/wd.mjs fill input "Dashboard URL" -- http://127.0.0.2:21550
$S/wd.mjs click button "Test the route"
$S/wd.mjs wait '[role=status]' "Reached Hermes" 60000
$S/wd.mjs click button Next
$S/wd.mjs fill input "Dashboard username" -- verify
$S/wd.mjs fill input "Dashboard password" -- verify-pass
$S/wd.mjs click button "Test connection"
$S/wd.mjs wait '[role=status]' "At least one route works" 90000
$S/wd.mjs click button "Save and connect"
$S/wd.mjs wait '[role=dialog]' "Model providers" 60000
$S/wd.mjs wait .setup-ok "" 60000 || true
$S/wd.mjs click button Skip
$S/wd.mjs gone '[role=dialog]' 30000
