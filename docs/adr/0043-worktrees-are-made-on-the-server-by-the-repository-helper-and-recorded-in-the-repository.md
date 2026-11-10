# Worktrees are made on the server by the Repository helper, and recorded in the repository

The Repository screen (ADR 0110) has a **Worktrees** view (#82). It lists the repository's worktrees on the server, makes new ones for parallel coding chats, runs their setup once, starts a chat in one, and removes one after a preview that keeps every change first. Every Git operation runs on the Hermes server, through the same constant helper over the owner's own `ssh`, with structured requests and no shell. Nothing runs Git on this computer.

This supersedes ADR 0042, the first design for #82 (merged in #157), which made worktrees through the same helper but put each one at a fixed `<parent>/<repo>.worktrees/<branch>` and kept its record in another format. Worktrees that design made stay readable by Git and are listed here as not made by this app, so they are never removed, set up or attached to from here: its record (`hermes-chat/worktrees.json`) is left as it is, and its lock reason (`hermes-chat <id>`) isn't this one's.

## Why not the dashboard's worktree routes

Hermes at `f0d9488` (deployed, read over SSH on 2026-11-04) has `POST /api/git/worktree/add` and `/remove` (`hermes_cli/web_routers/git.py` over `hermes_cli/web_git.py`), and `GET /api/git/worktrees`. The project screen already uses the list (ADR 0131). The two writes can't meet #82:

- **`add` changes things nobody asked for.** `_ensure_repo` runs `git init` and makes an `Initial commit` in a folder that isn't a repository yet. Asked for the default branch as an "existing branch", it runs `git switch` in the **main checkout**, not in a new worktree. A remote base is fetched first.
- **What's made isn't what was asked.** `_sanitize_branch` rewrites the branch name silently. `_unique_dir` picks `<repo>/.worktrees/<slug>-2` when the folder exists, so the path can't be shown before. If the branch already exists, the base is ignored and that branch is checked out.
- **It lands where Hermes cleans up.** The folder is always `<repo>/.worktrees/…`. Hermes's own sweep (`hermes_cli/worktree_ops._prune_stale_worktrees`, `worktree_sweep.run_sweep`) archives and removes idle trees there, unlocks locks that aren't Hermes's, and `branch -D`s what it removed.
- **`remove` passes `force` straight through,** with no preview, no preservation, and no check for chats or other users.
- **Hooks and the owner's config are off,** as for the review routes (ADR 0110).

The helper does the same Git operations itself. A dashboard that fixed these would be the better contract: see **Backend gap** below.

## How it works

The helper's second half (`src-tauri/src/repo_worktree_helper.py`) adds eleven requests to `repo_git::Request`: `worktreeList`, `worktreePlan`, `worktreeCreate`, `worktreeSetup`, `worktreeAttach`, `worktreeAttachConfirm`, `worktreeDetach`, `worktreeProtect`, `worktreeRemovePlan`, `worktreeRemove` and `worktreeForget`. Rust sends both halves as one program. It is now deflated before base64 (`flate2`, already in the tree), because Linux limits a single argument, which the remote shell gets, to 128 KiB.

### The record: who made which worktree, and which chats work in it

What this app made is recorded **in the repository**, in `<git common dir>/hermes-chat/managed-worktrees.json` (version 1, mode 0700 folder; `worktrees.json` beside it is ADR 0042's record and is never touched). It is changed only while holding an exclusive `flock` on `worktrees.lock` beside it, and written to a temporary file that is fsynced and renamed. So:

- Every desktop and every copy of this app reads the same owners and chats. Nothing about a worktree is kept only on one computer.
- An attach and a removal can't both pass their checks: each holds the lock from its check to its write. A second change waits up to 15 s, then answers `busy` and changes nothing.
- A record names the worktree's id (16 random hex digits from the webview, checked by the helper), path, branch, whether it was new, the base as typed and its commit, the checkout setup copied from, when it was made, Protected, its state, setup's entries and log, and its chats.
- A chat is `{token, chat, profile, connection, state, at}`. `profile` and `connection` keep one connection's or profile's chats apart from another's: a chat is named by its title only in the profile and connection it belongs to.
- A record written by a newer version is read, and never written.
- The worktree is also locked with `git worktree lock --reason "hermes-chat: managed worktree <id>"`, so `git worktree remove` and `prune` run elsewhere leave it alone.

### Create: an explicit preview, then exactly that

`worktreePlan` checks everything and changes nothing. It returns:

- **Branch.** It is checked with `git check-ref-format --branch`, and can't start with `-`. A new branch must not exist yet. An existing branch must be a local branch that no worktree has checked out. Names `hermes/hermes-…` and `pr-…` are refused: Hermes's sweep (`_prune_orphaned_branches`) runs `branch -D` on those once no worktree has them, so a branch kept after removal would be lost.
- **Base.** It is resolved with `rev-parse --verify --end-of-options <base>^{commit}`, and shown as its full ref, commit and subject. Nothing is fetched: a remote branch must already be known.
- **Path.** It must be absolute, without `.` or `..`, and have a parent folder that exists and the SSH user can write to. It must not exist yet, and must not be inside any worktree (the main checkout and its `.worktrees` included) or the Git folder. With no path, the default is a folder beside the main checkout, `<repo>-<branch slug>`, with `-2`, `-3` and so on when taken.
- **Source checkout.** Its changes are counted and shown: they stay there, and the new worktree starts from the base without them.
- **Submodules.** The base's submodules are listed (from `.gitmodules` in the base commit). Git doesn't check them out in a new worktree, and this app doesn't either.
- **Setup.** Each entry it would act on is listed, and the plan says that setup commands aren't supported.
- **Stamp.** The plan carries a SHA-256 of the base commit, branch, mode, branch tip, path and setup entries.

`worktreeCreate` makes the plan again and refuses with `stale` if the stamp differs, and with `duplicate` if the id was already used. Under the record's lock it refuses (`exists`) if any record already names that folder, or anything is there, so two creations for one folder can't both be recorded. It then writes the record (`creating`) **before** Git runs. A new branch is made with `git worktree add --no-track -b <branch> <path> <commit>`; an existing one with `git worktree add <path> <branch>`. Git runs with the owner's hooks and config, so `post-checkout` runs. Then the worktree is locked, and the record says `ready`, or `setup` if setup was asked for. A failed `git worktree add` drops the record. A branch Git made before failing is kept and named. If Git made and checked out the worktree but reports failure because something after it failed (a `post-checkout` hook), the worktree is kept and recorded as a failed setup. That's only when it has the branch asked for and Git didn't say the folder or branch was already there, with the hook's output as its log. Retry, Open and Remove work as for any failed setup.

### Setup, once, with progress

The only environment setup Hermes supports for worktrees is `.worktreeinclude` (`hermes_cli/worktree_ops._copy_worktree_includes`, used by `hermes -w`). It lists files and folders that Git ignores but an agent needs, such as `.env` or `node_modules`. Setup reads it from the checkout the screen has open, as Hermes reads it from its own. It copies files and links folders, with Hermes's guards: both ends must resolve inside their checkouts. It goes further in three ways. A path Git tracks is skipped, so an edit to a tracked file in the source checkout is never carried over. A file already in the worktree that differs is left as it is, since it could be the owner's edit. A folder link is made only where nothing is.

Setup is claimed under the record's lock: only from a state that allows it, and only while no other helper holds the worktree. Only the run that claimed it writes its outcome, so two Retries can't both run, and a removal or a chat can't slip in while one does.

Each step is printed on stderr as a progress line, and Rust passes it on as it comes (`repo_git_stream`, a Tauri `Channel`). The log, cut at 64 KiB, and each entry's result are kept in the record. If any entry fails, the state is `setup-failed`. The worktree is kept, and the list offers **Retry setup**, **Open**, and **Start a chat here**. Setup that worked isn't run again.

**Setup commands** (an install script, say) aren't run. Hermes has no contract that declares them for a repository, and running something the screen made up would be inventing one. The dialog says so.

### A dropped connection during creation or setup

A dropped ssh ends the helper (SIGHUP, or SIGKILL when the app gives up), and a `git worktree add` it was running ends with it. The record names the helper that marked it busy: pid, boot id and process start time, so a reused pid isn't taken for it. The next list finds that helper gone, and reports `create-interrupted`, `setup-interrupted` or `remove-interrupted` in place of `creating`, `setup` or `removing`.

- **Setup cut off:** Retry runs setup again.
- **Cut off after Git made the worktree:** Retry locks it and finishes.
- **Cut off while Git was checking out files** (Git's own `initializing` lock is still there): the worktree can only be removed. The removal preview lists what's there and keeps it.
- **Cut off before Git made anything:** the record is listed under "Recorded, but not on disk", and **Forget it** drops the record. Nothing on disk changes.

The New worktree dialog, when its answer is lost (`timeout`, `ssh…`, `spawn`, `bad-reply`), never sends the creation again. It reads the list and says what the record shows for its id.

### Starting a chat in a worktree

**Start a chat here** (or **Start a chat in it** after creating) opens the New chat pane with the worktree as the chat's folder, labelled "chosen for this chat". That beats a project's default folder, so ordinary project folders work as before. **Don't start it there** goes back to them. The choice is kept with the pane, and used only under the connection and profile it was picked in.

When the owner sends the first message:

1. The folder is checked with `GET /api/fs/list`, as for any folder (ADR 0017).
2. `worktreeAttach` holds the chat's place in the record, under a new token. From then on the worktree can't be removed. It is refused while the worktree is being made, set up or removed, or isn't there.
3. `session.create` runs with `cwd` and `cwd_explicit: true`. The chat is kept only if Hermes's `info.cwd` is exactly the worktree. Otherwise, or if it fails, the place is let go (`worktreeDetach`), and the message goes back in the composer.
4. `worktreeAttachConfirm` records the chat's id. If that fails, the chat has started and its place stays held, as `starting`, which still blocks removal. The app says so.

This computer keeps a copy of which chat it started in which worktree (`hermes-chat.worktree-chats`), so the chat's header shows the branch. Clicking it opens the Repository screen on the Worktrees view. The record on the server is what removal checks.

### The list

`worktreeList` reads `git worktree list --porcelain -z` (Git 2.36 or newer; older Git answers `unsupported`, and the rest of the screen still works). For the first 40 worktrees it also reads:

- changes: staged, changed, untracked and in conflict, from one `status --porcelain=v2 -z --untracked-files=all --ignore-submodules=none`, with setup's own links left out;
- commits no remote has (`rev-list HEAD --not --remotes`), and, for a detached HEAD, commits no branch, tag or remote has;
- the upstream, with ahead and behind as of the last fetch;
- submodules checked out.

It also gives what this app recorded and why a worktree can't be removed:

- **main**: the main checkout;
- **unmanaged**: not made by this app;
- **marked**: Protected by the owner;
- **locked**: locked by another tool, Hermes included.

It lists records whose worktree Git doesn't list, and changes kept from removed worktrees (`refs/hermes-chat/kept/*`).

### Removal: preview, keep, remove

**A quiet chat never makes a worktree disposable.** `worktreeRemovePlan` lists everything a removal would touch, and refuses for any of these blockers:

- the main checkout, a worktree this app didn't make, a Protected one, or one locked by another tool;
- **any attached chat**, `starting` included, until the owner detaches it (which says the chat keeps working in the folder);
- a helper still making, setting up or removing it;
- **any process of the SSH user whose folder is inside it** (`/proc/*/cwd`), such as an agent, shell or build;
- a submodule with changes, or with commits on any local branch or tag, or a stash, that no remote has (its Git folder goes with the worktree);
- a separate Git repository inside it;
- a file over 100 MiB, too big to keep in the repository's objects;
- a merge, rebase, cherry-pick or revert in progress, whose state goes with the worktree.

It shows every changed and untracked file (the first 2,000), the commits no remote has (which stay on the branch), the ignored files, which go with the folder and aren't kept, and what will be kept.

The screen also asks Hermes, with `GET /api/sessions?cwd_prefix=<path>&archived=include&profile=` in every profile, which chats from any Hermes client work in or under the folder. Only rows whose own `cwd` is inside the folder count. An active one blocks removal. Quiet ones are listed, and Remove waits for the owner to tick "none of them needs this folder". The same tick is needed when Hermes isn't connected or can't be asked.

The plan also refuses while another Git process holds the worktree's `index.lock`. A tracked file marked `assume-unchanged`, or `skip-worktree` but on disk anyway, is compared with its staged blob. If it differs, it's listed as a change that Git's status doesn't show, and it's kept like the others: the flag is cleared in the copy of the index only.

The plan's stamp is a SHA-256 of HEAD, the branch, each changed path with its status and its content (SHA-256 of the bytes, or size, time and inode over 32 MiB), the index (`ls-files --stage`), each ignored path with its size and time, and every file and folder inside an ignored folder (up to a million; past that, the preview says later changes to the rest aren't noticed), the state, and setup's links. So staging a file, or an ignored file that appears after the preview, makes the preview stale. Hermes's session list is read page by page, 100 at a time, up to 5,000 chats per profile. More than that, or a page that isn't a list, refuses rather than answering for part of it.

`worktreeRemove` holds the record's lock throughout, so no chat can be attached meanwhile. It makes the plan again, and refuses with `blocked` or `stale` if anything differs. Then:

1. **Keep.** If any file changed, or HEAD has commits no branch has, the helper keeps them first, as `git stash` would but without touching the worktree. It copies the worktree's index into a **separate index file** (`GIT_INDEX_FILE`). If the staged state differs from HEAD, it is a commit of its own on top of HEAD, so a staged version that differs from the file on disk, or an ignored file added with `git add -f`, is kept too. An index with conflicts has no tree, so then only the working files are kept, and the commit says so. Then every change goes into the copy with `git add -A`, setup's links come out, and it's refreshed. Git confirms the snapshot holds everything: `diff-files` finds nothing different, and `ls-files --others --exclude-standard` finds nothing untracked but setup's links (an ignored link isn't listed at all). The helper writes the tree and commits it on top of the staged commit (or HEAD) as "Hermes Chat", which runs no hooks. Then it **creates** `refs/hermes-chat/kept/<id>-<UTC time>` with `update-ref --stdin` `create`, which never moves an existing ref, and reads it back. With only a detached HEAD's commits to keep, the ref points at HEAD itself. The worktree's own index and files aren't touched.
2. **Check again.** The plan is made once more; anything that changed while keeping refuses with `stale`.
3. **Remove.** Its lock is lifted, then `git worktree remove` runs, with `--force` only when changes were kept or submodules are checked out. If Git refuses, the lock goes back. Afterwards the folder and Git's entry must be gone.
4. **If it fails,** the record gets back the state it had, so a failed setup keeps Retry. If Git dropped its own entry but couldn't delete the whole folder (a file it wasn't allowed to delete), the record is listed under "Recorded, but not on disk" with what's left. The owner looks at it, moves what they need, deletes the folder, then forgets the record.
5. **Never the branch.** No branch is deleted. Its unpushed commits stay on it, and the screen says how many.

Kept changes are listed with **Restore in a new worktree…**, which opens New worktree with the kept ref as the base. Nothing here deletes a kept ref.

**Protect** marks a worktree this app made, and a protected worktree can't be removed. Detaching is explicit, and confirmed first.

### Late answers, scope and keyboard

- The Worktrees view is keyed by target and repository, and every read is numbered, so an answer for an earlier one is dropped. The dialogs drop answers once closed.
- A chat is named by title only for the profile and connection shown; other profiles' chats are named by id and profile.
- Changes and Worktrees are tabs, which the arrow keys move between. Dialogs keep Tab inside, close on Escape and give focus back.
- Both views wrap in a narrow or split window.

## Considered options

- **The dashboard's `worktree/add` and `worktree/remove`.** Rejected, as above.
- **Keep the record on this computer** (like project defaults, ADR 0017). Rejected: a second computer, or a task started from another app, couldn't see which chats work in a worktree. The check and the removal would also not be under one lock on the machine where the worktree is.
- **Put worktrees under `<repo>/.worktrees`,** as Hermes does. Rejected: Hermes's sweep reaps idle trees there, its branches included.
- **Keep changes with `git stash`.** Rejected: the stash is shared by every worktree and every agent, which can pop or drop it, and it touches the worktree's index and files.
- **Delete the branch with `branch -d` after removing.** Rejected: #82 forbids branch deletion, and an unpushed branch is the change itself.
- **Run a setup script named in the repository.** Rejected: there's no Hermes contract for one. See below.

## Backend gap

Two things would need Hermes:

1. **Worktree routes that do only what was asked.** Hermes would need:
   - `POST /api/git/worktree/plan {path, base, branch, newBranch, target}`: read-only, returns the resolved commit, the final path and a stamp.
   - `POST /api/git/worktree/add {…, expect}`: no `git init`, no fetch, no switching the main checkout, no renaming, the path as given, the owner's hooks and config, and refusing on a stale stamp.
   - `POST /api/git/worktree/remove {path, worktreePath, expect}`: keeps changes under a ref first, refuses while sessions or processes use the folder, never deletes a branch.
   - Its sweep would leave trees outside `.worktrees` and branches it didn't make alone, as it does now.
2. **Setup commands.** A repository-declared, reviewable setup list (say `.hermes/worktree-setup.yaml` with argv lists) and a `POST /api/git/worktree/setup` that runs it once in the worktree, with the profile's environment, a time limit, and a streamed log the session store keeps. Until then the screen shows "Setup commands aren't run" and offers the chat or the Terminal.

Ownership could also move to Hermes's own `worktree_registry` (per profile, today a list of repositories), extended with the worktree, its creator and its sessions, which `session.create` with a `cwd` inside a worktree would add to. Then other Hermes clients would see a worktree's chats too.

## Consequences

- **What the server needs:** what ADR 0110 needs, and Git 2.36 or newer for worktrees. Older Git says the server isn't supported for worktrees.
- **Stored on the server, in the repository:**
  - `<git common dir>/hermes-chat/managed-worktrees.json` and `worktrees.lock`, removed with the repository (the lock file is shared with ADR 0042's helper, so the two never change the folder at once);
  - kept changes as `refs/hermes-chat/kept/*` commits, which `git gc` keeps because they are refs.
- **Stored on this computer:** which chat was started in which worktree, for each connection and profile (`hermes-chat.worktree-chats`, webview local storage). It's a convenience: lost or cleared, a chat only stops showing its branch.
- **Time limits:** creating and setup get 30 minutes, Git's checkout 15 of them. Removing gets 20, reading a removal plan or the list 5, everything else 60 s.
- **The check-then-remove gap:** after the last check, `git worktree remove` runs within milliseconds. A file written in that moment by a process that started after the process check is lost with the folder. A chat started from another app in that moment isn't seen by Hermes's list in time.
- **A profile switch during a chat's start:** each wait on the server is a chance to switch profile. Before Hermes is asked, the profile is checked again; a switch lets the place go and starts nothing. After it, a switch means the chat started empty in its own profile, its message wasn't sent, and it stays in the composer, for that profile.
- **What isn't covered:**
  - Hermes's own sweep isn't changed. It leaves this app's worktrees alone only because they're outside `.worktrees` and their branches aren't named like its own.
  - Chats from other clients are found only through Hermes's session list, and only for profiles the dashboard lists.
- **Verification limits:**
  - The helper is tested by running the exact remote command through `sh -c` against real repositories (`src-tauri/tests/repo_worktree.rs`). That covers:
    - new and existing branches, and a dirty source checkout;
    - setup that fails and is retried, two Retries at once, and a failing `post-checkout` hook;
    - a creation killed during setup, and found again;
    - at removal: dirty, untracked, staged (with `-f` too) and unpushed work kept, a detached HEAD, an ignored setup link, and ignored files that appear after the preview;
    - submodules, Protected and foreign-locked worktrees, and attached chats and processes blocking removal;
    - a second task holding the lock.
  - The screen and the chat start are tested against fakes (`src/ui/worktrees.test.tsx`, `src/ui/worktreeChats.test.tsx`).
  - ssh and the real server were exercised by hand for the screenshots (`docs/screenshots/worktrees/README.md`).
