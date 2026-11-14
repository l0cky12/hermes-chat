"""Runs a real Hermes gateway whose own listener serves the dashboard, for sessionProtocol.live.test.ts (ADR 0174).

On that listener `/api/ws` speaks the canonical session protocol (`gateway.ready.session_authority`), behind the same
password sign-in the app uses. This is `hermes gateway run` with the Webapp on (`webapp.enabled`), unchanged but for two
things that are not protocol code:

- It binds the address you give instead of `webapp.host`, which takes only `127.0.0.1`, `::1`, `localhost` or a
  wildcard. A `127.0.0.x` other than `127.0.0.1` keeps the sign-in gate on without opening the port to the network.
- It serves a one-line page instead of the built Webapp bundle, so nothing is written to the Hermes checkout.

Use a throwaway `HERMES_HOME`, never the owner's. A new one gets a `config.yaml` whose model is the stub
(`tools/canonical-stub-model.py`), with `approvals.mode: manual`. Run it with the Python of a Hermes checkout:

    L=~/.cache/hermes-canonical; mkdir -p $L/home $L/hermes
    /usr/bin/python3 -I tools/canonical-stub-model.py 127.0.0.3 47554 &
    env -i PATH=/usr/bin:/bin HOME=$L/home HERMES_HOME=$L/hermes HERMES_GATEWAY_LOCK_DIR=$L/hermes \\
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME=owner HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<password> \\
      HERMES_DASHBOARD_BASIC_AUTH_SECRET=<32 random characters> \\
      ~/.hermes/hermes-agent/venv/bin/python tools/canonical-gateway.py 127.0.0.2 47552 http://127.0.0.3:47554/v1

Then:

    HERMES_LIVE_CANONICAL=http://127.0.0.2:47552/ HERMES_LIVE_USER=owner HERMES_LIVE_PASSWORD=<password> \\
      HERMES_LIVE_STUB=1 npx vitest run src/hermes/sessionProtocol.live.test.ts
"""
import dataclasses
import os
import sys
from pathlib import Path

host, port, model_url = sys.argv[1], int(sys.argv[2]), sys.argv[3]
if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0", "::"):
    sys.exit(f"{host}: bind a 127.0.0.x other than 127.0.0.1, so the sign-in gate is on and the port stays local")
home = Path(os.environ.get("HERMES_HOME") or sys.exit("set HERMES_HOME to a throwaway folder"))
if home.resolve() == (Path.home() / ".hermes").resolve():
    sys.exit(f"{home} is the default Hermes home: use a throwaway one")

work, dist = home.parent / "work", home.parent / "dist"
for folder in (home, work, dist):
    folder.mkdir(parents=True, exist_ok=True)
(dist / "index.html").write_text("<!doctype html><title>stub</title>\n")
config = home / "config.yaml"
if not config.exists():
    config.write_text(
        f"model:\n  default: fake\n  provider: custom\n  base_url: {model_url}\n  api_key: sk-fake\n  context_length: 64000\n"
        f"terminal:\n  backend: local\n  cwd: {work}\n"
        "approvals:\n  mode: manual\n"
        f"webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: {port}\n"
        "onboarding:\n  seen:\n    profile_build_offered: true\n"
    )

import gateway.webapp_listener as listener  # noqa: E402

stock_plan = listener.listener_plan


def plan(hermes_home):
    _, planned_port, mount, reason = stock_plan(hermes_home)
    if mount is None:
        sys.exit(f"the Webapp is off, so this gateway has no listener to sign in to: {reason or 'webapp.enabled is not true'}")
    return host, planned_port, dataclasses.replace(mount, dist=dist), reason


listener.listener_plan = plan

from hermes_cli.main import main  # noqa: E402

os.chdir(work)
sys.argv = ["hermes", "gateway", "run", "--force"]
main()
