// Chat stats, the bundled sample extension (ADR 0126, section 9). It runs in the sandbox as any extension would: a
// worker with no network and no storage, whose only channel is the port in its first message. /stats reads the call's
// chat with chat.read, counts its messages and words by who wrote them, and draws the counts in its view.
self.onmessage = (first) => {
  self.onmessage = null;
  const port = first.ports[0];
  const waiting = new Map();
  let next = 1;
  const send = (m) => port.postMessage(JSON.stringify({ jsonrpc: "2.0", ...m }));
  const call = (method, params) =>
    new Promise((ok, no) => {
      const id = next++;
      waiting.set(id, { ok, no });
      send({ id, method, params });
    });

  const words = (text) => (text.match(/\S+/g) || []).length;
  async function draw(callId) {
    const messages = await call("chat.read", { call: callId });
    const by = { user: { n: 0, w: 0 }, assistant: { n: 0, w: 0 } };
    for (const m of messages) {
      by[m.role].n += 1;
      by[m.role].w += words(m.text);
    }
    const total = { n: by.user.n + by.assistant.n, w: by.user.w + by.assistant.w };
    await call("view.update", {
      id: "stats",
      nodes: [
        { kind: "heading", text: "This chat" },
        {
          kind: "table",
          columns: ["Who", "Messages", "Words"],
          rows: [
            ["You", String(by.user.n), String(by.user.w)],
            ["Hermes", String(by.assistant.n), String(by.assistant.w)],
            ["Both", String(total.n), String(total.w)],
          ],
        },
        total.n
          ? { kind: "facts", facts: [{ label: "Words per reply", value: by.assistant.n ? String(Math.round(by.assistant.w / by.assistant.n)) : "none yet" }] }
          : { kind: "notice", text: "This chat has no messages yet." },
        { kind: "button", label: "Count again", command: "stats" },
      ],
    });
    return `${total.n} message${total.n === 1 ? "" : "s"}, ${total.w} word${total.w === 1 ? "" : "s"}. The Chat stats view has the details.`;
  }

  const handlers = {
    activate: () => null,
    ping: () => null,
    deactivate: () => null,
    "command.run": async (p) => ({ text: await draw(p.call) }),
    "view.render": async (p) => (await draw(p.call), null),
  };

  port.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.method === undefined) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (w) m.error ? w.no(new Error(m.error.message)) : w.ok(m.result);
      return;
    }
    const handle = handlers[m.method];
    if (m.id === undefined) return;
    if (!handle) return send({ id: m.id, error: { code: -32601, message: `method_not_found: ${m.method}` } });
    try {
      send({ id: m.id, result: await handle(m.params || {}) });
    } catch (err) {
      send({ id: m.id, error: { code: -32000, message: String((err && err.message) || err) } });
    }
  };
};
