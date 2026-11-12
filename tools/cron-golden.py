"""Writes src/hermes/cronGolden.json: what Hermes's own scheduler makes of schedules, for schedule.test.ts.

Runs Hermes's real `cron.jobs.parse_schedule` and `compute_next_run` with the clock and the profile's timezone
pinned, so the app's schedule preview is checked against the server's code, DST transitions included. It reads and
writes no job store. Run it from the repo root with the Python of a Hermes checkout:

    HERMES_HOME=$(mktemp -d) ~/.hermes/hermes-agent/venv/bin/python tools/cron-golden.py ~/.hermes/hermes-agent
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

checkout = os.path.expanduser(sys.argv[1])
sys.path.insert(0, checkout)
from cron import jobs

ZONES = ["America/Chicago", "Europe/London", "Australia/Lord_Howe", "America/Santiago", "Asia/Kolkata"]
# Starts a day or so before each zone's 2026/27 transitions, plus an ordinary day.
BASES = {
    "America/Chicago": ["2026-11-01T00:10:00", "2027-03-14T00:10:00", "2026-11-01T01:20:00-05:00", "2026-11-01T01:20:00-06:00", "2026-06-10T12:00:00"],
    "Europe/London": ["2026-10-25T00:10:00", "2027-03-28T00:10:00", "2026-10-25T01:40:00+00:00", "2026-07-01T08:00:00"],
    "Australia/Lord_Howe": ["2026-10-04T01:00:00", "2027-04-04T01:00:00", "2027-04-04T01:40:00+10:30"],
    "America/Santiago": ["2026-09-05T22:00:00", "2027-04-03T22:00:00"],
    "Asia/Kolkata": ["2026-11-02T10:00:00"],
}
EXPRS = [
    "30 2 * * *", "0 2 * * *", "30 1 * * *", "0 1 * * *", "15 0 * * *", "*/15 * * * *", "0 * * * *",
    "0 9 * * 1-5", "0 0 * * *", "15 3 * * 0", "0 9 1 * 1", "0 9 */2 * 1", "0 22-2 * * *", "0 9 * * 5-1",
    "0 0 29 2 *", "5/20 1-3 * * *", "0 9 1 jan,jul *", "0 12 * * sun", "0 9 * * 7", "0 9 1 * */1", "45 23 31 * *",
    # Wrapping weekday ranges with steps, and steps over Sunday's two names.
    "0 9 * * 5-1/2", "0 9 * * 6-2/3", "0 9 * * sat-tue", "0 9 * * 0-7/2", "0 9 * * 1-7", "0 9 * * 7-2", "* 0,12 * * *",
    # Stepped single values take the whole cycle; a day field naming every day is `*` only beside a `*`.
    "0 9 * * 6/2", "59/2 * * * *", "0 9 */2 * */1", "0 9 */1 * 1", "0 9 1 * 0-6", "0 9 2-31/2 * 1",
]
INTERVALS = [30, 90, 1440]
PARSE = [
    "every 30m", "30m", "2h", "1d", "every 2 hours", "hour", "every day at 9am", "every monday 9am",
    "weekdays at 9:30pm", "every mon, wed and fri at noon", "every weekend at midnight", "monday 7",
    "every monday 13pm", "0 9 * * *", "0 9 * * MON-FRI", "0 9 * *", "61 9 * * *", "0 9 * * * 30", "*/0 * * * *",
    "in 30m", "in 2h", "in banana", "2026-11-05T15:00", "2026-11-05T15:00:00Z", "2026-11-05", "2026-11-02T09:00",
    "2026-13-05T15:00", "every banana", "banana", "", "every 0m", "0m",
]
NOW = "2026-11-02T14:00:00-06:00"


def pin(zone: str, now: datetime) -> None:
    tz = ZoneInfo(zone)
    jobs.get_timezone = lambda: tz
    jobs._hermes_now = lambda: now.astimezone(tz)


def aware(text: str, zone: str) -> datetime:
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo(zone))


def chain(schedule: dict, base: datetime, n: int = 8) -> list[str]:
    runs, last = [], base.isoformat()
    for _ in range(n):
        last = jobs.compute_next_run(schedule, last)
        if last is None:
            break
        runs.append(last)
    return runs


out = {"hermes": subprocess.run(["git", "-C", checkout, "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=False).stdout.strip(),
       "cron": [], "interval": [], "parse": []}
for zone in ZONES:
    for base_text in BASES[zone]:
        base = aware(base_text, zone)
        pin(zone, base)
        for expr in EXPRS:
            out["cron"].append({"zone": zone, "expr": expr, "base": base.isoformat(), "runs": chain(jobs.parse_schedule(expr), base)})
        for minutes in INTERVALS:
            out["interval"].append({"zone": zone, "minutes": minutes, "base": base.isoformat(),
                                    "runs": chain({"kind": "interval", "minutes": minutes}, base, 4)})
for zone in ["America/Chicago", "Europe/London"]:
    now = datetime.fromisoformat(NOW)
    pin(zone, now)
    for text in PARSE:
        try:
            result = jobs.parse_schedule(text)
            out["parse"].append({"zone": zone, "now": now.isoformat(), "input": text, "result": result})
        except Exception as e:  # noqa: BLE001 - what the dashboard answers 400 with
            out["parse"].append({"zone": zone, "now": now.isoformat(), "input": text, "error": str(e)})

with open("src/hermes/cronGolden.json", "w") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(f"{len(out['cron'])} cron chains, {len(out['interval'])} interval chains, {len(out['parse'])} parses")
