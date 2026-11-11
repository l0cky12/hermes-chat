#!/bin/sh
# A real gateway the throwaway server's host gateway (default), which serves every profile, so Hermes lists it with gateway_running.
cd /tmp/hermes-447/src
exec env -i PATH=/usr/bin:/bin HOME=/tmp/hermes-447/home HERMES_HOME=/tmp/hermes-447/home/.hermes \
  /home/liam/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run
