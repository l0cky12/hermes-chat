# Live check for #318

Two Hermes Chat windows and a script that plays an older Hermes app, on one chat of a throwaway Hermes at `bf0203a`.

1. Start the model stand-in: `python3 -I mockllm.py 19818 mockllm.jsonl`. A message with `RUNIT` makes the agent call `terminal` with `rm -rf /tmp/hv318/scratch/old`, which Hermes asks an Approval for. With `SLOW` too, the reply after the command is held for 150 s, so the turn keeps running.
2. Start Hermes from a worktree at `bf0203a` with `hermes-config.yaml` as `$HERMES_HOME/config.yaml`, under `env -i`, basic auth `verify` / `verify-pass`, on `127.0.0.6:19819` (`.claude/skills/verify-hermes-chat/SKILL.md`, "A real dashboard").
3. Protocol check without the app: `node twoclients.mjs http://127.0.0.6:19819 frame frame.jsonl`, then the same with `respond`. With `frame`, the second client gets no `request.cancel`. With `respond`, it gets one with reason `resolved`.
4. App check: two `hv up --dashboard http://127.0.0.6:19819` runs, each signed in with `signin.sh`. App A sends `RUNIT …`, app B opens the chat, app A clicks Deny: shots 1 to 4.
5. Older app: `node oldclient.mjs http://127.0.0.6:19819 go stop oldclient.jsonl` starts a `RUNIT SLOW` chat. Both apps open it from Search. `touch go` answers it in a response frame. App B's card stays up (shot 5); clicking it says it was answered in another client (shot 6). App A's card closes at its next `session.active_list` check while the turn still runs (shot 7). `touch stop` ends the script.
