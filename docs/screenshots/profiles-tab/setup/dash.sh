#!/bin/sh
# Throwaway Hermes v0.22.6 (f0d94882) dashboard for #447's screenshots: its own HOME/HERMES_HOME, loopback 127.0.0.2:21550.
cd /tmp/hermes-447/src
exec env -i PATH=/usr/bin:/bin HOME=/tmp/hermes-447/home HERMES_HOME=/tmp/hermes-447/home/.hermes \
  HERMES_DASHBOARD_BASIC_AUTH_USERNAME=verify HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=verify-pass HERMES_DASHBOARD_BASIC_AUTH_SECRET=throwaway-secret-447 \
  /home/liam/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main dashboard --port 21550 --host 127.0.0.2 --skip-build --no-open
