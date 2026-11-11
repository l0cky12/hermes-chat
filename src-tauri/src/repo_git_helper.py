# The Repository screen's helper on the Hermes server (ADR 0110). Rust sends this file, unchanged, as a constant
# `python3 -I -c` program over the owner's own ssh (repo_git.rs). Nothing the owner or the webview supplies is ever
# put in a command line for a shell: the request arrives on stdin as one JSON object, and this program runs `git`
# with an argument list it builds itself, never through a shell. The answer is one JSON object on stdout.
#
# Read-only operations run with GIT_OPTIONAL_LOCKS=0, so a status doesn't rewrite the index under an agent that is
# working in the same checkout.
#
# Kept to the Python 3.8 standard library.

import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

VERSION = 1
# The most diff text one answer carries. A bigger diff is cut, and says so.
MAX_DIFF = 2 * 1024 * 1024
# The most status entries one answer carries.
MAX_ENTRIES = 5000
# How many untracked files are opened to see whether they're binary, and how much of each is read (as git does).
BINARY_SNIFF_FILES = 500
BINARY_SNIFF_BYTES = 8000
# The most lines of context a diff can ask for. "Whole file" asks for this many.
MAX_CONTEXT = 1000000
# The most of what Git and hooks print that one answer carries. The end is kept: that's where a failure says why.
MAX_OUTPUT = 256 * 1024
# How long a child gets to end on SIGTERM (Git lets go of its lock files then) before it gets SIGKILL.
STOP_GRACE = 5


class Refusal(Exception):
    """A failure the screen shows as it is: `kind` says which, `message` says why in plain words."""

    def __init__(self, kind, message, output=""):
        Exception.__init__(self, message)
        self.kind = kind
        self.message = message
        self.output = output


def environment(read_only):
    env = dict(os.environ)
    # Never wait for an answer nobody can type: there is no terminal on this side of ssh.
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GH_PROMPT_DISABLED"] = "1"
    env["GIT_PAGER"] = "cat"
    env["PAGER"] = "cat"
    # Git's own messages in English, so failures can be told apart.
    env["LC_ALL"] = "C.UTF-8"
    env.pop("LANGUAGE", None)
    if read_only:
        env["GIT_OPTIONAL_LOCKS"] = "0"
    return env


def run(argv, cwd, read_only=True, stdin=None, timeout=60, merge_output=False, extra_env=None):
    """(exit status, stdout bytes, stderr bytes) of `argv`, which is always git or gh, never a shell."""
    if argv[0] not in ("git", "gh"):
        raise Refusal("internal", "Only git and gh are run.")
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            # Its own process group, hooks and all, so stopping it stops everything it started (end_child).
            start_new_session=True,
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT if merge_output else subprocess.PIPE,
            env=dict(environment(read_only), **(extra_env or {})),
        )
    except FileNotFoundError:
        raise Refusal("unsupported", "%s isn't installed on the server, or isn't on the PATH ssh gives it." % argv[0])
    try:
        out, err = proc.communicate(stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        end_child(proc)
        raise Refusal("timeout", "%s %s took longer than %d s, so it was stopped." % (argv[0], argv[1] if len(argv) > 1 else "", timeout))
    except BaseException:
        # A stop signal (the connection dropped) or a bug: the child doesn't outlive the helper.
        end_child(proc)
        raise
    return proc.returncode, out, err or b""


def end_child(proc):
    """Stops a child that's still running, and everything it started (its process group: Git's hooks too). SIGTERM
    first, so Git removes its lock files on the way out; then, once Git has ended or after STOP_GRACE, SIGKILL for
    whatever is left, such as a hook that ignores SIGTERM. (subprocess.run would SIGKILL Git alone, at once, which
    leaves a lock such as index.lock or a ref's behind, and the hook running.)"""
    def signal_group(sig):
        try:
            os.killpg(proc.pid, sig)
        except OSError:
            pass

    signal_group(signal.SIGTERM)
    try:
        proc.wait(timeout=STOP_GRACE)
    except subprocess.TimeoutExpired:
        pass
    signal_group(signal.SIGKILL)
    proc.wait()


# Settings the owner's config could change that would make a diff read, or a patch apply, differently from what the
# screen shows. The owner's hooks, identity and credentials are left alone.
PINNED = [
    "core.quotepath=false",
    "color.ui=never",
    "diff.noprefix=false",
    "diff.mnemonicPrefix=false",
    "diff.srcPrefix=a/",
    "diff.dstPrefix=b/",
    "diff.relative=false",
    "diff.external=",
    "apply.whitespace=nowarn",
]


def git(args, cwd, **kw):
    # Every path given to git is literal: `*.ts` names a file called `*.ts`, not every TypeScript file.
    pinned = [a for kv in PINNED for a in ("-c", kv)]
    return run(["git", "--literal-pathspecs"] + pinned + args, cwd, **kw)


def text(raw):
    return raw.decode("utf-8", "replace")


def utf8(raw):
    """Whether `raw` is UTF-8 as it is. A path that isn't is shown with U+FFFD in its place, and that text names no
    file on the server, so nothing can be asked of it by name."""
    try:
        raw.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def tail(output):
    """At most MAX_OUTPUT of what Git and hooks printed, keeping the end."""
    if len(output) <= MAX_OUTPUT:
        return output
    return "[The first %d characters were cut.]\n%s" % (len(output) - MAX_OUTPUT, output[-MAX_OUTPUT:])


def git_ok(args, cwd, **kw):
    code, out, err = git(args, cwd, **kw)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git %s failed." % args[0], text(err))
    return out


# ── where ───────────────────────────────────────────────────────────────────


def checkout(repo):
    """The top of the working tree that holds `repo`, and its git directory."""
    if not isinstance(repo, str) or not repo.strip() or "\0" in repo:
        raise Refusal("bad-path", "Enter the repository's folder on the server, such as ~/projects/app.")
    path = os.path.expanduser(repo.strip())
    if not os.path.isabs(path):
        raise Refusal("bad-path", "Enter a full path on the server, starting with / or ~.")
    if not os.path.isdir(path):
        raise Refusal("not-found", "There's no folder %s on the server." % path)
    code, out, err = git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], path)
    if code != 0:
        message = text(err).strip()
        if "not a git repository" in message:
            raise Refusal("not-repo", "%s isn't in a Git repository." % path, message)
        raise Refusal("git", message or "git rev-parse failed.", message)
    lines = text(out).splitlines()
    if len(lines) < 2 or not lines[0]:
        raise Refusal("not-repo", "%s is inside a Git directory, not a working tree." % path)
    return lines[0], lines[1]


def in_progress(git_dir):
    """The operation that's waiting to be finished in this checkout, if any."""
    def has(name):
        return os.path.exists(os.path.join(git_dir, name))

    if has("rebase-merge") or has("rebase-apply"):
        return "rebase"
    if has("MERGE_HEAD"):
        return "merge"
    if has("CHERRY_PICK_HEAD"):
        return "cherry-pick"
    if has("REVERT_HEAD"):
        return "revert"
    if has("BISECT_LOG"):
        return "bisect"
    return None


def safe_rel(path, top):
    """A path relative to the top of the working tree, as status reported it. It must name something inside the
    checkout: no absolute path, no `..`, and no folder on the way that is a link out of it. The file itself may be a
    link; Git shows a link as its target's name, never what it points at."""
    if not isinstance(path, str) or not path or "\0" in path or path.startswith("/"):
        raise Refusal("bad-path", "That isn't a path inside the repository.")
    if any(part in ("", ".", "..") for part in path.split("/")):
        raise Refusal("bad-path", "That isn't a path inside the repository.")
    root = os.path.realpath(top)
    parent = os.path.realpath(os.path.join(top, os.path.dirname(path)))
    if parent != root and not parent.startswith(root + os.sep):
        raise Refusal("bad-path", "%s is outside the repository, through a link." % path)
    return path


# ── status ──────────────────────────────────────────────────────────────────


def numstat(top, cached):
    """{path: [added, removed] or None for binary} for staged (`cached`) or unstaged changes."""
    args = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"]
    args += ["--cached", "-M"] if cached else ["--no-renames"]
    code, out, _ = git(args, top)
    counts = {}
    if code != 0:
        return counts
    fields = text(out).split("\0")
    i = 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if not rec:
            continue
        parts = rec.split("\t", 2)
        if len(parts) < 3:
            continue
        added, removed, path = parts
        if path == "":
            # A rename: the old path, then the new one, follow as their own fields.
            path = fields[i + 1] if i + 1 < len(fields) else ""
            i += 2
        counts[path] = None if added == "-" else [int(added or 0), int(removed or 0)]
    return counts


def sniff_binary(top, rel):
    try:
        full = os.path.join(top, rel)
        if os.path.islink(full) or not os.path.isfile(full):
            return False
        with open(full, "rb") as f:
            return b"\0" in f.read(BINARY_SNIFF_BYTES)
    except OSError:
        return False


def op_status(req):
    """The checkout's state. HEAD and the index are stamped before and after reading, and read again (at most three
    times) if anything moved in between, so the stamps a later write checks belong to exactly the list shown."""
    top, git_dir = checkout(req.get("repo"))
    for _ in range(3):
        before = (head_oid(top), index_stamp(top))
        reply = status_once(top, git_dir)
        after = (head_oid(top), index_stamp(top))
        if before == after:
            break
    else:
        raise Refusal("busy", "The repository kept changing while it was read (another tool is working in it). Refresh in a moment.")
    reply["head"], reply["index"] = after
    # The files are stamped once, after the list settled: a retry above doesn't read them again.
    budget = [STATUS_HASH_BUDGET]
    for e in reply["entries"]:
        if (e["kind"] == "untracked" or (e["y"] not in (".", "?"))) and not e.get("nameLossy"):
            e["worktree"] = list_stamp(top, e["path"], budget)
    return reply


def status_once(top, git_dir):
    # --ignore-submodules=none: the owner's ignore settings can't hide a changed or staged submodule from the list.
    code, out, err = git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=none"], top)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git status failed.", text(err))
    branch = {"oid": None, "head": None, "detached": False, "upstream": None, "ahead": None, "behind": None}
    entries = []
    truncated = False
    raws = out.split(b"\0")
    records = [text(r) for r in raws]
    i = 0
    while i < len(records):
        rec = records[i]
        whole = utf8(raws[i])
        i += 1
        if not rec:
            continue
        if rec.startswith("# branch.oid "):
            oid = rec[len("# branch.oid "):]
            branch["oid"] = None if oid == "(initial)" else oid
        elif rec.startswith("# branch.head "):
            head = rec[len("# branch.head "):]
            branch["detached"] = head == "(detached)"
            branch["head"] = None if branch["detached"] else head
        elif rec.startswith("# branch.upstream "):
            branch["upstream"] = rec[len("# branch.upstream "):]
        elif rec.startswith("# branch.ab "):
            ab = rec.split(" ")
            branch["ahead"] = int(ab[2].lstrip("+"))
            branch["behind"] = int(ab[3].lstrip("-"))
        elif rec.startswith("#"):
            continue
        else:
            entry = None
            tag = rec[0]
            if tag == "1":
                f = rec.split(" ", 8)
                entry = {"kind": "ordinary", "x": f[1][0], "y": f[1][1], "sub": f[2] != "N...",
                         "modes": [f[3], f[4], f[5]], "path": f[8]}
            elif tag == "2":
                f = rec.split(" ", 9)
                orig = records[i] if i < len(records) else ""
                whole = whole and (i >= len(raws) or utf8(raws[i]))
                i += 1
                entry = {"kind": "renamed" if f[8].startswith("R") else "copied", "x": f[1][0], "y": f[1][1],
                         "sub": f[2] != "N...", "modes": [f[3], f[4], f[5]], "score": f[8], "path": f[9],
                         "origPath": orig}
            elif tag == "u":
                f = rec.split(" ", 10)
                entry = {"kind": "unmerged", "x": f[1][0], "y": f[1][1], "sub": f[2] != "N...",
                         "modes": [f[3], f[4], f[5], f[6]], "path": f[10]}
            elif tag == "?":
                entry = {"kind": "untracked", "x": "?", "y": "?", "sub": False, "path": rec[2:]}
            if entry is None:
                continue
            if not whole:
                # Its name isn't UTF-8: a request naming it would name another path. Listed, never acted on.
                entry["nameLossy"] = True
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                continue
            entries.append(entry)

    staged = numstat(top, True)
    unstaged = numstat(top, False)
    sniffed = 0
    for e in entries:
        if e["kind"] == "untracked":
            if sniffed < BINARY_SNIFF_FILES:
                sniffed += 1
                e["binary"] = sniff_binary(top, e["path"])
            continue
        if e["x"] not in (".", "?") and e["kind"] != "unmerged":
            c = staged.get(e["path"], False)
            if c is not False:
                e["staged"] = c
        if e["y"] not in (".", "?") and e["kind"] != "unmerged":
            c = unstaged.get(e["path"], False)
            if c is not False:
                e["unstaged"] = c
    return {
        "top": top,
        "gitDir": git_dir,
        "branch": branch,
        "operation": in_progress(git_dir),
        "entries": entries,
        "truncated": truncated,
    }


# ── diff ────────────────────────────────────────────────────────────────────


def capped(raw):
    cut = len(raw) > MAX_DIFF
    body = raw[:MAX_DIFF] if cut else raw
    # Lossy: some bytes aren't UTF-8, so the text shown isn't byte for byte what git printed. A cut that only split
    # the last character doesn't count.
    lossy = False
    try:
        body.decode("utf-8")
    except UnicodeDecodeError as e:
        lossy = not (cut and e.start >= len(body) - 3)
    return body.decode("utf-8", "replace"), cut, lossy


def op_diff(req):
    top, _ = checkout(req.get("repo"))
    path = safe_rel(req.get("path"), top)
    orig = req.get("origPath")
    side = req.get("side")
    context = req.get("context", 3)
    if not isinstance(context, int) or context < 0:
        context = 3
    context = min(context, MAX_CONTEXT)
    # --ignore-submodules=none, as for status: a submodule the list shows always has its old and new commits here.
    common = ["--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-U%d" % context]
    if side == "staged":
        paths = [path] + ([safe_rel(orig, top)] if orig else [])
        renames = ["-M"] if orig else ["--no-renames"]
        code, out, err = git(["diff", "--cached"] + renames + common + ["--"] + paths, top)
    elif side == "unstaged":
        code, out, err = git(["diff", "--no-renames"] + common + ["--", path], top)
    elif side == "conflict":
        code, out, err = git(["diff"] + common + ["--", path], top)
    elif side == "untracked":
        if not os.path.lexists(os.path.join(top, path)):
            raise Refusal("stale", "%s isn't there any more. Refresh to see the repository as it is now." % path)
        code, out, err = git(["diff", "--no-index"] + common + ["--", os.devnull, path], top)
        # --no-index exits 1 when the files differ, which they always do here.
        if code == 1:
            code = 0
    else:
        raise Refusal("internal", "Unknown diff side.")
    if code != 0:
        raise Refusal("git", text(err).strip() or "git diff failed.", text(err))
    diff, cut, lossy = capped(out)
    # The file's bytes as this diff shows them, when the diff is of the working tree: the screen compares it with
    # the list's, and won't stage from a list older than the diff on screen.
    worktree = worktree_stamp(top, path) if side in ("unstaged", "untracked") else None
    worktree_meta = meta_of(top, path) if side in ("unstaged", "untracked") else None
    stages = []
    if side == "conflict":
        lines = text(git_ok(["ls-files", "-u", "-z", "--", path], top)).split("\0")
        stages = sorted({int(l.split(" ")[2].split("\t")[0]) for l in lines if l})
    return {
        "diff": diff,
        "truncated": cut,
        "lossy": lossy,
        "bytes": len(out),
        "sha": hashlib.sha256(out).hexdigest(),
        "stages": stages,
        "worktree": worktree,
        # The same file by its metadata: what a list that ran out of its hashing budget stamped it with.
        "worktreeMeta": worktree_meta,
        "head": head_oid(top),
        "index": index_stamp(top),
    }


# ── stamps: what a write checks first ───────────────────────────────────────


def head_oid(top):
    code, out, _ = git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], top)
    return text(out).strip() if code == 0 else None


def head_ref(top):
    """The ref HEAD points at (refs/heads/<branch>, before the first commit too), or "HEAD" when detached. Two branches
    can be at the same commit: a commit checks this as well as HEAD's commit, so it lands on the branch previewed."""
    code, out, _ = git(["symbolic-ref", "-q", "HEAD"], top)
    return text(out).strip() if code == 0 and text(out).strip() else "HEAD"


def index_stamp(top):
    """SHA-256 of every index entry (mode, blob, stage, path): any staging, unstaging or conflict change alters it."""
    return hashlib.sha256(git_ok(["ls-files", "--stage", "-z"], top)).hexdigest()


# Files bigger than this are stamped by their metadata, never hashed.
STAMP_HASH_MAX = 32 * 1024 * 1024
# The most bytes one Status reads to hash files. Past it, the rest are stamped by their metadata, so a checkout with
# many big changed files still answers well within its time limit. A test makes it small.
STATUS_HASH_BUDGET = int(os.environ.get("HERMES_REPO_TEST_HASH_BUDGET") or 256 * 1024 * 1024)


def meta_stamp(st):
    """A file stamped without reading it: executable bit, size, modification and change times, inode and device. A
    write sets the change time, which nothing can set back, but not every write: one through a shared memory mapping
    whose page is already dirty changes no time until the page is written back. So only files too big, or too many,
    to hash are stamped this way."""
    x = "x" if st.st_mode & 0o111 else "-"
    return "meta:%s:%d:%d:%d:%d:%d" % (x, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, st.st_dev)


def snapshot(top, rel, by_meta=False):
    """What a working-tree path is now, read once: (stamp, kind, payload, executable). A file's stamp is SHA-256 of
    its executable bit and bytes, so a chmod counts as a change; with `by_meta`, or over STAMP_HASH_MAX, it is its
    metadata (meta_stamp), which must be the same before and after the bytes are read, so the bytes returned are the
    ones it stamps ("changing" if not). A link's stamp is SHA-256 of its target. kind is "file", "link", "big" (over
    STAMP_HASH_MAX, payload None), "dir" (a folder or a submodule), "special" or "missing"."""
    full = os.path.join(top, rel)
    try:
        st = os.lstat(full)
    except OSError:
        return None, "missing", None, False
    if stat.S_ISLNK(st.st_mode):
        target = os.readlink(full).encode("utf-8", "surrogateescape")
        return hashlib.sha256(b"link:" + target).hexdigest(), "link", target, False
    if stat.S_ISDIR(st.st_mode):
        return "dir", "dir", None, False
    if not stat.S_ISREG(st.st_mode):
        return "special", "special", None, False
    big = st.st_size > STAMP_HASH_MAX
    try:
        with open(os.open(full, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as f:
            before = os.fstat(f.fileno())
            data = None if big else f.read()
            after = os.fstat(f.fileno())
    except OSError:
        return None, "missing", None, False
    executable = bool(before.st_mode & 0o111)
    if by_meta or big:
        same = meta_stamp(st) == meta_stamp(before) == meta_stamp(after)
        stamp = meta_stamp(before) if same else "changing"
    else:
        stamp = hashlib.sha256((b"x:" if executable else b"-:") + data).hexdigest()
    return stamp, "big" if big else "file", data, executable


def worktree_stamp(top, rel):
    """A path's stamp as staging checks it: SHA-256 of a file's bytes, or its metadata over STAMP_HASH_MAX."""
    return snapshot(top, rel)[0]


def list_stamp(top, rel, budget):
    """`worktree_stamp` for Status, which hashes at most `budget[0]` bytes in all: a file past that is stamped by its
    metadata. Staging checks a file against whichever kind of stamp the list gave it."""
    try:
        st = os.lstat(os.path.join(top, rel))
    except OSError:
        return None
    if stat.S_ISREG(st.st_mode) and st.st_size <= STAMP_HASH_MAX:
        if st.st_size > budget[0]:
            return meta_stamp(st)
        budget[0] -= st.st_size
    return worktree_stamp(top, rel)


def meta_of(top, rel):
    """A regular file's metadata stamp, for comparing a diff with a list that stamped the file that way."""
    try:
        st = os.lstat(os.path.join(top, rel))
    except OSError:
        return None
    return meta_stamp(st) if stat.S_ISREG(st.st_mode) else None


def check_stamps(top, expect):
    """Refuses, changing nothing, when HEAD or the index isn't what the screen last read."""
    if not isinstance(expect, dict):
        raise Refusal("internal", "The request didn't say which HEAD and index it was made for.")
    head, index = head_oid(top), index_stamp(top)
    moved = []
    if head != expect.get("head"):
        moved.append("HEAD moved (a commit, checkout or reset happened)")
    if index != expect.get("index"):
        moved.append("the staged changes changed")
    if moved:
        raise Refusal(
            "stale",
            "Since this screen last read the repository, %s. Nothing was changed. Refresh and check again." % " and ".join(moved),
        )
    return head, index


def stamps(top):
    return {"head": head_oid(top), "index": index_stamp(top)}


# The index locks this helper holds. main() lets go of any still here however the helper ends, even when a stop signal
# landed where __exit__ never runs (Python doesn't call it when __enter__ raises).
HELD = []


class LockedIndex:
    """The index, held from the check to the write. It takes the index's own lock (index.lock), as Git does for
    any change to the index, so no other Git process can change it in between. The write goes to a copy
    (GIT_INDEX_FILE), and the copy becomes the index only if the write worked. Hooks run on the copy as Git runs them.
    The lock is let go however the helper ends, a signal from a dropped ssh included."""

    def __init__(self, top):
        self.index = text(git_ok(["rev-parse", "--path-format=absolute", "--git-path", "index"], top)).strip()
        self.lock = self.index + ".lock"
        self.copy = "%s.hermes-%d" % (self.index, os.getpid())
        self.held = False

    def __enter__(self):
        # A stop signal waits while the lock is taken, so it can't land between taking it and recording it in HELD.
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
        try:
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o666)
            except FileExistsError:
                raise Refusal("locked", "Another Git process is changing the index (index.lock exists). Nothing was changed. Wait for it, then try again.")
            os.close(fd)
            self.held = True
            HELD.append(self)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        # Python doesn't call __exit__ when __enter__ raises: a failed copy (a full disk) lets the lock go here, or
        # every later `git add` in this checkout would fail until it was deleted by hand.
        try:
            if os.path.exists(self.index):
                shutil.copyfile(self.index, self.copy)
        except BaseException:
            self.__exit__()
            raise
        return self

    @property
    def env(self):
        return {"GIT_INDEX_FILE": self.copy}

    def install(self):
        """The copy, as written, becomes the index: written into the lock, then renamed over the index, as Git does."""
        if os.path.exists(self.copy):
            os.replace(self.copy, self.lock)
            os.replace(self.lock, self.index)
        self.held = False

    def __exit__(self, *exc):
        for path in (self.copy,) + ((self.lock,) if self.held else ()):
            try:
                os.unlink(path)
            except OSError:
                pass
        self.held = False
        if self in HELD:
            HELD.remove(self)
        return False


def file_mode(top, rel, kind, executable, env):
    """The mode Git would stage: a link, or the executable bit the snapshot saw (never read again later) unless
    core.fileMode is off, when the index's own mode for it stays."""
    if kind == "link":
        return "120000"
    code, out, _ = git(["config", "--bool", "--get", "core.fileMode"], top)
    if code == 0 and text(out).strip() == "false":
        code, out, _ = git(["ls-files", "--stage", "-z", "--", rel], top, extra_env=env)
        existing = text(out).split(" ", 1)[0] if code == 0 and text(out) else ""
        return existing if existing in ("100644", "100755") else "100644"
    return "100755" if executable else "100644"


# ── staging ─────────────────────────────────────────────────────────────────


def op_stage(req):
    """Stages exactly the files named, each exactly as the screen read it: the bytes that matched its stamp are what
    go into the index (git hash-object, then update-index), not whatever the file holds a moment later. Never more."""
    top, _ = checkout(req.get("repo"))
    files = req.get("files") or []
    if not files:
        raise Refusal("internal", "No files were named.")
    with LockedIndex(top) as idx:
        check_stamps(top, req.get("expect"))
        for f in files:
            rel = safe_rel(f.get("path") if isinstance(f, dict) else None, top)
            want = f.get("worktree")
            by_meta = isinstance(want, str) and want.startswith("meta:")
            stamp, kind, data, executable = snapshot(top, rel, by_meta)
            if kind in ("dir", "special"):
                raise Refusal("bad-path", "%s is a folder, a submodule or a special file. Only files are staged here; use the Terminal for it." % rel)
            if stamp != want:
                raise Refusal("stale", "%s changed on the server since this screen read it. Nothing was staged. Refresh and look at it again." % rel)
            if kind == "missing":
                # Staged as deleted only if the index has it: a path that's in neither (a name read wrongly) is
                # refused rather than answered as staged.
                if not git_ok(["ls-files", "-z", "--", rel], top, extra_env=idx.env):
                    raise Refusal("stale", "There's no file %s on the server or in the index. Nothing was staged. Refresh and look again." % rel)
                git_ok(["update-index", "--remove", "--", rel], top, read_only=False, extra_env=idx.env)
                continue
            full = os.path.join(top, rel)
            if kind == "big":
                with open(full, "rb") as fh:
                    blob = text(run(["git", "hash-object", "-w", "--path", rel, "--stdin"], top, read_only=False, stdin=fh.read())[1]).strip()
                if snapshot(top, rel, True)[0] != stamp:
                    raise Refusal("stale", "%s changed while it was being staged. Nothing was staged." % rel)
            else:
                # A link is stored as its target's name; a file through its clean filters, as git add would.
                args = ["hash-object", "-w", "--stdin"] + ([] if kind == "link" else ["--path", rel])
                blob = text(git_ok(args, top, read_only=False, stdin=data)).strip()
            mode = file_mode(top, rel, kind, executable, idx.env)
            git_ok(["update-index", "--add", "--cacheinfo", "%s,%s,%s" % (mode, blob, rel)], top, read_only=False, extra_env=idx.env)
        idx.install()
    return stamps(top)


def op_unstage(req):
    """Takes the files named out of the index, back to HEAD's version. The working tree is left alone."""
    top, _ = checkout(req.get("repo"))
    paths = [safe_rel(p, top) for p in (req.get("paths") or [])]
    if not paths:
        raise Refusal("internal", "No files were named.")
    with LockedIndex(top) as idx:
        head, _ = check_stamps(top, req.get("expect"))
        if head is None:
            # Before the first commit there's no HEAD to go back to: unstaging takes the file out of the index. Only
            # the index entry goes; the working tree isn't touched. `git rm --cached` would refuse a file staged and
            # then edited again (its index differs from both the file and HEAD) without -f; update-index has no such
            # check and takes each path literally.
            git_ok(["update-index", "--force-remove", "--"] + paths, top, read_only=False, extra_env=idx.env)
        else:
            git_ok(["restore", "--staged", "--"] + paths, top, read_only=False, extra_env=idx.env)
        idx.install()
    return stamps(top)


def cut_hunks(diff, picked):
    """A patch of only the hunks at `picked` (by position), cut from the diff just read and checked: its header
    lines, then each hunk's lines as Git printed them. The screen names hunks; it never sends patch text."""
    if not isinstance(picked, list) or not picked or not all(isinstance(i, int) for i in picked):
        raise Refusal("internal", "No hunks were named.")
    head, hunks = [], []
    for line in diff.split(b"\n")[:-1] if diff.endswith(b"\n") else diff.split(b"\n"):
        if line.startswith(b"@@"):
            hunks.append([line])
        elif hunks:
            hunks[-1].append(line)
        else:
            head.append(line)
    if not hunks or any(i < 0 or i >= len(hunks) for i in picked):
        raise Refusal("stale", "That hunk isn't in the diff any more. Look at it again.")
    return b"\n".join(head + [l for i in sorted(set(picked)) for l in hunks[i]]) + b"\n"


def op_apply(req):
    """Stages (or, with `reverse`, unstages) hunks of a diff the screen showed. The diff is read again, with the index
    held, and must be byte for byte the one shown; the hunks are cut from it here, and `git apply --cached` changes
    only the index (a copy, installed if it worked). A stage of hunks reads the working tree once, in that diff."""
    top, _ = checkout(req.get("repo"))
    path = safe_rel(req.get("path"), top)
    reverse = req.get("reverse") is True
    context = req.get("context")
    if not isinstance(context, int) or context < 0:
        raise Refusal("internal", "The request didn't say which diff the hunks came from.")
    with LockedIndex(top) as idx:
        check_stamps(top, req.get("expect"))
        side = ["--cached"] if reverse else []
        code, out, err = git(["diff"] + side + ["--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "-U%d" % context, "--", path], top)
        if code != 0:
            raise Refusal("git", text(err).strip() or "git diff failed.", text(err))
        if hashlib.sha256(out).hexdigest() != req.get("diffSha"):
            raise Refusal("stale", "The diff of %s changed since it was shown. Nothing was staged. Look at it again." % path)
        patch = cut_hunks(out, req.get("hunks"))
        args = ["apply", "--cached", "--recount", "--whitespace=nowarn"] + (["--reverse"] if reverse else [])
        if context == 0:
            # A diff with no context lines: git apply refuses one unless told it's meant (git-apply(1), --unidiff-zero).
            args.append("--unidiff-zero")
        code, _, err = git(args + ["--check", "-"], top, stdin=patch, extra_env=idx.env)
        if code != 0:
            raise Refusal("stale", "Git can't apply that hunk to the index as it is now. Nothing was changed. Refresh and try again.", text(err))
        git_ok(args + ["-"], top, read_only=False, stdin=patch, extra_env=idx.env)
        idx.install()
    return stamps(top)


# ── commit ──────────────────────────────────────────────────────────────────

COMMIT_HOOKS = ("pre-commit", "prepare-commit-msg", "commit-msg", "post-commit")


def hooks(top):
    """The commit hooks Git will run here: executable files in core.hooksPath, or the repository's hooks folder."""
    code, out, _ = git(["config", "--get", "core.hooksPath"], top)
    folder = text(out).strip() if code == 0 else ""
    if folder:
        folder = os.path.expanduser(folder)
        if not os.path.isabs(folder):
            folder = os.path.join(top, folder)
    else:
        folder = text(git_ok(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], top)).strip()
    found = []
    for name in COMMIT_HOOKS:
        p = os.path.join(folder, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            found.append(name)
    return folder, found


def ident(top, role):
    code, out, err = git(["var", "GIT_%s_IDENT" % role], top)
    if code != 0:
        return None
    # "Name <email> 1700000000 +0000": the time isn't part of who.
    return text(out).strip().rsplit(" ", 2)[0]


def staged_raw(top):
    """The staged changes as `git diff --raw` lists them, with full object names: what a commit of the index adds."""
    # --ignore-submodules=none overrides diff.ignoreSubmodules and each submodule's own `ignore` (.gitmodules or
    # config), so a staged gitlink is never left out of the preview while the commit takes it.
    return git_ok(["diff", "--cached", "--ignore-submodules=none", "--raw", "--no-abbrev", "--no-renames", "-z"], top)


def name_status(raw):
    """[{status, path}] from `--raw -z` output, without renames."""
    fields = text(raw).split("\0")
    out = []
    i = 0
    while i + 1 < len(fields):
        meta, path = fields[i], fields[i + 1]
        i += 2
        if not meta.startswith(":"):
            continue
        parts = meta.split(" ")
        out.append({"status": parts[4][0], "path": path, "oldMode": parts[0][1:], "newMode": parts[1]})
    return out


def op_preview(req):
    """Exactly what a commit now would hold: the staged diff, its files, the HEAD it would follow, who would author
    it, and which hooks would run. The stamps it returns are what the commit request must match."""
    top, git_dir = checkout(req.get("repo"))
    head = head_oid(top)
    raw = staged_raw(top)
    code, out, err = git(["diff", "--cached", "--ignore-submodules=none", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--stat=200", "--patch"], top)
    if code != 0:
        raise Refusal("git", text(err).strip() or "git diff failed.", text(err))
    diff, cut, lossy = capped(out)
    code, ns, _ = git(["diff", "--cached", "--ignore-submodules=none", "-M", "--name-status", "-z"], top)
    renames = {}
    fields = text(ns).split("\0")
    i = 0
    while i < len(fields):
        st = fields[i]
        if st.startswith(("R", "C")) and i + 2 < len(fields):
            renames[fields[i + 2]] = {"from": fields[i + 1], "score": st}
            i += 3
        else:
            i += 2
    unmerged = bool(text(git_ok(["ls-files", "-u", "-z"], top)))
    folder, found = hooks(top)
    recent = text(git(["log", "-n", "10", "--format=%s"], top)[1]).splitlines() if head else []
    return {
        "head": head,
        "index": index_stamp(top),
        "branch": current_branch(top),
        "headRef": head_ref(top),
        "files": name_status(raw),
        "renames": renames,
        "rawSha": hashlib.sha256(raw).hexdigest(),
        "diff": diff,
        "truncated": cut,
        "lossy": lossy,
        "unmerged": unmerged,
        "operation": in_progress(git_dir),
        "author": ident(top, "AUTHOR"),
        "committer": ident(top, "COMMITTER"),
        "hooksPath": folder,
        "hooks": found,
        "recent": recent,
    }


def traced(args, top, stdin=None, timeout=600, env=None):
    """Runs a writing git command with Git's own trace (trace2) on, and says which hooks it ran exited non-zero, so a
    hook's refusal is known from Git, not guessed from what was printed. (exit status, output, failed hook names)"""
    fd, trace = tempfile.mkstemp(prefix="hermes-repo-trace-")
    os.close(fd)
    try:
        code, out, _ = git(args, top, read_only=False, stdin=stdin, timeout=timeout, merge_output=True, extra_env=dict(env or {}, GIT_TRACE2_EVENT=trace))
        started, failed = {}, []
        with open(trace, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                # Only the command itself, not git run inside a hook.
                if "/" in str(e.get("sid", "")):
                    continue
                if e.get("event") == "child_start" and e.get("child_class") == "hook":
                    started[e.get("child_id")] = e.get("hook_name") or "hook"
                elif e.get("event") == "child_exit" and e.get("child_id") in started and e.get("code") != 0:
                    failed.append(started[e.get("child_id")])
        return code, out, failed
    finally:
        try:
            os.unlink(trace)
        except OSError:
            pass


def classify_commit_failure(output, failed):
    if failed:
        return "hook", "The %s hook refused the commit. Its output is below. Nothing was committed." % ", ".join(failed)
    o = output.lower()
    if "please tell me who you are" in o or "unable to auto-detect email" in o or "empty ident name" in o:
        return "identity", "Git doesn't know who the author is on the server. Set user.name and user.email there (git config), then commit again."
    if "index.lock" in o:
        return "locked", "Another Git process holds the index lock (index.lock). Wait for it to finish, then commit again."
    if "unmerged files" in o or "unresolved conflict" in o:
        return "conflict", "There are unresolved conflicts. Resolve them first."
    if "nothing to commit" in o or "no changes added to commit" in o or "nothing added to commit" in o:
        return "nothing-staged", "Nothing is staged, so there's nothing to commit."
    return "git", "Git refused the commit. Its output is below. Nothing was committed."


def short_ref(ref):
    return "detached HEAD" if ref == "HEAD" else ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref


def op_commit(req):
    """Commits the index, only if HEAD and the index are exactly what the preview showed. Hooks run as Git runs them;
    nothing is bypassed. The message is committed verbatim, as previewed. Afterwards the new commit is read back and
    compared with the preview."""
    top, git_dir = checkout(req.get("repo"))
    message = req.get("message")
    if not isinstance(message, str) or not message.strip():
        raise Refusal("empty-message", "Write a commit message first.")
    if not message.endswith("\n"):
        message += "\n"
    expect = req.get("expect")
    # The index is held from these checks until the commit is done, and the commit is made from a copy of it, so
    # nothing staged after the checks can get in. Git takes the ref's lock for HEAD itself, against its old value.
    with LockedIndex(top) as idx:
        head, _ = check_stamps(top, expect)
        wanted_ref = (expect or {}).get("headRef")
        if not isinstance(wanted_ref, str):
            raise Refusal("internal", "The commit request didn't say which branch it was previewed on.")
        now_ref = head_ref(top)
        if now_ref != wanted_ref:
            raise Refusal(
                "stale",
                "The checked-out branch changed since the preview (%s, now %s). Nothing was committed. Preview again." % (short_ref(wanted_ref), short_ref(now_ref)),
            )
        raw = staged_raw(top)
        if hashlib.sha256(raw).hexdigest() != (expect or {}).get("rawSha"):
            raise Refusal("stale", "The staged changes aren't the ones previewed. Nothing was committed. Preview again.")
        if not raw:
            raise Refusal("nothing-staged", "Nothing is staged, so there's nothing to commit.")
        if text(git_ok(["ls-files", "-u", "-z"], top)):
            raise Refusal("conflict", "There are unresolved conflicts. Resolve them before committing.")
        operation = in_progress(git_dir)
        if operation in ("merge", "rebase", "cherry-pick", "revert"):
            raise Refusal("operation", "A %s is in progress, and committing now would finish part of it. Finish or abort it in the Terminal." % operation)
        try:
            code, out, failed = traced(["commit", "--cleanup=verbatim", "-F", "-"], top, stdin=message.encode("utf-8"), timeout=COMMIT_TIMEOUT, env=idx.env)
        finally:
            # However it ended, a timeout or a dropped ssh's hangup included: once the commit has landed, the index copy
            # it was made from (with anything a hook staged) becomes the index, so the index never disagrees with it.
            if head_oid(top) != head:
                idx.install()
        output = text(out)
        after = head_oid(top)
        if after == head:
            kind, why = classify_commit_failure(output, failed)
            # A refused commit leaves HEAD and the index as they were: the copy a hook may have changed is dropped.
            raise Refusal(kind, why, tail(output))
        # HEAD moved, so the commit landed, even if Git then exited with an error: it's reported as made, with Git's
        # words beside it. What a hook staged during the commit is part of it; the index it left was installed above.
    parents = text(git_ok(["rev-list", "--parents", "-n", "1", after], top)).split()[1:]
    if parents != ([head] if head else []):
        raise Refusal("lost", "A commit was made, but not on top of the HEAD that was checked. Refresh and look at the history in the Terminal.", tail(output))
    tree_args = ["diff-tree", "-r", "--ignore-submodules=none", "--raw", "--no-abbrev", "--no-renames", "--no-commit-id", "-z"] + (["--root"] if head is None else [])
    committed = git_ok(tree_args + [after], top)
    return {
        "head": after,
        "subject": message.splitlines()[0],
        "output": tail(output),
        "exitCode": code,
        "matches": committed == raw,
        "files": name_status(committed),
        "branch": current_branch(top),
    }


# ── publish: push, pull requests, status ────────────────────────────────────

GITHUB = re.compile(r"^(?:https?://(?:[^@/]+@)?github\.com/|ssh://(?:[^@/]+@)?github\.com/|[^@/:]+@github\.com:)([^/]+)/([^/]+?)(?:\.git)?/?$")


def check_remote(remote, top):
    """A remote this repository has, whose name can't be read as an option."""
    if not isinstance(remote, str) or not remote or remote.startswith("-") or remote not in git_line(["remote"], top).splitlines():
        raise Refusal("bad-remote", "There's no remote %r in this repository that can be used here." % (remote,))
    return remote


def push_urls(remote, top):
    """Every URL a push to `remote` goes to (remote.<name>.pushurl, else its url). Git pushes to all of them."""
    return [u for u in git_line(["remote", "get-url", "--push", "--all", remote], top).splitlines() if u]


def push_url(remote, top):
    """The one URL a push to `remote` goes to. A remote that pushes to several isn't pushed to from here."""
    urls = push_urls(remote, top)
    if len(urls) != 1:
        raise Refusal("unsupported", "%s pushes to %d places (%s). This screen pushes to one place only; use the Terminal." % (remote, len(urls), ", ".join(redact(u) for u in urls)))
    if urls[0].startswith("-"):
        raise Refusal("bad-remote", "%s's push URL can't be used here." % remote)
    return urls[0]


def redact_text(output):
    """Command output with any user name and password taken out of URLs in it."""
    return re.sub(r"(https?://)[^/@\s]+@", r"\1", output or "")


def redact(url):
    """A remote URL safe to show: any user name and password in an http(s) URL taken out."""
    return re.sub(r"^(https?://)[^@/]+@", r"\1", url or "")


def git_line(args, top):
    code, out, _ = git(args, top)
    return text(out).strip() if code == 0 else ""


def current_branch(top):
    """The branch checked out, or None when HEAD is detached. Read as the full ref and cut, never with `--short`,
    which prints `heads/<name>` when a tag has the branch's name."""
    ref = git_line(["symbolic-ref", "-q", "HEAD"], top)
    return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else None


def check_branch_name(name, top):
    if not isinstance(name, str) or not name or name.startswith("-") or git(["check-ref-format", "--branch", name], top)[0] != 0:
        raise Refusal("bad-branch", "%r isn't a branch name Git accepts." % (name,))
    return name


def configured_push_url(remote, top):
    """The push URL as written in the config (remote.<name>.pushurl, else .url), before any insteadOf rewriting:
    what says which GitHub repository a remote is."""
    return git_line(["config", "--get", "remote.%s.pushurl" % remote], top) or git_line(["config", "--get", "remote.%s.url" % remote], top)


def github_repo(url):
    m = GITHUB.match(url or "")
    return "%s/%s" % (m.group(1), m.group(2)) if m else None


# How long one of gh's reads may take. A test makes it short to check that a slow gh doesn't hide Push.
GH_READ_TIMEOUT = int(os.environ.get("HERMES_REPO_GH_TIMEOUT") or 60)


def gh_json(args, top, timeout=None):
    code, out, err = run(["gh"] + args, top, timeout=timeout or GH_READ_TIMEOUT)
    if code != 0:
        return None, text(err).strip() or text(out).strip()
    try:
        return json.loads(text(out)), ""
    except ValueError:
        return None, "gh answered with something that isn't JSON."


# How long reading a new pull request back may take. A test makes it short to check that a slow read-back keeps the
# pull request that was made.
READBACK_TIMEOUT = int(os.environ.get("HERMES_REPO_READBACK_TIMEOUT") or 60)

PR_FIELDS = "number,url,state,isDraft,title,baseRefName,headRefName,headRefOid,isCrossRepository"


def own_prs(prs):
    """Pull requests from this repository's own branch, not a fork's branch that happens to share its name."""
    return [p for p in (prs or []) if not p.get("isCrossRepository")]
STATUS_FIELDS = PR_FIELDS + ",mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt"


def op_publish_info(req):
    """Where a push and a pull request would go: the branch, its upstream, the remotes (URLs without credentials),
    the commits not on the remote yet, and, for a GitHub remote, the repository, its default branch and any pull
    request for the branch. Nothing here talks to the remote except gh's read-only queries."""
    top, _ = checkout(req.get("repo"))
    head = head_oid(top)
    branch = current_branch(top)
    remotes = []
    for name in git_line(["remote"], top).splitlines():
        if name.startswith("-"):
            continue  # a name that would read as an option is never offered
        urls = push_urls(name, top)
        remotes.append({"name": name, "url": redact(urls[0] if urls else ""), "pushUrls": [redact(u) for u in urls]})
    upstream = None
    if branch:
        u = git_line(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "%s@{upstream}" % branch], top)
        remote = git_line(["config", "--get", "branch.%s.remote" % branch], top)
        merge = git_line(["config", "--get", "branch.%s.merge" % branch], top)
        if remote and merge.startswith("refs/heads/"):
            upstream = {"ref": u or None, "remote": remote, "branch": merge[len("refs/heads/"):]}
    names = [r["name"] for r in remotes]
    # Where Git itself would push: the branch's pushRemote, the repository's pushDefault, the upstream's remote, then
    # origin, then the only remote.
    configured = [git_line(["config", "--get", "branch.%s.pushRemote" % branch], top) if branch else "", git_line(["config", "--get", "remote.pushDefault"], top)]
    remote = next((r for r in configured if r in names), None) or (upstream or {}).get("remote") or ("origin" if "origin" in names else (names[0] if len(names) == 1 else None))
    # The upstream's branch only when it has this branch's name on that remote, as Git's `simple` push does. A branch
    # made with `git switch -c fix origin/main` tracks main, and must never push there unasked.
    if upstream and upstream["remote"] == remote and upstream["branch"] == branch:
        remote_branch = upstream["branch"]
    else:
        remote_branch = branch
    tracking = "refs/remotes/%s/%s" % (remote, remote_branch) if remote and remote_branch else None
    has_tracking = bool(tracking) and git(["rev-parse", "-q", "--verify", tracking], top)[0] == 0
    commits = []
    ahead = behind = None
    # A remote that pushes somewhere other than it fetches from: its tracking refs say nothing about the push
    # destination, so that destination is asked what it has.
    separate = bool(remote) and push_urls(remote, top) != [u for u in git_line(["remote", "get-url", "--all", remote], top).splitlines() if u]
    asked_head, remote_error = None, None
    if separate and head and remote_branch:
        try:
            asked_head = remote_sha(top, remote, remote_branch)
        except Refusal as r:
            remote_error = r.message
    if separate:
        if head and asked_head and git(["cat-file", "-e", asked_head + "^{commit}"], top)[0] == 0:
            rng = ["%s..HEAD" % asked_head]
            ahead = int(git_line(["rev-list", "--count"] + rng, top) or 0)
            behind = int(git_line(["rev-list", "--count", "HEAD..%s" % asked_head], top) or 0)
            log = git_line(["log", "--format=%H%x1f%s", "-n", "50"] + rng, top)
            commits = [dict(zip(("sha", "subject"), l.split("\x1f", 1))) for l in log.splitlines() if "\x1f" in l]
        # Otherwise how far ahead it is can't be told from here: ahead stays None, and Push stays offered.
    elif head:
        if has_tracking:
            rng = ["%s..HEAD" % tracking]
            counts = git_line(["rev-list", "--left-right", "--count", "%s...HEAD" % tracking], top).split()
            if len(counts) == 2:
                behind, ahead = int(counts[0]), int(counts[1])
        else:
            rng = ["HEAD", "--not", "--remotes=%s" % remote] if remote else ["HEAD"]
            ahead = int(git_line(["rev-list", "--count"] + rng, top) or 0)
        log = git_line(["log", "--format=%H%x1f%s", "-n", "50"] + rng, top)
        commits = [dict(zip(("sha", "subject"), l.split("\x1f", 1))) for l in log.splitlines() if "\x1f" in l]
    remote_url = next((r["url"] for r in remotes if r["name"] == remote), "")
    remote_push_urls = next((r["pushUrls"] for r in remotes if r["name"] == remote), [])
    gh_repo = github_repo(configured_push_url(remote, top)) if remote else None
    github = None
    if gh_repo:
        # gh missing, signed out or slow says nothing against Git: Push still works with Git's credentials, so the
        # failure goes to the pull request card and the rest of this answer stands.
        def gh_read(args):
            try:
                return gh_json(args, top)
            except Refusal as r:
                return None, r.message
        repo_info, why = gh_read(["repo", "view", gh_repo, "--json", "nameWithOwner,url,defaultBranchRef"])
        prs = []
        if repo_info and remote_branch:
            found, _ = gh_read(["pr", "list", "--repo", gh_repo, "--head", remote_branch, "--state", "all", "--limit", "10", "--json", PR_FIELDS])
            prs = own_prs(found)[:5]
        github = {
            "repo": gh_repo,
            "url": (repo_info or {}).get("url"),
            "defaultBranch": ((repo_info or {}).get("defaultBranchRef") or {}).get("name"),
            "prs": prs,
            "error": None if repo_info else (why or "gh couldn't read the repository."),
        }
    # The commits a pull request into the default branch would hold, for drafting its title and body.
    pr_commits = []
    default = (github or {}).get("defaultBranch")
    if head and remote and default and git(["rev-parse", "-q", "--verify", "refs/remotes/%s/%s" % (remote, default)], top)[0] == 0:
        log = git_line(["log", "--format=%H%x1f%s", "-n", "50", "refs/remotes/%s/%s..HEAD" % (remote, default)], top)
        pr_commits = [dict(zip(("sha", "subject"), l.split("\x1f", 1))) for l in log.splitlines() if "\x1f" in l]
    bases = []
    if remote:
        # Full names, cut here: `%(refname:short)` turns ambiguous ones into `remotes/<remote>/<branch>`.
        prefix = "refs/remotes/%s/" % remote
        for ref in git_line(["for-each-ref", "--format=%(refname)", prefix], top).splitlines():
            short = ref[len(prefix):] if ref.startswith(prefix) else ""
            if short and short != "HEAD":
                bases.append(short)
    return {
        "head": head,
        "branch": branch,
        "remotes": remotes,
        "upstream": upstream,
        "remote": remote,
        "remoteUrl": remote_url,
        "remotePushUrls": remote_push_urls,
        "remoteBranch": remote_branch,
        "remoteHead": asked_head if separate else (git_line(["rev-parse", "-q", "--verify", tracking], top) or None if has_tracking else None),
        "remoteAsked": separate,
        "remoteError": remote_error,
        # Whether the push destination has a branch of this name: as of the last fetch, or as it answered when asked.
        # None when that couldn't be told. A new branch whose commits the remote already has is ahead by 0, yet
        # still has something to push: the branch itself.
        "remoteBranchExists": (None if remote_error or not remote_branch else asked_head is not None) if separate else (has_tracking if remote_branch else None),
        "ahead": ahead,
        "behind": behind,
        "commits": commits,
        "prCommits": pr_commits,
        "bases": bases,
        "github": github,
    }


def classify_push_failure(output, failed_hooks):
    """What a failed push means. A hook's refusal is known from Git's trace; the rest is read from Git's own lines
    (`fatal:`, `error:`, `remote:` and the porcelain ref lines), never from whatever a hook printed."""
    if failed_hooks:
        return "hook", "The %s hook refused the push. Its output is below. Nothing was pushed." % ", ".join(failed_hooks)
    own = "\n".join(l for l in output.lower().splitlines() if l.startswith(("fatal:", "error:", "remote:", "!", "to ", "hint:")))
    o = own
    # `--porcelain` puts a tab between the flag and the ref, so match the bracketed reason alone.
    if "[remote rejected]" in o:
        return "remote-rejected", "The remote refused the push (a protected branch or a server-side hook, as its message says). Nothing was pushed."
    if "[rejected]" in o or "non-fast-forward" in o or "fetch first" in o:
        return "rejected", "The remote has commits this branch doesn't. Nothing was pushed, and nothing is ever force-pushed: bring them in first (pull or rebase in the Terminal), then push again."
    if any(s in o for s in ("authentication failed", "permission denied", "could not read username", "terminal prompts disabled", "403", "repository not found", "invalid username or password")):
        return "auth", "The remote refused the server's credentials. Nothing was pushed. Sign Git in on the server (for GitHub, gh auth login and gh auth setup-git), then push again."
    if any(s in o for s in ("could not resolve host", "unable to access", "connection timed out", "connection refused", "network is unreachable")):
        return "network", "The server couldn't reach the remote. Nothing was pushed."
    return "git", "Git couldn't push. Its output is below."


def remote_sha(top, remote, branch, timeout=60):
    """The commit the remote has for the branch, asked of the place a push goes (its push URL, which may differ
    from where it fetches); None when it has no such branch."""
    code, out, err = run(["git", "ls-remote", "--heads", push_url(remote, top), "refs/heads/%s" % branch], top, read_only=True, timeout=timeout)
    if code != 0:
        kind, why = classify_push_failure(text(err), [])
        raise Refusal(kind if kind in ("auth", "network") else "git", why.replace(" Nothing was pushed.", ""), redact_text(text(err)))
    # ls-remote matches a pattern against the end of each ref (refs/heads/x/refs/heads/<branch> too): only the
    # branch itself counts.
    want = "refs/heads/%s" % branch
    for line in text(out).splitlines():
        sha, _, ref = line.partition("\t")
        if ref.strip() == want and sha:
            return sha
    return None


def op_push(req):
    """Pushes exactly the commit shown to exactly the remote branch shown. Never --force, never a + refspec, and only
    if the branch is still checked out at that commit. Afterwards the remote is asked what it has."""
    top, _ = checkout(req.get("repo"))
    branch = check_branch_name(req.get("branch"), top)
    remote = req.get("remote")
    check_remote(remote, top)
    remote_branch = check_branch_name(req.get("remoteBranch"), top)
    head = head_oid(top)
    if current_branch(top) != branch or head != (req.get("expect") or {}).get("head"):
        raise Refusal("stale", "The branch or its commit changed since this screen read it. Nothing was pushed. Look again.")
    # The confirmation showed where the push goes. If the remote's push URL changed since (`git remote set-url`),
    # refuse rather than send the commit somewhere the owner didn't see. URLs are compared without credentials.
    url = push_url(remote, top)  # also refuses a remote that would push to several places
    if not isinstance(req.get("pushUrl"), str) or redact(url) != req.get("pushUrl"):
        raise Refusal("stale", "%s now pushes to %s, not where this screen showed. Nothing was pushed. Look again." % (remote, redact(url)))
    # --no-follow-tags and --recurse-submodules=no: push.followTags and push.recurseSubmodules can neither add to
    # the confirmed push nor (with `only`) push submodules in its place.
    code, out, failed = traced(["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", remote, "%s:refs/heads/%s" % (head, remote_branch)], top, timeout=300)
    output = redact_text(text(out))
    if code != 0:
        kind, why = classify_push_failure(output, failed)
        raise Refusal(kind, why, tail(output))
    output = tail(output)
    # The push happened. Anything failing from here on is reported beside it, never as a refused push.
    upstream_set, verify_error, after = False, None, None
    try:
        if not git_line(["config", "--get", "branch.%s.merge" % branch], top):
            git_ok(["config", "branch.%s.remote" % branch, remote], top, read_only=False)
            git_ok(["config", "branch.%s.merge" % branch, "refs/heads/%s" % remote_branch], top, read_only=False)
            upstream_set = True
        after = remote_sha(top, remote, remote_branch)
    except Refusal as r:
        verify_error = r.message + ((" " + r.output.strip()) if r.output.strip() else "")
    return {"pushed": head, "remoteHead": after, "matches": None if verify_error else after == head,
            "verifyError": verify_error, "upstreamSet": upstream_set, "output": output}


def op_remote_head(req):
    """What the remote branch is now, asked of the remote (its push URL). Settles a push whose answer was lost."""
    top, _ = checkout(req.get("repo"))
    remote = check_remote(req.get("remote"), top)
    branch = check_branch_name(req.get("remoteBranch"), top)
    return {"remoteHead": remote_sha(top, remote, branch), "head": head_oid(top)}


def classify_gh_failure(output):
    o = output.lower()
    if "gh auth login" in o or "authentication" in o or "http 401" in o or "bad credentials" in o:
        return "auth", "gh on the server isn't signed in to GitHub, or its sign-in was refused. Run gh auth login there."
    # GitHub lists every reason at once; a base that isn't a branch there explains the others, so it comes first.
    if "base ref must be a branch" in o or "base sha can't be blank" in o:
        return "bad-base", "GitHub has no branch by that name to merge into. It may have been deleted there while this checkout still remembers it. Pick another base."
    if "no commits between" in o:
        return "no-commits", "There are no commits between the base and this branch, so there's nothing for a pull request."
    if "http 403" in o or "must have" in o or "permission" in o:
        return "auth", "GitHub refused: the server's gh sign-in can't open pull requests in this repository."
    return "pr-api", "GitHub refused it. What gh said is below. The branch is pushed, and nothing here will push it again."


def op_pr_create(req):
    """Opens a pull request with the title, body and base the owner wrote, for a branch the remote already has at the
    commit shown. It never pushes: if the remote doesn't have that commit, it refuses."""
    top, _ = checkout(req.get("repo"))
    remote = req.get("remote")
    check_remote(remote, top)
    expect = (req.get("expect") or {}).get("head")
    # The form was written for this branch at this commit. If another process committed or switched branches here
    # since, the screen is out of date: refuse, as Push does, rather than open a pull request from a stale form.
    branch = check_branch_name(req.get("branch"), top)
    if current_branch(top) != branch or head_oid(top) != expect:
        raise Refusal("stale", "The branch or its commit changed here since this screen read it. No pull request was made. Look again.")
    gh_repo = github_repo(configured_push_url(remote, top))
    if not gh_repo:
        raise Refusal("unsupported", "Pull requests are made with gh, for GitHub remotes only, and %s isn't one." % remote)
    if gh_repo != req.get("githubRepo"):
        raise Refusal("stale", "%s is now %s on GitHub, not the repository this screen showed. No pull request was made. Look again." % (remote, gh_repo))
    head_branch = check_branch_name(req.get("remoteBranch"), top)
    base = check_branch_name(req.get("base"), top)
    title = req.get("title")
    body = req.get("body") if isinstance(req.get("body"), str) else ""
    if not isinstance(title, str) or not title.strip():
        raise Refusal("empty-title", "Write a title first.")
    on_remote = remote_sha(top, remote, head_branch)
    if on_remote != expect:
        raise Refusal("not-pushed", "The remote doesn't have this branch at the commit shown%s. Push first; creating a pull request never pushes." % (" (it has %s)" % on_remote[:12] if on_remote else ""))
    existing, _ = gh_json(["pr", "list", "--repo", gh_repo, "--head", head_branch, "--state", "open", "--limit", "10", "--json", PR_FIELDS], top)
    mine = own_prs(existing)
    if mine:
        return {"pr": mine[0], "existing": True, "output": ""}
    args = ["pr", "create", "--repo", gh_repo, "--base", base, "--head", head_branch, "--title", title.strip(), "--body-file", "-"]
    if req.get("draft") is True:
        args.append("--draft")
    code, out, _ = run(["gh"] + args, top, stdin=body.encode("utf-8"), timeout=120, merge_output=True)
    output = text(out)
    url = next((l.strip() for l in reversed(output.splitlines()) if l.strip().startswith("https://")), None)
    if code != 0 or not url:
        kind, why = classify_gh_failure(output)
        raise Refusal(kind, why, output)
    # The pull request exists now. Reading it back is extra: if that fails, even by timing out, its URL is kept.
    try:
        pr, why = gh_json(["pr", "view", url, "--repo", gh_repo, "--json", PR_FIELDS], top, timeout=READBACK_TIMEOUT)
    except Refusal as r:
        pr, why = None, r.message
    return {"pr": pr or {"url": url}, "existing": False, "output": output, "readBack": pr is not None, "readBackError": why or None}


def op_pr_status(req):
    """A pull request's state, review and checks, read from GitHub now."""
    top, _ = checkout(req.get("repo"))
    remote = req.get("remote")
    check_remote(remote, top)
    gh_repo = github_repo(configured_push_url(remote, top))
    number = req.get("number")
    if not gh_repo or not isinstance(number, int) or number <= 0:
        raise Refusal("internal", "No pull request was named.")
    pr, why = gh_json(["pr", "view", str(number), "--repo", gh_repo, "--json", STATUS_FIELDS], top)
    if pr is None:
        kind, message = classify_gh_failure(why)
        raise Refusal(kind if kind == "auth" else "pr-api", "gh couldn't read pull request #%d." % number if kind != "auth" else message, why)
    return pr


OPS = {
    "status": op_status,
    "diff": op_diff,
    "stage": op_stage,
    "unstage": op_unstage,
    "apply": op_apply,
    "preview": op_preview,
    "commit": op_commit,
    "publishInfo": op_publish_info,
    "push": op_push,
    "prCreate": op_pr_create,
    "prStatus": op_pr_status,
    "remoteHead": op_remote_head,
}


STOP_SIGNALS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)
# Set once the app's end of stdin closed: nobody is waiting for an answer any more.
GONE = threading.Event()
# How long a commit, its hooks included, may take. A test makes it short.
COMMIT_TIMEOUT = int(os.environ.get("HERMES_REPO_TEST_COMMIT_TIMEOUT") or 600)


def stop(signum, frame):
    # Ending through SystemExit lets the index lock, and the worktree record's state, be put back on the way out.
    raise SystemExit(128 + signum)


def watch_connection():
    """Ends the helper and everything it started once the app's end of stdin closes (ADR 0043). ssh runs the helper
    without a terminal (`-T`), so a dropped connection sends no hangup: sshd only closes its pipes. The app keeps
    stdin open until it has the answer, so its end means the connection dropped or the app stopped waiting (a time
    limit). The helper gets SIGTERM and ends as for any stop signal: the command it's running and everything that
    command started end (end_child), and the index and the worktree record are put back. If it hasn't ended a while
    later, SIGKILL."""
    # The stop signals go to the main thread, which handles them, and which can then hold them off (LockedIndex).
    signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
    # The file descriptor, not sys.stdin: a daemon thread blocked inside Python's buffered reader holds its lock, and
    # the interpreter then aborts on the way out ("could not acquire lock ... at interpreter shutdown"). Nothing
    # follows the request line, so nothing is left in that reader's buffer.
    try:
        while os.read(0, 65536):
            pass
    except OSError:
        pass
    GONE.set()
    os.kill(os.getpid(), signal.SIGTERM)
    time.sleep(4 * STOP_GRACE)
    os.kill(os.getpid(), signal.SIGKILL)


def main():
    for sig in STOP_SIGNALS:
        signal.signal(sig, stop)
    try:
        try:
            # The request is one line. The rest of stdin stays open until the app has the answer.
            req = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
            threading.Thread(target=watch_connection, daemon=True).start()
            op = OPS.get(req.get("op")) if isinstance(req, dict) else None
            if op is None:
                raise Refusal("internal", "Unknown request.")
            reply = {"ok": True, "v": VERSION, "result": op(req)}
        except Refusal as r:
            reply = {"ok": False, "v": VERSION, "error": {"kind": r.kind, "message": r.message, "output": r.output}}
        except Exception as e:  # noqa: BLE001 - anything else is a bug here, reported as one
            reply = {"ok": False, "v": VERSION, "error": {"kind": "internal", "message": "The helper failed: %r" % (e,), "output": ""}}
        # The mark sets the answer apart from anything a login script printed first (repo_git.rs, MARK).
        sys.stdout.write("\x1ehermes-repo\x1e" + json.dumps(reply))
        sys.stdout.flush()
    finally:
        for idx in list(HELD):
            idx.__exit__()


# main() runs at the end of repo_worktree_helper.py, which Rust sends after this file as one program.
