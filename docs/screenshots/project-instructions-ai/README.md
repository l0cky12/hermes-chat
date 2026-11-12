# Project instructions with AI screenshots (issue #536, ADR 0152)

Captured on 2026-11-12 from the desktop app's debug build (`verify-hermes-chat` `hv build`: WebKitGTK, embedded frontend) on an Xvfb display, driven through WebDriver. `0-before.png` is `origin/main` at `5efea811`. The rest are this branch at `203f7a74`. Nothing was composited or retouched.

The app was signed in by URL to the skill's stand-in dashboard (the repo's `FakeHermes` behind HTTP and WebSocket), so every call crossed the app's real Rust boundary. For these shots a local copy of the stand-in had a project, "Home server", with two folders. Its `llm.oneshot` gave fixed answers: three questions, then `READY`, and one fixed draft for writing and one for improving. The texts are synthetic. The stand-in's log for the "after" run has six `llm.oneshot` calls, one `session.active_list`, and no `prompt.*` or `session.create`. Its four seeded chats were unchanged at the end.

0. `0-before.png`: before. The Instructions box under Defaults for new chats has no AI button.
1. `1-after-empty-write-with-ai.png`: the box is empty, so the button reads **Write with AI**.
2. `2-write-choose.png`: the dialog names the profile's Text generation model and offers the two ways to start.
3. `3-question-two.png`: Hermes asks one question at a time. The first answer is kept under "Your answers so far". **Skip** and **Write it now** work at any point.
4. `4-write-review.png`: after the third question was skipped, Hermes said it had enough and wrote the draft. **Use this**, **Ask again** (with an optional note), **Back to questions** and **Cancel**.
5. `5-used-unsaved.png`: **Use this** put the draft in the box. The form says "Unsaved changes", and the Instructions card still says "None yet", because nothing is saved until **Save defaults**.
6. `6-improve-side-by-side.png`: with rough text in the box, the button reads **Improve with AI**. The review shows the owner's text beside Hermes's.
7. `7-improve-changes.png`: the same review as a line diff. **Cancel** then left the box exactly as it was, which `wd.mjs value` confirmed.
