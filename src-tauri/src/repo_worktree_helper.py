
# ── worktrees (ADR 0043) ────────────────────────────────────────────────────
#
# The second half of the helper: creating, listing, setting up and removing worktrees of the repository on the
# server. Rust sends this file after repo_git_helper.py as one program, so everything above is in scope here: `git`,
# `run`, `Refusal`, `checkout`, `snapshot`, `in_progress`, `check_branch_name`, `git_line`.
#
# What this app made is recorded in the repository itself, in `<git common dir>/hermes-chat/managed-worktrees.json`,
# changed only while holding an exclusive flock on `worktrees.lock` beside it. (`worktrees.json` there is the first
# Worktrees design's record, ADR 0042, in another format: it is never read or written here.) So every desktop and every
# copy of the app sees the same owners and chats, and an attach and a removal can't both pass their checks at once. A worktree this app
# made is also locked with `git worktree lock` and a reason naming it, so `git worktree remove` and `prune` elsewhere
# leave it alone.
#
# Nothing here deletes a branch, resets, cleans, or forces anything implicitly. A removal keeps every change it would
# lose first, in a commit under refs/hermes-chat/kept/, and refuses while any chat is attached, any process works in
# the folder, or the files changed since the owner looked.

import fcntl
import time

# `git worktree list --porcelain -z` needs Git 2.36.
WORKTREE_GIT = (2, 36)
RECORD_DIR = "hermes-chat"
RECORD_FILE = "managed-worktrees.json"
RECORD_VERSION = 1
LOCK_REASON = "hermes-chat: managed worktree "
KEPT_PREFIX = "refs/hermes-chat/kept/"
# Hermes's own worktree clean-up (`hermes_cli/worktree_ops._prune_orphaned_branches`) deletes, with `branch -D`, local
# branches with these names that no worktree has checked out: a branch made here must never be one of them.
SWEPT_BRANCH = re.compile(r"^(hermes/hermes-|pr-)")
ID = re.compile(r"^[0-9a-f]{8,40}$")
# A file bigger than this isn't kept by a removal: it would go into the repository's objects. The removal is refused.
MAX_KEEP_FILE = 100 * 1024 * 1024
# The most worktrees whose files and commits a list reads; the rest are listed by name only.
MAX_DETAIL = 40
MAX_LOG = 64 * 1024
MAX_LISTED = 2000
# The most ignored files and folders a removal's stamp reads, one by one. Past it, later changes to the rest aren't seen.
MAX_IGNORED_WALK = 1000000
MAX_INCLUDE = 200
PROGRESS = "\x1fhermes-progress\x1f"
# A test makes setup wait between entries, to cut it off part way.
SETUP_DELAY = float(os.environ.get("HERMES_REPO_TEST_SETUP_DELAY") or 0)
# How long a change waits for another one in the same repository to finish. A test makes it short.
LOCK_WAIT = float(os.environ.get("HERMES_REPO_TEST_LOCK_WAIT") or 15)


def progress(step, message, **extra):
    """A progress line on stderr, which Rust passes on to the screen as it comes (repo_git.rs, `run_streaming`)."""
    line = dict(extra, step=step, message=message, at=time.time())
    try:
        sys.stderr.write(PROGRESS + json.dumps(line) + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001 - a screen that stopped listening doesn't stop the work
        pass


def git_version(top):
    m = re.search(r"(\d+)\.(\d+)", git_line(["version"], top))
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def need_worktree_git(top):
    v = git_version(top)
    if v < WORKTREE_GIT:
        raise Refusal("unsupported", "Worktrees here need Git %d.%d or newer on the server; it has %d.%d." % (WORKTREE_GIT + v))


def common_dir(top):
    return text(git_ok(["rev-parse", "--path-format=absolute", "--git-common-dir"], top)).strip()


def within(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def list_trees(top):
    """Every worktree Git knows, the main one first: path, HEAD, branch, and its lock and prunable notes."""
    out = git_ok(["worktree", "list", "--porcelain", "-z"], top)
    trees, cur = [], None
    for raw in out.split(b"\0"):
        f = text(raw)
        if not f:
            cur = None
            continue
        if f.startswith("worktree "):
            cur = {"path": f[9:], "head": None, "branch": None, "detached": False, "bare": False, "locked": None, "prunable": None}
            trees.append(cur)
        elif cur is None:
            continue
        elif f.startswith("HEAD "):
            cur["head"] = f[5:]
        elif f.startswith("branch "):
            ref = f[7:]
            cur["branch"] = ref[11:] if ref.startswith("refs/heads/") else ref
        elif f == "detached":
            cur["detached"] = True
        elif f == "bare":
            cur["bare"] = True
        elif f == "locked" or f.startswith("locked "):
            cur["locked"] = f[7:]
        elif f == "prunable" or f.startswith("prunable "):
            cur["prunable"] = f[9:]
    for i, t in enumerate(trees):
        t["main"] = i == 0
    return trees


# ── the record: who made which worktree, and which chats work in it ─────────


def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            return f.read().strip()
    except OSError:
        return ""


def started(pid):
    """When process `pid` started (clock ticks since boot), or None when there's no such process."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            return int(f.read().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def me():
    return {"pid": os.getpid(), "boot": boot_id(), "start": started(os.getpid()), "at": time.time()}


def alive(runner):
    """Whether the helper that marked a record busy is still running: same boot, and a process with its pid that
    started when it did (so a reused pid doesn't count)."""
    if not isinstance(runner, dict) or not isinstance(runner.get("pid"), int):
        return False
    if runner.get("boot") and boot_id() and runner["boot"] != boot_id():
        return False
    now = started(runner["pid"])
    if now is None:
        if os.path.isdir("/proc/self"):
            return False
        try:
            os.kill(runner["pid"], 0)
            return True
        except OSError:
            return False
    return runner.get("start") is None or now == runner.get("start")


INTERRUPTED = {"creating": "create-interrupted", "setup": "setup-interrupted", "removing": "remove-interrupted"}


def state_of(rec):
    s = rec.get("state")
    if s in INTERRUPTED and not alive(rec.get("run")):
        return INTERRUPTED[s]
    return s


class Records:
    """The record file, held under an exclusive flock while it is read, checked and written."""

    def __init__(self, top):
        self.dir = os.path.join(common_dir(top), RECORD_DIR)
        self.file = os.path.join(self.dir, RECORD_FILE)
        self.fd = None
        self.doc = None

    def read(self):
        try:
            with open(self.file, "rb") as f:
                doc = json.loads(f.read().decode("utf-8"))
        except FileNotFoundError:
            doc = {}
        except (OSError, ValueError) as e:
            raise Refusal("bad-record", "This app's worktree record in %s can't be read (%s). Nothing was changed." % (self.file, e))
        if not isinstance(doc, dict):
            doc = {}
        doc.setdefault("v", RECORD_VERSION)
        if not isinstance(doc.get("worktrees"), dict):
            doc["worktrees"] = {}
        if not isinstance(doc.get("kept"), list):
            doc["kept"] = []
        return doc

    def __enter__(self):
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.fd = os.open(os.path.join(self.dir, "worktrees.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        deadline = time.time() + LOCK_WAIT
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.time() > deadline:
                    os.close(self.fd)
                    self.fd = None
                    raise Refusal("busy", "Another worktree change in this repository is still running. Nothing was changed. Try again in a moment.")
                time.sleep(0.1)
        try:
            self.doc = self.read()
        except BaseException:
            self.__exit__()
            raise
        if not isinstance(self.doc.get("v"), int) or self.doc["v"] > RECORD_VERSION:
            self.__exit__()
            raise Refusal("unsupported", "A newer Hermes Chat wrote this repository's worktree record. Update this app to change it.")
        return self

    def save(self):
        self.doc["v"] = RECORD_VERSION
        tmp = "%s.%d.tmp" % (self.file, os.getpid())
        with open(tmp, "wb") as f:
            f.write(json.dumps(self.doc, indent=1, sort_keys=True).encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.file)
        dfd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        return False


def rec_view(rec):
    view = {k: v for k, v in rec.items() if k != "run"}
    view["state"] = state_of(rec)
    view["running"] = rec.get("state") in INTERRUPTED and alive(rec.get("run"))
    return view


def record_id(req):
    i = req.get("id")
    if not isinstance(i, str) or not ID.match(i):
        raise Refusal("internal", "That isn't a worktree id this app made.")
    return i


def short_text(value, what, limit=200):
    if not isinstance(value, str) or not value or len(value) > limit or re.search(r"[\x00-\x1f]", value):
        raise Refusal("internal", "The request's %s isn't valid." % what)
    return value


def tree_at(trees, path):
    real = os.path.realpath(path)
    return next((t for t in trees if t["path"] == path or os.path.realpath(t["path"]) == real), None)


# ── what a worktree holds ───────────────────────────────────────────────────


def setup_links(rec):
    """The links setup made in a worktree that are still those links: not changes of the owner's."""
    links = set()
    path = rec.get("path") or ""
    for e in (rec.get("setup") or {}).get("entries") or []:
        if e.get("action") == "link" and e.get("result") == "linked":
            # A record written before entries lost their trailing slash may still have one.
            entry = (e.get("entry") or "").rstrip("/")
            full = os.path.join(path, entry)
            if entry and os.path.islink(full) and os.readlink(full) == e.get("target"):
                links.add(entry)
    return links


def changes(path, links):
    """The worktree's changed, staged, conflicted and untracked paths, from one status read, with the upstream."""
    code, out, err = git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=none"], path)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git status failed.", text(err))
    fields = out.split(b"\0")
    rows, info = [], {"upstream": None, "ahead": None, "behind": None}
    i = 0
    while i < len(fields):
        f = text(fields[i])
        i += 1
        if not f:
            continue
        if f.startswith("# branch.upstream "):
            info["upstream"] = f[18:]
        elif f.startswith("# branch.ab "):
            m = re.match(r"# branch\.ab \+(\d+) -(\d+)", f)
            if m:
                info["ahead"], info["behind"] = int(m.group(1)), int(m.group(2))
        elif f.startswith("1 "):
            parts = f.split(" ", 8)
            rows.append({"kind": "change", "xy": parts[1], "sub": parts[2] != "N...", "path": parts[8]})
        elif f.startswith("2 "):
            parts = f.split(" ", 9)
            rows.append({"kind": "change", "xy": parts[1], "sub": parts[2] != "N...", "path": parts[9], "from": text(fields[i])})
            i += 1
        elif f.startswith("u "):
            parts = f.split(" ", 10)
            rows.append({"kind": "conflict", "xy": parts[1], "sub": parts[2] != "N...", "path": parts[10]})
        elif f.startswith("? "):
            if f[2:].rstrip("/") not in links:
                rows.append({"kind": "untracked", "xy": "??", "sub": False, "path": f[2:]})
    return rows, info


def hidden_changes(path):
    """Tracked files whose changes Git doesn't report because of an index flag: `assume-unchanged`, or `skip-worktree`
    for a file that is on disk anyway. Each is compared with its staged blob; one that differs, or can't be compared
    (a link), is a change status never shows."""
    code, out, _ = git(["ls-files", "-z", "-v", "--stage"], path)
    found = []
    if code != 0:
        return found
    for raw in out.split(b"\0"):
        line = text(raw)
        if not line or "\t" not in line:
            continue
        head, rel = line.split("\t", 1)
        parts = head.split(" ")
        tag, mode, oid = parts[0], parts[1], parts[2]
        if not (tag.islower() or tag == "S"):
            continue
        full = os.path.join(path, rel)
        if not os.path.lexists(full):
            continue
        if mode == "160000" or os.path.isdir(full):
            continue
        if os.path.islink(full) or not os.path.isfile(full):
            found.append(rel)
            continue
        c, o, _ = git(["hash-object", "--path", rel, "--", rel], path)
        if c != 0 or text(o).strip() != oid:
            found.append(rel)
    return found


def counts(rows):
    c = {"staged": 0, "unstaged": 0, "untracked": 0, "conflicts": 0}
    for r in rows:
        if r["kind"] == "untracked":
            c["untracked"] += 1
        elif r["kind"] == "conflict":
            c["conflicts"] += 1
        else:
            c["staged"] += r["xy"][0] != "."
            c["unstaged"] += r["xy"][1] != "."
    return c


def commits_only_here(path, detached):
    """Commits no remote has (`unpublished`), and for a detached HEAD, those no branch, tag or remote has either: the
    ones removing the worktree would leave unreachable."""
    if not git_line(["rev-parse", "-q", "--verify", "HEAD^{commit}"], path):
        return 0, 0
    unpublished = int(git_line(["rev-list", "--count", "HEAD", "--not", "--remotes"], path) or 0)
    lost = int(git_line(["rev-list", "--count", "HEAD", "--not", "--branches", "--tags", "--remotes"], path) or 0) if detached else 0
    return unpublished, lost


def submodules(path, depth=0):
    """The submodules checked out in a worktree (recursively), each with what removing the folder would lose."""
    out = []
    code, raw, _ = git(["ls-files", "--stage", "-z"], path)
    if code != 0:
        return out
    for line in raw.split(b"\0"):
        line = text(line)
        if not line.startswith("160000 "):
            continue
        rel = line.split("\t", 1)[1]
        full = os.path.join(path, rel)
        if not os.path.exists(os.path.join(full, ".git")):
            continue
        sub_rows, _ = changes(full, set())
        # Its Git folder goes with the worktree: every local branch and tag, and the stash, not only HEAD, would go too.
        unpublished = int(git_line(["rev-list", "--count", "HEAD", "--branches", "--tags", "--not", "--remotes"], full) or 0)
        if git_line(["rev-parse", "-q", "--verify", "refs/stash"], full):
            unpublished += 1
        out.append({"path": rel, "dirty": len(sub_rows), "unpublished": unpublished})
        if depth < 3:
            out.extend({"path": rel + "/" + s["path"], "dirty": s["dirty"], "unpublished": s["unpublished"]} for s in submodules(full, depth + 1))
    return out


def processes_in(path):
    """Processes of this user whose folder is inside `path` (an agent, a shell, a build), this helper aside."""
    found, root = [], os.path.realpath(path)
    skip = {os.getpid(), os.getppid()}
    try:
        pids = [int(p) for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return None
    for pid in pids:
        if pid in skip:
            continue
        try:
            cwd = os.readlink("/proc/%d/cwd" % pid)
        except OSError:
            continue
        if within(cwd, root):
            try:
                with open("/proc/%d/comm" % pid) as f:
                    name = f.read().strip()
            except OSError:
                name = "?"
            found.append({"pid": pid, "name": name, "cwd": cwd})
    return found


def tree_facts(t, rec, detail):
    facts = dict(t)
    facts["exists"] = os.path.isdir(t["path"]) and not t["bare"]
    facts["managed"] = rec_view(rec) if rec else None
    facts["dirty"] = None
    facts["unpublished"] = None
    facts["lost"] = None
    facts["upstream"] = facts["ahead"] = facts["behind"] = None
    facts["submodules"] = None
    if facts["exists"] and detail:
        try:
            rows, info = changes(t["path"], setup_links(rec) if rec else set())
            facts["dirty"] = counts(rows)
            facts.update(info)
            facts["unpublished"], facts["lost"] = commits_only_here(t["path"], t["detached"])
            facts["submodules"] = len(submodules(t["path"]))
        except Refusal as r:
            facts["error"] = r.message
    facts["protected"] = protection(t, rec)
    return facts


def ours(t, rec_id):
    return t.get("locked") == LOCK_REASON + rec_id


def protection(t, rec):
    """Why a worktree can't be removed from here, whatever it holds."""
    why = []
    if t["main"]:
        why.append({"kind": "main", "message": "This is the repository's main checkout."})
    if not rec:
        why.append({"kind": "unmanaged", "message": "Hermes Chat didn't make this worktree, so it doesn't remove it."})
    elif rec.get("protected"):
        why.append({"kind": "marked", "message": "It's marked Protected."})
    locked = t.get("locked")
    if locked is not None and not (rec and (ours(t, rec["id"]) or (locked == "initializing" and state_of(rec) == "create-interrupted"))):
        why.append({"kind": "locked", "message": "It's locked by another tool%s." % (": %s" % locked if locked else "")})
    return why


# ── list ────────────────────────────────────────────────────────────────────


def kept_refs(top):
    out = git_line(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(subject)", KEPT_PREFIX], top)
    kept = []
    for line in out.splitlines():
        parts = line.split("\0")
        if len(parts) == 4:
            kept.append({"ref": parts[0], "commit": parts[1], "at": int(parts[2] or 0), "subject": parts[3]})
    return kept


def op_worktree_list(req):
    top, _ = checkout(req.get("repo"))
    need_worktree_git(top)
    trees = list_trees(top)
    doc = Records(top).read()
    recs = doc["worktrees"]
    by_path = {}
    for rec in recs.values():
        if isinstance(rec, dict) and rec.get("path"):
            by_path[os.path.realpath(rec["path"])] = rec
    listed, seen = [], set()
    for i, t in enumerate(trees):
        rec = by_path.get(os.path.realpath(t["path"]))
        if rec:
            seen.add(rec["id"])
        listed.append(tree_facts(t, rec, i < MAX_DETAIL))
    # Records whose worktree Git doesn't list: a creation cut off before Git made it, or one removed by hand.
    missing = [dict(rec_view(rec), exists=os.path.lexists(rec.get("path") or "")) for rec in recs.values() if isinstance(rec, dict) and rec.get("id") not in seen]
    kept_by_ref = {k.get("ref"): k for k in doc["kept"] if isinstance(k, dict)}
    kept = [dict(kept_by_ref.get(k["ref"], {}), **k) for k in kept_refs(top)]
    return {
        "top": top,
        "main": trees[0]["path"] if trees else top,
        "commonDir": common_dir(top),
        "worktrees": listed,
        "missing": missing,
        "kept": kept,
        "detailLimit": MAX_DETAIL,
        "git": "%d.%d" % git_version(top),
    }


# ── plan and create ─────────────────────────────────────────────────────────


def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40].rstrip("-")
    return s or "work"


def resolve_commit(top, ref):
    ref = ref.strip() if isinstance(ref, str) else ""
    # Checked after the strip: " -x" is the ref "-x", which reads as an option.
    if not ref or ref.startswith("-") or re.search(r"[\x00-\x1f]", ref):
        raise Refusal("bad-ref", "Enter the base as a branch, tag or commit, such as main or origin/main.")
    code, out, _ = git(["rev-parse", "-q", "--verify", "--end-of-options", ref + "^{commit}"], top)
    if code != 0:
        raise Refusal("bad-ref", "There's no commit %s in this repository. The screen never fetches: fetch it first if it's on a remote." % ref)
    oid = text(out).strip()
    # The ref was checked above not to start with "-"; rev-parse would print an --end-of-options back.
    full = git_line(["rev-parse", "--symbolic-full-name", ref], top)
    if "\n" in full:
        full = ""
    subject = git_line(["log", "-1", "--format=%s", oid], top)
    return ref, oid, full or None, subject


def plan_branch(top, branch, new, trees):
    check_branch_name(branch, top)
    if SWEPT_BRANCH.match(branch):
        raise Refusal(
            "bad-branch",
            "Hermes's own worktree clean-up deletes branches named hermes/hermes-… or pr-… that no worktree has checked "
            "out, unpushed work and all. Pick another name, so the branch is kept after its worktree is removed.",
        )
    tip = git_line(["rev-parse", "-q", "--verify", "refs/heads/%s^{commit}" % branch], top) or None
    if new and tip:
        raise Refusal("branch-exists", "There's already a branch %s. Choose Existing branch to use it, or pick another name." % branch)
    if not new:
        if not tip:
            raise Refusal("not-found", "There's no local branch %s. Choose New branch to make it." % branch)
        holder = next((t for t in trees if t["branch"] == branch), None)
        if holder:
            raise Refusal("checked-out", "%s is already checked out in %s. Git allows a branch in one worktree at a time." % (branch, holder["path"]))
    return tip


def suggested_path(main, branch):
    parent, name = os.path.split(main.rstrip("/"))
    if name.endswith(".git"):
        name = name[:-4] or "repo"
    base = os.path.join(parent, "%s-%s" % (name, slug(branch)))
    path, n = base, 2
    while os.path.lexists(path):
        path, n = "%s-%d" % (base, n), n + 1
    return path


def plan_path(raw, trees, common):
    if not isinstance(raw, str) or not raw.strip() or re.search(r"[\x00-\x1f]", raw):
        raise Refusal("bad-path", "Enter the new worktree's full path on the server.")
    p = os.path.expanduser(raw.strip())
    if not os.path.isabs(p):
        raise Refusal("bad-path", "Enter a full path on the server, starting with / or ~.")
    if any(part in (".", "..") for part in p.split("/")):
        raise Refusal("bad-path", "Enter the path without . or .. in it.")
    p = os.path.normpath(p)
    parent, name = os.path.split(p)
    if not name or name.startswith("-"):
        raise Refusal("bad-path", "Enter a folder name at the end of the path.")

    def inside_a_worktree(candidate):
        for t in trees:
            for root in (os.path.normpath(t["path"]), os.path.realpath(t["path"])):
                if within(candidate, root):
                    raise Refusal(
                        "bad-path",
                        "%s is inside the worktree %s. Its files would show as changes there, and Hermes's own clean-up "
                        "removes worktrees under .worktrees. Pick a folder outside every worktree." % (candidate, t["path"]),
                    )

    inside_a_worktree(p)
    if not os.path.isdir(parent):
        raise Refusal("not-found", "There's no folder %s on the server. Make it first, or pick another place." % parent)
    final = os.path.join(os.path.realpath(parent), name)
    if os.path.lexists(final):
        raise Refusal("exists", "%s is already there. Pick a path that doesn't exist yet." % final)
    if not os.access(os.path.realpath(parent), os.W_OK | os.X_OK):
        raise Refusal("denied", "The SSH user can't make a folder in %s." % parent)
    inside_a_worktree(final)
    if within(final, os.path.realpath(common)):
        raise Refusal("bad-path", "%s is inside the repository's Git folder." % final)
    return final


def include_entries(source):
    try:
        with open(os.path.join(source, ".worktreeinclude"), "rb") as f:
            raw = f.read(256 * 1024).decode("utf-8-sig", "replace")
    except OSError:
        return []
    entries = [line.strip() for line in raw.splitlines()]
    return [e for e in entries if e and not e.startswith("#")][:MAX_INCLUDE]


def tracked(source, entry):
    code, out, _ = git(["ls-files", "-z", "--", entry], source)
    return code == 0 and bool(out.strip(b"\0"))


def include_plan(source, dest):
    """What setup would do with each `.worktreeinclude` entry: copy a file, link a folder, or skip it and why. The same
    guards as Hermes's own setup (`_copy_worktree_includes`): both ends must stay inside their checkouts. A path Git
    tracks is skipped, so a change to a tracked file in the source checkout is never carried over."""
    plan = []
    root = os.path.realpath(source)
    for written in include_entries(source):
        # `node_modules/` names the folder `node_modules`, as in .gitignore. Kept with the slash, the link would be
        # made inside the folder it names: an empty folder is made, and the link fails.
        entry = written.rstrip("/") or written
        folder_only = entry != written
        item = {"entry": entry, "action": "skip", "reason": None, "size": None}
        src = os.path.join(source, entry)
        dst = os.path.normpath(os.path.join(dest, entry))
        if entry.startswith("/") or "\0" in entry or os.path.normpath(entry) in (".", ""):
            item["reason"] = "It isn't a path relative to the checkout."
        elif not within(os.path.realpath(src), root):
            item["reason"] = "It points outside the checkout."
        elif not within(dst, os.path.normpath(dest)):
            item["reason"] = "It would land outside the new worktree."
        elif not os.path.lexists(src):
            item["reason"] = "There's nothing at that path in %s." % source
        elif tracked(source, entry):
            item["reason"] = "Git tracks it, so the worktree gets it from the base commit."
        elif os.path.isfile(src) and folder_only:
            item["reason"] = "It ends in /, so it names a folder, and %s is a file." % entry
        elif os.path.isfile(src):
            item["action"], item["size"] = "copy", os.path.getsize(src)
        elif os.path.isdir(src):
            item["action"], item["target"] = "link", os.path.realpath(src)
        else:
            item["reason"] = "It isn't a file or a folder."
        plan.append(item)
    return plan


def gitmodules(top, oid):
    code, out, _ = git(["config", "--blob", "%s:.gitmodules" % oid, "-z", "--get-regexp", r"^submodule\..*\.path$"], top)
    if code != 0:
        return []
    return [text(item).split("\n", 1)[1] for item in out.split(b"\0") if b"\n" in item]


def make_plan(req):
    top, _ = checkout(req.get("repo"))
    need_worktree_git(top)
    trees = list_trees(top)
    common = common_dir(top)
    new = req.get("newBranch") is not False
    branch = req.get("branch")
    if not isinstance(branch, str):
        raise Refusal("bad-branch", "Enter a branch name.")
    branch = branch.strip()
    tip = plan_branch(top, branch, new, trees)
    if new:
        base, oid, full, subject = resolve_commit(top, req.get("base"))
    else:
        base, oid, full, subject = branch, tip, "refs/heads/" + branch, git_line(["log", "-1", "--format=%s", tip], top)
    main = trees[0]["path"] if trees else top
    raw_path = req.get("path") if isinstance(req.get("path"), str) and req.get("path").strip() else suggested_path(main, branch)
    path = plan_path(raw_path, trees, common)
    source_rows, _ = changes(top, set())
    setup = include_plan(top, path)
    plan = {
        "repo": top,
        "main": main,
        "source": top,
        "base": base,
        "baseOid": oid,
        "baseRef": full,
        "baseSubject": subject,
        "branch": branch,
        "newBranch": new,
        "path": path,
        "suggested": not (isinstance(req.get("path"), str) and req.get("path").strip()),
        "sourceDirty": counts(source_rows),
        "submodules": gitmodules(top, oid),
        "setup": setup,
        "setupCommands": "unsupported",
    }
    plan["stamp"] = hashlib.sha256(json.dumps([oid, branch, new, tip, path, setup], sort_keys=True).encode()).hexdigest()
    return plan


def op_worktree_plan(req):
    return make_plan(req)


SETUP_FROM = ("ready", "setup-failed", "setup-interrupted", "create-interrupted")


def run_setup(top, rec_id, allowed):
    """Runs setup for a worktree: each `.worktreeinclude` entry once, logged. Re-running it (Retry) leaves what an
    earlier run did, and never overwrites a file that differs: that could be the owner's own edit. It's claimed under
    the record's lock, only from a state in `allowed` and only while no other run holds it, and only the run that
    claimed it writes its outcome: two Retries can't both run."""
    runner = me()
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not rec:
            raise Refusal("not-found", "This app has no record of that worktree.")
        if rec.get("state") in INTERRUPTED and alive(rec.get("run")):
            raise Refusal("busy", "Setup or another change is already running in this worktree.")
        if state_of(rec) not in allowed:
            raise Refusal("not-needed", "Setup has already run for this worktree." if state_of(rec) == "ready" else "Setup can't run now: the worktree is %s." % state_of(rec))
        rec["state"], rec["run"] = "setup", runner
        rec["setup"] = dict(rec.get("setup") or {}, state="running", startedAt=time.time(), finishedAt=None)
        R.save()
        source, path = rec["source"], rec["path"]
    progress("setup", "Running setup from %s/.worktreeinclude" % source)
    entries, log, failed = [], [], 0
    root = os.path.realpath(path)
    for item in include_plan(source, path):
        if SETUP_DELAY:
            time.sleep(SETUP_DELAY)
        entry, src, dst = item["entry"], os.path.join(source, item["entry"]), os.path.join(path, item["entry"])
        done = dict(item, result="skipped")
        try:
            if item["action"] == "skip":
                done["result"], line = "skipped", "Skipped %s: %s" % (entry, item["reason"])
            elif not within(os.path.realpath(os.path.dirname(dst)), root):
                done["result"], line = "skipped", "Skipped %s: it would land outside the worktree through a link." % entry
            elif item["action"] == "copy":
                if os.path.lexists(dst):
                    same = os.path.isfile(dst) and not os.path.islink(dst) and open(dst, "rb").read() == open(src, "rb").read()
                    done["result"] = "present" if same else "kept"
                    line = "%s is already there%s" % (entry, "." if same else " and differs, so it was left as it is.")
                else:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(src, dst)
                    done["result"], line = "copied", "Copied %s (%d bytes)" % (entry, item["size"] or 0)
            else:
                if os.path.islink(dst) and os.readlink(dst) == item["target"]:
                    done["result"], line = "linked", "%s is already linked." % entry
                elif os.path.lexists(dst):
                    done["result"], line = "kept", "Something is already at %s, so it wasn't linked." % entry
                else:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    os.symlink(item["target"], dst)
                    done["result"], line = "linked", "Linked %s to %s" % (entry, item["target"])
        except OSError as e:
            failed += 1
            done["result"], done["error"] = "failed", e.strerror or str(e)
            line = "Failed %s: %s" % (entry, done["error"])
        entries.append(done)
        log.append(line)
        progress("setup", line, entry=entry, result=done["result"])
    if not entries:
        log.append("No .worktreeinclude in %s: nothing to set up." % source)
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if rec and rec.get("run") != runner:
            raise Refusal("busy", "Another run took over this worktree's setup meanwhile; its outcome is in the list.")
        if rec:
            ok = failed == 0
            rec["setup"] = dict(rec.get("setup") or {}, state="done" if ok else "failed", finishedAt=time.time(), entries=entries, log="\n".join(log)[-MAX_LOG:])
            rec["state"] = "ready" if ok else "setup-failed"
            rec.pop("run", None)
            R.save()
            return rec_view(rec)
    raise Refusal("not-found", "The worktree's record went away during setup.")


def op_worktree_create(req):
    """Makes the worktree the plan showed, only if the plan still holds: same base commit, branch, path and setup. The
    record is written first, so a creation cut off part way (a dropped ssh) is found and finished or discarded later."""
    rec_id = record_id(req)
    top, _ = checkout(req.get("repo"))
    if rec_id in Records(top).read()["worktrees"]:
        raise Refusal("duplicate", "This worktree was already asked for. Refresh the list to see how far it got.")
    plan = make_plan(req)
    if plan["stamp"] != req.get("expect"):
        raise Refusal("stale", "Something changed since the preview (the base moved, the branch or the folder appeared, or the setup list changed). Nothing was created. Check the new preview.")
    top = plan["repo"]
    with Records(top) as R:
        if rec_id in R.doc["worktrees"]:
            raise Refusal("duplicate", "This worktree was already asked for. Refresh the list to see how far it got.")
        # One record per folder, checked under the lock: two creations for the same path can't both be recorded.
        real = os.path.realpath(plan["path"])
        other = next((r for r in R.doc["worktrees"].values() if isinstance(r, dict) and os.path.realpath(r.get("path") or "") == real), None)
        if other or os.path.lexists(plan["path"]):
            raise Refusal("exists", "%s is already there, or another creation is making it. Nothing was created. Check the new preview." % plan["path"])
        before_paths = {os.path.realpath(t["path"]) for t in list_trees(top)}
        if real in before_paths:
            raise Refusal("exists", "Git already has a worktree at %s. Nothing was created." % plan["path"])
        rec = {
            "id": rec_id,
            "path": plan["path"],
            "branch": plan["branch"],
            "newBranch": plan["newBranch"],
            "base": plan["base"],
            "baseOid": plan["baseOid"],
            "source": plan["source"],
            "createdAt": time.time(),
            "createdBy": "hermes-chat",
            "protected": False,
            "state": "creating",
            "run": me(),
            "setup": {"state": "pending" if req.get("setup") else "skipped", "entries": [], "log": ""},
            "chats": [],
        }
        R.doc["worktrees"][rec_id] = rec
        R.save()
    progress("create", "Creating %s on %s from %s" % (plan["path"], plan["branch"], plan["baseOid"][:12]))
    if plan["newBranch"]:
        args = ["worktree", "add", "--no-track", "-b", plan["branch"], plan["path"], plan["baseOid"]]
    else:
        args = ["worktree", "add", plan["path"], plan["branch"]]
    code, out, err = git(args, top, read_only=False, timeout=900)
    output = (text(out) + text(err)).strip()
    made = tree_at(list_trees(top), plan["path"])
    # Adopted only when this run's Git made it: it wasn't there before, Git didn't say the path or branch existed, and
    # it has the branch asked for.
    ours_made = (
        made is not None
        and made.get("branch") == plan["branch"]
        and "already exists" not in output
        and "already checked out" not in output
        and "already used by worktree" not in output
    )
    if code != 0 and ours_made and made.get("locked") != "initializing" and os.path.isdir(plan["path"]):
        # Git made the worktree and checked it out, then something after (a post-checkout hook) failed. It's kept,
        # recorded, as a setup that failed: Retry, Open, or Remove it from the list.
        git(["worktree", "lock", "--reason", LOCK_REASON + rec_id, plan["path"]], top, read_only=False)
        with Records(top) as R:
            rec = R.doc["worktrees"].get(rec_id)
            rec["state"] = "setup-failed"
            rec.pop("run", None)
            rec["createOutput"] = output[-MAX_LOG:]
            rec["setup"] = dict(rec.get("setup") or {}, state="failed", finishedAt=time.time(),
                                log=("Git made the worktree, but what ran after it failed (a post-checkout hook):\n%s" % output)[-MAX_LOG:])
            R.save()
            return {"worktree": rec_view(rec), "output": output}
    if code != 0:
        with Records(top) as R:
            R.doc["worktrees"].pop(rec_id, None)
            R.save()
        made = plan["newBranch"] and git_line(["rev-parse", "-q", "--verify", "refs/heads/%s" % plan["branch"]], top)
        note = " The branch %s was made at %s and is kept." % (plan["branch"], plan["baseOid"][:12]) if made else ""
        raise Refusal("git", "Git couldn't make the worktree.%s" % note, output)
    progress("create", "Git made the worktree.", output=output[-4000:])
    git(["worktree", "lock", "--reason", LOCK_REASON + rec_id, plan["path"]], top, read_only=False)
    locked = tree_at(list_trees(top), plan["path"])
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not locked or locked.get("locked") != LOCK_REASON + rec_id:
            # Not locked as this app's: something else holds it. It stays recorded, as a failed setup, for the owner.
            rec["state"] = "setup-failed"
            rec.pop("run", None)
            rec["setup"] = dict(rec.get("setup") or {}, state="failed", finishedAt=time.time(),
                                log="Git made the worktree, but it couldn't be locked as this app's (its lock: %r)." % ((locked or {}).get("locked"),))
            R.save()
            return {"worktree": rec_view(rec), "output": output}
        rec["state"] = "ready"
        rec.pop("run", None)
        rec["createOutput"] = output[-MAX_LOG:]
        if not req.get("setup"):
            R.save()
            return {"worktree": rec_view(rec), "output": output}
        R.save()
    return {"worktree": run_setup(top, rec_id, ("ready",)), "output": output}


def op_worktree_setup(req):
    """Retry: setup again, after it failed or was cut off, or finishing a creation cut off after Git made the
    worktree. Never once it worked: setup runs once."""
    rec_id = record_id(req)
    top, _ = checkout(req.get("repo"))
    need_worktree_git(top)
    rec = Records(top).read()["worktrees"].get(rec_id)
    if not rec:
        raise Refusal("not-found", "This app has no record of that worktree.")
    state = state_of(rec)
    tree = tree_at(list_trees(top), rec["path"])
    if not tree:
        raise Refusal("not-found", "The worktree at %s isn't there any more." % rec["path"])
    if state == "create-interrupted":
        if tree.get("locked") == "initializing":
            raise Refusal("unfinished", "Git didn't finish making this worktree, so setup can't run in it. Remove it, or forget it if its folder isn't there.")
        if tree.get("locked") is None:
            git(["worktree", "lock", "--reason", LOCK_REASON + rec_id, rec["path"]], top, read_only=False)
        if (rec.get("setup") or {}).get("state") == "skipped":
            with Records(top) as R:
                rec = R.doc["worktrees"][rec_id]
                if state_of(rec) != "create-interrupted":
                    raise Refusal("busy", "Another run took over this worktree meanwhile; its outcome is in the list.")
                rec["state"] = "ready"
                rec.pop("run", None)
                R.save()
                return {"worktree": rec_view(rec)}
    return {"worktree": run_setup(top, rec_id, ("setup-failed", "setup-interrupted", "create-interrupted"))}


# ── chats ───────────────────────────────────────────────────────────────────


def op_worktree_attach(req):
    """Holds a place for a chat about to start in the worktree, before Hermes is asked. From now on the worktree can't
    be removed, until the owner detaches the chat."""
    rec_id = record_id(req)
    token = record_id({"id": req.get("token")})
    profile = short_text(req.get("profile"), "profile")
    connection = short_text(req.get("connection"), "connection", 300)
    top, _ = checkout(req.get("repo"))
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not rec:
            raise Refusal("not-found", "This app has no record of that worktree.")
        state = state_of(rec)
        if state in ("creating", "setup", "removing", "create-interrupted", "remove-interrupted"):
            raise Refusal("not-ready", "A chat can't start there now: the worktree is %s." % state.replace("-", " "))
        if not tree_at(list_trees(top), rec["path"]) or not os.path.isdir(rec["path"]):
            raise Refusal("not-found", "The worktree at %s isn't there any more." % rec["path"])
        rec.setdefault("chats", []).append({"token": token, "chat": None, "profile": profile, "connection": connection, "state": "starting", "at": time.time()})
        R.save()
        return rec_view(rec)


def op_worktree_attach_confirm(req):
    rec_id = record_id(req)
    token = record_id({"id": req.get("token")})
    chat = short_text(req.get("chat"), "chat")
    top, _ = checkout(req.get("repo"))
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        held = next((c for c in (rec or {}).get("chats", []) if c.get("token") == token), None)
        if not held:
            raise Refusal("not-found", "The chat's place in this worktree was released meanwhile.")
        held["chat"], held["state"], held["at"] = chat, "attached", time.time()
        R.save()
        return rec_view(rec)


def op_worktree_detach(req):
    rec_id = record_id(req)
    token = record_id({"id": req.get("token")})
    top, _ = checkout(req.get("repo"))
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not rec:
            raise Refusal("not-found", "This app has no record of that worktree.")
        before = len(rec.get("chats", []))
        rec["chats"] = [c for c in rec.get("chats", []) if c.get("token") != token]
        if len(rec["chats"]) != before:
            R.save()
        return rec_view(rec)


def op_worktree_protect(req):
    rec_id = record_id(req)
    top, _ = checkout(req.get("repo"))
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not rec:
            raise Refusal("not-found", "This app has no record of that worktree.")
        rec["protected"] = req.get("protected") is True
        R.save()
        return rec_view(rec)


# ── removal: preview, keep, remove ──────────────────────────────────────────


def removal_facts(top, rec):
    """Everything removing the worktree would touch, what it can't keep, and a stamp of it all."""
    trees = list_trees(top)
    tree = tree_at(trees, rec["path"])
    path = rec["path"]
    facts = {"path": path, "branch": None, "head": None, "detached": False, "files": [], "filesCut": False, "ignored": [],
             "unpublished": [], "unpublishedCount": 0, "lost": 0, "submodules": [], "processes": [], "blockers": [], "operation": None}
    block = facts["blockers"]
    if not tree or not os.path.isdir(path):
        block.append({"kind": "missing", "message": "The worktree isn't there any more. Forget it to drop this app's record."})
        facts["stamp"] = "missing"
        return facts, tree
    facts["head"], facts["branch"], facts["detached"] = tree["head"], tree["branch"], tree["detached"]
    block.extend(protection(tree, rec))
    state = state_of(rec)
    if rec.get("state") in INTERRUPTED and alive(rec.get("run")):
        block.append({"kind": "busy", "message": "Hermes Chat is still %s it." % {"creating": "making", "setup": "setting up", "removing": "removing"}[rec["state"]]})
    if rec.get("chats"):
        block.append({"kind": "chats", "message": "%d chat%s work%s in it. Detach them first; a quiet chat still counts." % (
            len(rec["chats"]), "" if len(rec["chats"]) == 1 else "s", "s" if len(rec["chats"]) == 1 else "")})
    links = setup_links(rec)
    rows, _ = changes(path, links)
    listed = {r["path"] for r in rows}
    rows = rows + [{"kind": "change", "xy": ".H", "sub": False, "path": rel, "hidden": True} for rel in hidden_changes(path) if rel not in listed]
    stamped = []
    for r in rows:
        snap = snapshot(path, r["path"])
        size = None
        try:
            size = os.lstat(os.path.join(path, r["path"])).st_size if snap[1] in ("file", "big") else None
        except OSError:
            pass
        row = {"path": r["path"], "from": r.get("from"), "kind": r["kind"], "xy": r["xy"], "sub": r["sub"], "size": size, "hidden": bool(r.get("hidden"))}
        stamped.append([r["path"], r.get("from"), r["xy"], snap[0]])
        if r["kind"] == "untracked" and r["path"].endswith("/") and os.path.exists(os.path.join(path, r["path"], ".git")):
            block.append({"kind": "embedded", "message": "%s is a separate Git repository inside the worktree. Its commits and history can't be kept here: move it out first." % r["path"]})
        if size is not None and size > MAX_KEEP_FILE:
            block.append({"kind": "too-big", "message": "%s is %d MiB, too big to keep in the repository. Move or delete it yourself first." % (r["path"], size // (1024 * 1024))})
        facts["files"].append(row)
    if len(facts["files"]) > MAX_LISTED:
        facts["files"], facts["filesCut"] = facts["files"][:MAX_LISTED], True
    facts["fileCount"] = len(rows)
    facts["hidden"] = [r["path"] for r in rows if r.get("hidden")]
    code, out, _ = git(["status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=normal"], path)
    ignored = sorted(text(f)[2:] for f in out.split(b"\0") if text(f).startswith("! ") and text(f)[2:].rstrip("/") not in links) if code == 0 else []
    facts["ignored"] = ignored[:200]
    # An ignored file that appears, or changes, after the preview makes it stale: it would go with the folder unseen.
    ignored_stamp, walked = [], 0
    for rel in ignored:
        top_entry = os.path.join(path, rel.rstrip("/"))
        try:
            st = os.lstat(top_entry)
        except OSError:
            ignored_stamp.append([rel, None])
            continue
        ignored_stamp.append([rel, st.st_mode, st.st_size, st.st_mtime_ns])
        if not stat.S_ISDIR(st.st_mode):
            continue
        # Every file and folder inside, links not followed: an edit deep in an ignored folder after the preview counts.
        for root, dirs, files in os.walk(top_entry, followlinks=False):
            for name in dirs + files:
                walked += 1
                if walked > MAX_IGNORED_WALK:
                    break
                try:
                    sub = os.lstat(os.path.join(root, name))
                    ignored_stamp.append([os.path.relpath(os.path.join(root, name), path), sub.st_mode, sub.st_size, sub.st_mtime_ns])
                except OSError:
                    pass
            if walked > MAX_IGNORED_WALK:
                break
    facts["ignoredUnchecked"] = walked > MAX_IGNORED_WALK
    if os.path.exists(text(git_ok(["rev-parse", "--path-format=absolute", "--git-path", "index.lock"], path)).strip()):
        block.append({"kind": "locked", "message": "Another Git process is changing its index (index.lock exists). Wait for it, then check again."})
    unpublished, facts["lost"] = commits_only_here(path, tree["detached"])
    facts["unpublishedCount"] = unpublished
    if unpublished:
        log = git_line(["log", "--format=%H%x00%s", "-n", "50", "HEAD", "--not", "--remotes"], path)
        facts["unpublished"] = [dict(zip(("sha", "subject"), line.split("\0", 1))) for line in log.splitlines()]
    facts["submodules"] = submodules(path)
    for s in facts["submodules"]:
        if s["dirty"] or s["unpublished"]:
            block.append({"kind": "submodule", "message": "The submodule %s has %s that removing the folder would lose. Commit and push them in the submodule first." % (
                s["path"], "changes" if s["dirty"] else "commits, branches, tags or a stash no remote has")})
    wt_git = git_line(["rev-parse", "--absolute-git-dir"], path)
    facts["operation"] = in_progress(wt_git) if wt_git else None
    if facts["operation"]:
        block.append({"kind": "operation", "message": "A %s is in progress in it. Finish or abort it first: its state goes with the worktree." % facts["operation"]})
    procs = processes_in(path)
    facts["processes"] = procs or []
    if procs:
        block.append({"kind": "processes", "message": "%d process%s work%s in the folder (%s)." % (
            len(procs), "" if len(procs) == 1 else "es", "s" if len(procs) == 1 else "", ", ".join("%s %d" % (p["name"], p["pid"]) for p in procs[:5]))})
    facts["keep"] = bool(rows) or facts["lost"] > 0
    facts["stamp"] = hashlib.sha256(json.dumps([
        tree["head"], tree["branch"], sorted(stamped, key=lambda s: s[0]), state, sorted(links), index_stamp(path), ignored_stamp,
    ]).encode()).hexdigest()
    return facts, tree


def op_worktree_remove_plan(req):
    rec_id = record_id(req)
    top, _ = checkout(req.get("repo"))
    need_worktree_git(top)
    rec = Records(top).read()["worktrees"].get(rec_id)
    if not rec:
        raise Refusal("not-found", "This app has no record of that worktree.")
    facts, _ = removal_facts(top, rec)
    facts["worktree"] = rec_view(rec)
    return facts


def keep_changes(top, rec, facts):
    """Keeps what only the worktree holds, as `git stash` would but without touching it: a commit of its index (what
    was staged, an ignored file added with -f included) on top of HEAD, then a commit of every changed and untracked
    file on top of that, made with a copy of the index (GIT_INDEX_FILE). Git then confirms the copy holds everything:
    nothing differs from it and nothing is left untracked but setup's own links. The ref under refs/hermes-chat/kept/
    names the second commit; its parent is the staged state."""
    path = rec["path"]
    head = git_line(["rev-parse", "-q", "--verify", "HEAD^{commit}"], path)
    if not facts["fileCount"]:
        # Only commits no branch has (a detached HEAD): keeping HEAD itself keeps them.
        return keep_ref(top, rec, head, None, 0)
    links = set(setup_links(rec))
    real_index = text(git_ok(["rev-parse", "--path-format=absolute", "--git-path", "index"], path)).strip()
    index = os.path.join(common_dir(top), RECORD_DIR, "keep-%d.index" % os.getpid())
    env = {"GIT_INDEX_FILE": index}
    who = {"GIT_AUTHOR_NAME": "Hermes Chat", "GIT_AUTHOR_EMAIL": "hermes-chat@localhost", "GIT_COMMITTER_NAME": "Hermes Chat", "GIT_COMMITTER_EMAIL": "hermes-chat@localhost"}
    parents = ["-p", head] if head else []

    def commit(tree, parent_args, message):
        return text(git_ok(["commit-tree", tree] + parent_args, path, read_only=False, stdin=message.encode(), extra_env=who)).strip()

    try:
        if os.path.exists(real_index):
            shutil.copyfile(real_index, index)
        else:
            git_ok(["read-tree", head] if head else ["read-tree", "--empty"], path, read_only=False, extra_env=env)
        # The staged state, as its own commit. An index with conflicts has no tree; the working files are kept then.
        code, out, _ = git(["write-tree"], path, extra_env=env, read_only=False)
        staged_note = ""
        if code == 0:
            staged_tree = text(out).strip()
            head_tree = git_line(["rev-parse", "-q", "--verify", "HEAD^{tree}"], path) if head else ""
            if staged_tree != head_tree:
                parents = ["-p", commit(staged_tree, parents, "Staged in %s when Hermes Chat removed it\n" % path)]
        else:
            staged_note = "The index had conflicts, so only the working files are kept.\n"
        # Changes an assume-unchanged or skip-worktree flag hides: the flag is cleared in the copy only, so they're kept too.
        for rel in facts.get("hidden") or []:
            git_ok(["update-index", "--no-assume-unchanged", "--no-skip-worktree", "--", rel], path, read_only=False, extra_env=env)
            git_ok(["add", "--", rel], path, read_only=False, extra_env=env)
        git_ok(["add", "-A"], path, read_only=False, extra_env=env, timeout=600)
        for link in sorted(links):
            git_ok(["rm", "-q", "--cached", "--ignore-unmatch", "--", link], path, read_only=False, extra_env=env)
        git(["update-index", "-q", "--refresh"], path, read_only=False, extra_env=env, timeout=600)
        if git(["diff-files", "--quiet", "--ignore-submodules=none"], path, extra_env=env, timeout=600)[0] != 0:
            raise Refusal("stale", "Files changed while they were being kept. Nothing was removed. Check the new preview.")
        left = {text(p).rstrip("/") for p in git_ok(["ls-files", "-z", "--others", "--exclude-standard"], path, extra_env=env).split(b"\0") if p}
        if left - links:
            raise Refusal("stale", "Files appeared while they were being kept. Nothing was removed. Check the new preview.")
        tree = text(git_ok(["write-tree"], path, read_only=False, extra_env=env)).strip()
    finally:
        try:
            os.unlink(index)
        except OSError:
            pass
    message = "Kept by Hermes Chat before removing the worktree %s\n\nBranch: %s\nHEAD: %s\nFiles: %d\n%s" % (
        path, facts["branch"] or "(detached)", head or "(none)", facts["fileCount"], staged_note)
    return keep_ref(top, rec, commit(tree, parents, message), tree, facts["fileCount"])


def keep_ref(top, rec, commit, tree, files):
    """Points a new ref under refs/hermes-chat/kept/ at `commit` (create only, never moving one), and reads it back."""
    ref = "%s%s-%s" % (KEPT_PREFIX, rec["id"], time.strftime("%Y%m%d%H%M%S", time.gmtime()))
    git_ok(["update-ref", "--stdin"], top, read_only=False, stdin=("create %s %s\n" % (ref, commit)).encode())
    if git_line(["rev-parse", "-q", "--verify", ref + "^{commit}"], top) != commit or (tree and git_line(["rev-parse", "-q", "--verify", ref + "^{tree}"], top) != tree):
        raise Refusal("internal", "The kept commit couldn't be read back. Nothing was removed.")
    return {"ref": ref, "commit": commit, "files": files}


def restore(rec, before):
    """Puts back the state a record had before a removal that didn't happen: a failed setup stays failed, with Retry."""
    rec["state"] = before.get("state")
    if "run" in before:
        rec["run"] = before["run"]
    else:
        rec.pop("run", None)


def op_worktree_remove(req):
    """Removes a worktree this app made, after the owner saw the preview. Under the record's lock (so no chat can be
    attached meanwhile) it checks the preview still holds, keeps every change first, then asks Git to remove the
    folder. The branch is never deleted."""
    rec_id = record_id(req)
    top, _ = checkout(req.get("repo"))
    need_worktree_git(top)
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not rec:
            raise Refusal("not-found", "This app has no record of that worktree.")
        facts, tree = removal_facts(top, rec)
        if facts["blockers"]:
            raise Refusal("blocked", "It can't be removed: %s Nothing was removed." % " ".join(b["message"] for b in facts["blockers"]))
        if facts["stamp"] != req.get("expect"):
            raise Refusal("stale", "Its files, commits or chats changed since the preview. Nothing was removed. Check the new preview.")
        before = dict(rec)
        rec["state"], rec["run"] = "removing", me()
        R.save()
        try:
            kept = keep_changes(top, rec, facts) if facts["keep"] else None
            if kept:
                R.doc["kept"].append(dict(kept, id=rec_id, path=rec["path"], branch=facts["branch"], head=facts["head"], at=time.time()))
                R.save()
                progress("remove", "Kept %d changed file%s in %s" % (kept["files"], "" if kept["files"] == 1 else "s", kept["ref"]))
            again, _ = removal_facts(top, before)
            if again["blockers"] or again["stamp"] != facts["stamp"]:
                raise Refusal("stale", "Files changed while they were being kept. Nothing was removed. Check the new preview.")
            if tree.get("locked") is not None:
                git_ok(["worktree", "unlock", rec["path"]], top, read_only=False)
            force = ["--force"] if (facts["keep"] or facts["submodules"]) else []

            def relock():
                # Locked again, so `git worktree remove` and `prune` run elsewhere leave it alone. If Git removed it
                # after all, there's nothing to lock, and that's fine.
                git(["worktree", "lock", "--reason", LOCK_REASON + rec_id, rec["path"]], top, read_only=False)

            try:
                code, out, err = git(["worktree", "remove"] + force + [rec["path"]], top, read_only=False, timeout=600)
            except BaseException:
                # Timed out, or the connection dropped.
                relock()
                raise
            if code != 0:
                relock()
                raise Refusal("git", "Git didn't remove the worktree.%s" % (" Its changes are kept in %s." % kept["ref"] if kept else ""), text(err) + text(out))
        except BaseException:
            restore(rec, before)
            R.save()
            raise
        if os.path.lexists(rec["path"]) or tree_at(list_trees(top), rec["path"]):
            restore(rec, before)
            R.save()
            raise Refusal("git", "Git answered, but the worktree is still there.")
        del R.doc["worktrees"][rec_id]
        R.save()
        return {"removed": rec["path"], "branch": facts["branch"], "unpublished": facts["unpublishedCount"], "kept": kept}


def op_worktree_forget(req):
    """Drops the record of a worktree whose folder isn't there (a creation cut off before Git made it, or one removed
    by hand). Nothing on disk changes; it's refused while the folder or Git's entry is still there, or a chat is attached."""
    rec_id = record_id(req)
    top, _ = checkout(req.get("repo"))
    with Records(top) as R:
        rec = R.doc["worktrees"].get(rec_id)
        if not rec:
            return {"forgotten": rec_id}
        if rec.get("state") in INTERRUPTED and alive(rec.get("run")):
            raise Refusal("busy", "Hermes Chat is still working on it.")
        if tree_at(list_trees(top), rec["path"]) or os.path.lexists(rec["path"]):
            raise Refusal("exists", "The worktree is still there; remove it instead.")
        if rec.get("chats"):
            raise Refusal("blocked", "Chats are still attached to it. Detach them first.")
        del R.doc["worktrees"][rec_id]
        R.save()
        return {"forgotten": rec_id}


OPS.update({
    "worktreeList": op_worktree_list,
    "worktreePlan": op_worktree_plan,
    "worktreeCreate": op_worktree_create,
    "worktreeSetup": op_worktree_setup,
    "worktreeAttach": op_worktree_attach,
    "worktreeAttachConfirm": op_worktree_attach_confirm,
    "worktreeDetach": op_worktree_detach,
    "worktreeProtect": op_worktree_protect,
    "worktreeRemovePlan": op_worktree_remove_plan,
    "worktreeRemove": op_worktree_remove,
    "worktreeForget": op_worktree_forget,
})

main()
