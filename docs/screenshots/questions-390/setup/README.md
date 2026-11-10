# Live check for #390

Hermes Chat against a throwaway real Hermes at `f0d94882` (the same `server_requests` contract as `bf0203a`), with a stand-in model.

1. Start the model: `python3 -I fakemodel.py 127.0.0.91 47391`. ASKCLARIFY makes it call `clarify`, ASKSUDO `terminal` with `./sudo apt-get install -y ripgrep`, ASKSECRET `skill_view` on a skill whose key is missing. SLOW holds the reply after the tool result 20 s, so the turn keeps running.
2. Make a Hermes home: `hermes-config.yaml` as `$HERMES_HOME/config.yaml` with `<scratch>/work` filled in, `weather-check-SKILL.md` as `$HERMES_HOME/skills/weather-check/SKILL.md`, and the stand-in `sudo` in `<scratch>/work`. It never runs the real sudo or the command: it reports the password's length and the command.
3. Start the dashboard under `env -i` with basic auth `owner` and a password, on `127.0.0.90:47390` (`.claude/skills/verify-hermes-chat/SKILL.md`, "A real dashboard").
4. Protocol check without the app: `node twoclients.mjs http://127.0.0.90:47390 <password file> clarify clarify.jsonl`, then `sudo` and `secret`. Client B answers first. Client A gets no `request.cancel`, sees the asking tool call finish (`tool.complete`), and gets `expired` when it answers after.
5. App check: `hv up --dashboard http://127.0.0.90:47390`, sign in, then send ASKCLARIFY, ASKSUDO and ASKSECRET in new chats and answer each card (shots 01 to 06). Shared chat: send `ASKCLARIFY SLOW …`, then `node elsewhere.mjs http://127.0.0.90:47390 <password file> <stored session id>` answers it from a second client, and the card closes as answered in another Hermes client while the reply still runs (shot 08). Stop while a sudo password waits closes its card (shot 09). Shot 11 is the light theme.
