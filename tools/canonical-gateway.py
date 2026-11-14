"""Runs a real Hermes gateway whose own listener serves the dashboard, for sessionProtocol.live.test.ts (ADR 0174).

On that listener `/api/ws` speaks the canonical session protocol (`gateway.ready.session_authority`), behind the same
password sign-in the app uses. This is `hermes gateway run` with the Webapp on (`webapp.enabled`), unchanged but for two
things that are not protocol code:

- It binds the address you give instead of `webapp.host`, which takes only `127.0.0.1`, `::1`, `localhost` or a
  wildcard. The address must be an IPv4 `127.x.x.x` other than `127.0.0.1`: Hermes turns the sign-in gate off on that
  one literal, and anything outside 127.0.0.0/8 opens the port to the network.
- It serves a one-line page instead of the built Webapp bundle, so nothing is written to the Hermes checkout.

Every run starts on a new, empty folder under `~/.cache/hermes-canonical-runs/`: `HOME`, `HERMES_HOME`, the gateway's
lock folder and the XDG folders all point inside it, and every other `HERMES_*` variable is dropped. Its
`config.yaml` names the stub model (`tools/canonical-stub-model.py`) with `approvals.mode: manual`. The owner's
`~/.hermes` is never used: a run folder, a Python or a Hermes checkout under it is refused, and a file operation that
reaches it (symlinks resolved) ends the process. `--self-check` proves those guards without starting anything.

Run it with the Python of a Hermes checkout outside `~/.hermes`:

    /usr/bin/python3 -I tools/canonical-stub-model.py 127.0.0.3 47554 &
    env -i PATH=/usr/bin:/bin \\
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME=owner HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<password> \\
      HERMES_DASHBOARD_BASIC_AUTH_SECRET=<32 random characters> \\
      ~/.cache/hermes-venv-168/bin/python tools/canonical-gateway.py 127.0.0.2 47552 http://127.0.0.3:47554/v1

Then:

    HERMES_LIVE_CANONICAL=http://127.0.0.2:47552/ HERMES_LIVE_USER=owner HERMES_LIVE_PASSWORD=<password> \\
      HERMES_LIVE_STUB=1 npx vitest run src/hermes/sessionProtocol.live.test.ts
"""
import dataclasses
import ipaddress
import os
import importlib.util
import pwd
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# The account's home from the password database: `HOME` can be repointed, this can't.
USER_HOME = Path(pwd.getpwuid(os.getuid()).pw_dir)
REAL_HERMES = (USER_HOME / ".hermes").resolve()
RUNS = USER_HOME / ".cache" / "hermes-canonical-runs"
GATE_OFF = ipaddress.IPv4Address("127.0.0.1")
LOOPBACK = ipaddress.IPv4Network("127.0.0.0/8")
# Audit events whose arguments name a path (docs.python.org/3/library/audit_events.html).
PATH_EVENTS = {
    "open", "os.listdir", "os.scandir", "os.mkdir", "os.remove", "os.rmdir", "os.rename", "os.link", "os.symlink",
    "os.truncate", "os.utime", "os.chmod", "os.chown", "os.chdir", "os.chflags", "os.setxattr", "os.removexattr",
    "os.listxattr", "os.getxattr", "sqlite3.connect", "shutil.copyfile", "shutil.copymode", "shutil.copystat",
    "shutil.copytree", "shutil.move", "shutil.rmtree", "glob.glob", "pathlib.Path.glob", "pathlib.Path.rglob",
}


def bind_address(host):
    """`host` as an IPv4 address in 127.0.0.0/8 other than 127.0.0.1, or exits."""
    try:
        address = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError:
        sys.exit(f"{host}: bind an IPv4 127.x.x.x literal other than 127.0.0.1, not a name or another address")
    if address not in LOOPBACK or address == GATE_OFF:
        sys.exit(f"{host}: bind a 127.x.x.x other than 127.0.0.1, so the sign-in gate is on and the port stays local")
    return str(address)


def inside(path, protected):
    resolved = Path(path).resolve()
    return resolved == protected or protected in resolved.parents


def refuse_inside(path, what, protected=REAL_HERMES):
    if inside(path, protected):
        sys.exit(f"{what} {path} is inside {protected}, the owner's Hermes home: refusing to touch it")


def tripwire(protected):
    """Ends the process when a file operation names a path inside `protected`."""
    busy = False

    def hook(event, args):
        nonlocal busy
        if busy or event not in PATH_EVENTS:
            return
        busy = True
        try:
            for arg in args:
                if isinstance(arg, (str, bytes, os.PathLike)) and arg and inside(os.fsdecode(arg), protected):
                    os.write(2, f"canonical-gateway: {event} {os.fsdecode(arg)} reached {protected}, stopping\n".encode())
                    os._exit(70)
        except (OSError, ValueError):
            pass
        finally:
            busy = False

    sys.addaudithook(hook)


def fresh_run(runs=RUNS, protected=REAL_HERMES):
    """A new, empty run folder, and the environment that keeps Hermes inside it. Checks where `runs` leads before
    creating anything, so a symlink there into `protected` makes nothing inside it."""
    refuse_inside(runs, "the runs folder", protected)
    runs.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="run-", dir=runs)).resolve()
    refuse_inside(root, "the run folder", protected)
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_") or k.startswith("HERMES_DASHBOARD_BASIC_AUTH_")}
    env.update(
        HOME=str(root / "home"),
        HERMES_HOME=str(root / "hermes"),
        HERMES_GATEWAY_LOCK_DIR=str(root / "locks"),
        XDG_CONFIG_HOME=str(root / "xdg" / "config"),
        XDG_DATA_HOME=str(root / "xdg" / "data"),
        XDG_STATE_HOME=str(root / "xdg" / "state"),
        XDG_CACHE_HOME=str(root / "xdg" / "cache"),
    )
    for key in ("HOME", "HERMES_HOME", "HERMES_GATEWAY_LOCK_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        Path(env[key]).mkdir(parents=True)
    return root, env


def self_check():
    """Proves the bind check and the home guards, and starts nothing. Exits 0 when every check holds."""
    failures = []

    def expect(ok, what):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    def exits(fn):
        try:
            fn()
        except SystemExit as e:
            return e.code not in (None, 0)
        return False

    for host in ("127.0.0.1", "0.0.0.0", "192.168.1.5", "10.0.0.2", "localhost", "hermes.lan", "::1", "127.1", ""):
        expect(exits(lambda: bind_address(host)), f"refuses to bind {host!r}")
    for host in ("127.0.0.2", "127.0.0.52", "127.255.255.254"):
        expect(not exits(lambda: bind_address(host)), f"binds {host!r}")

    expect(exits(lambda: refuse_inside(USER_HOME / ".hermes", "a home")), f"refuses the owner's Hermes home {REAL_HERMES}")
    expect(exits(lambda: refuse_inside(USER_HOME / ".hermes" / "profiles" / "x", "a home")), "refuses a folder inside it")
    refuse_inside(RUNS, "the runs folder")
    RUNS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=RUNS) as scratch:
        link = Path(scratch) / "looks-throwaway"
        link.symlink_to(USER_HOME / ".hermes", target_is_directory=True)
        expect(exits(lambda: refuse_inside(link, "a home")), "refuses a symlink that leads to it")
        expect(exits(lambda: refuse_inside(link / "config.yaml", "a file")), "refuses a path through that symlink")

        root, env = fresh_run()
        expect(not exits(lambda: refuse_inside(root, "the run folder")), f"accepts a fresh run folder {root}")
        expect(all(not inside(env[k], REAL_HERMES) and inside(env[k], root) for k in ("HOME", "HERMES_HOME", "HERMES_GATEWAY_LOCK_DIR", "XDG_STATE_HOME")),
               "points HOME, HERMES_HOME, the lock folder and XDG state inside the run folder")
        (Path(env["HERMES_HOME"]) / "config.yaml").write_text("left by the last run\n")
        root2, env2 = fresh_run()
        expect(root2 != root and not any(Path(env2["HERMES_HOME"]).iterdir()), "starts the next run on another, empty Hermes home")
        for r in (root, root2):
            shutil.rmtree(r)

        # The tripwire, on a stand-in for ~/.hermes so the check itself never reaches the real one.
        stand_in = Path(scratch) / "stand-in-hermes"
        stand_in.mkdir()
        (stand_in / "auth.json").write_text("{}")
        back_door = Path(scratch) / "back-door"
        back_door.symlink_to(stand_in, target_is_directory=True)
        probe = f"import runpy, sys; g = runpy.run_path({__file__!r}, run_name='tripwire'); g['tripwire'](g['Path'](sys.argv[1]).resolve()); "
        for target, what in ((stand_in / "auth.json", "a file in it"), (back_door / "auth.json", "a file through a symlink to it"), (stand_in, "a listing of it")):
            action = f"import os; os.listdir({str(target)!r})" if target == stand_in else f"open({str(target)!r}).read()"
            ran = subprocess.run([sys.executable, "-I", "-c", probe + action, str(stand_in)], capture_output=True, text=True)
            expect(ran.returncode == 70, f"stops the process on reading {what} (exit {ran.returncode})")
        ran = subprocess.run([sys.executable, "-I", "-c", probe + f"open({str(Path(scratch) / 'elsewhere')!r}, 'w').write('x')", str(stand_in)], capture_output=True, text=True)
        expect(ran.returncode == 0, f"lets it write outside (exit {ran.returncode})")

        # A runs folder that is a symlink into the stand-in: refused before anything is made there.
        runs_link = Path(scratch) / "runs-link"
        runs_link.symlink_to(stand_in, target_is_directory=True)
        before = sorted(p.name for p in stand_in.iterdir())
        expect(exits(lambda: fresh_run(runs_link / "hermes-canonical-runs", stand_in.resolve())), "refuses a runs folder that leads into it")
        expect(sorted(p.name for p in stand_in.iterdir()) == before, "makes nothing inside it on the way")

    sys.exit(1 if failures else 0)


def main():
    if sys.argv[1:] == ["--self-check"]:
        self_check()
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    host, port, model_url = bind_address(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    refuse_inside(sys.executable, "the Python")
    refuse_inside(Path(__file__), "this script")

    tripwire(REAL_HERMES)
    root, env = fresh_run()
    os.environ.clear()
    os.environ.update(env)
    home, work, dist = root / "hermes", root / "work", root / "dist"
    work.mkdir()
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>stub</title>\n")
    (home / "config.yaml").write_text(
        f"model:\n  default: fake\n  provider: custom\n  base_url: {model_url}\n  api_key: sk-fake\n  context_length: 64000\n"
        f"terminal:\n  backend: local\n  cwd: {work}\n"
        "approvals:\n  mode: manual\n"
        f"webapp:\n  enabled: true\n  host: 127.0.0.1\n  port: {port}\n"
        "onboarding:\n  seen:\n    profile_build_offered: true\n"
    )
    print(f"canonical-gateway: run folder {root}", flush=True)

    refuse_inside(importlib.util.find_spec("gateway").origin, "the Hermes checkout")
    import gateway.webapp_listener as listener

    stock_plan = listener.listener_plan

    def plan(hermes_home):
        _, planned_port, mount, reason = stock_plan(hermes_home)
        if mount is None:
            sys.exit(f"the Webapp is off, so this gateway has no listener to sign in to: {reason or 'webapp.enabled is not true'}")
        return host, planned_port, dataclasses.replace(mount, dist=dist), reason

    listener.listener_plan = plan

    from hermes_cli.main import main as hermes

    os.chdir(work)
    sys.argv = ["hermes", "gateway", "run", "--force"]
    hermes()


if __name__ == "__main__":
    main()
