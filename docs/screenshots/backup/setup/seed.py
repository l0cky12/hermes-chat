# Seeds a throwaway HERMES_HOME (and its "work" profile) with synthetic chats for the backup checks. No real data.
import os, time
from pathlib import Path
from hermes_state import SessionDB
now = time.time()
def seed(home, chats):
    home.mkdir(parents=True, exist_ok=True)
    db = SessionDB(home / "state.db")
    for i, (sid, title, rows) in enumerate(chats):
        db.create_session(sid, source="gui", model="stub-model")
        t = now - 3600 * (i + 1)
        for role, content in rows:
            t += 30
            db.append_message(sid, role, content, timestamp=t)
        db.set_session_title(sid, title)
    db.close()
home = Path(os.environ["HERMES_HOME"])
seed(home, [
    ("20261104_090000_aaaa01", "NAS disk usage", [("user", "How full is the NAS?"), ("assistant", "The NAS is 81% full: 5.9 TB of 7.3 TB used on /srv.")]),
    ("20261104_080000_bbbb02", "Rotate nginx logs", [("user", "Rotate the nginx logs"), ("assistant", "Done: logs rotated, nginx restarted.")]),
    ("20261104_070000_cccc03", "Restic retention policy", [("user", "What retention should restic keep?"), ("assistant", "Keep 7 daily, 4 weekly and 6 monthly snapshots.")]),
])
seed(home / "profiles" / "work", [
    ("20261104_100000_dddd04", "Quarterly report outline", [("user", "Outline the Q4 report"), ("assistant", "1. Summary 2. Metrics 3. Risks 4. Next steps")]),
])
(home / "profiles" / "work" / "config.yaml").write_text("model:\n  default: stub-model\n  provider: custom\n  base_url: http://127.0.0.2:19752/v1\n  api_key: \"\"\n")
print("seeded")
