import { useEffect, useState, useSyncExternalStore } from "react";
import { connect, type Hermes } from "./hermes/transport";
import { localChatCache } from "./hermes/chatCache";
import { tauriPipe, type SignInDetails } from "./hermes/tauriPipe";
import type { Attachment, Chat } from "./hermes/model";
import { ChatList, Rail } from "./ui/Sidebar";
import { ChatPane } from "./ui/ChatPane";
import { SignIn } from "./ui/SignIn";

const PROFILE = "default";
const SAVED = "hermes-chat.sign-in"; // Everything but the password.
// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;

function savedSignIn(): Omit<SignInDetails, "password"> {
  const blank = { mode: "ssh" as const, sshTarget: "", url: "", username: "" };
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(SAVED) ?? "{}") };
  } catch {
    return blank;
  }
}

export default function App() {
  const [hermes, setHermes] = useState<Hermes | null>(null);
  const [error, setError] = useState<string>();

  if (!hermes)
    return (
      <SignIn
        initial={savedSignIn()}
        error={error}
        onSignIn={async (d) => {
          setError(undefined);
          try {
            const h = await connect(tauriPipe(d), PROFILE, localChatCache);
            const { password: _, ...saved } = d;
            localStorage.setItem(SAVED, JSON.stringify(saved));
            setHermes(h);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
    );
  return <Main hermes={hermes} />;
}

function Main({ hermes }: { hermes: Hermes }) {
  const { chats, status, route, unsecure, closedReason, syncError } = useSyncExternalStore(hermes.subscribe, hermes.getSnapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [draftError, setDraftError] = useState<string>();

  // No chat selected means a fresh draft; the Hermes session is created on the first message.
  const draft: Chat = {
    id: "draft",
    title: "New chat",
    source: "app",
    settled: false,
    updatedAt: Date.now(),
    items: draftError ? [{ kind: "error", id: "e-draft", text: draftError }] : [],
  };
  const selected = chats.find((c) => c.id === selectedId) ?? draft;

  const newChat = () => {
    setSelectedId(null);
    setDraftError(undefined);
  };

  const send = async (text: string, attachments: Attachment[]) => {
    let id = selectedId;
    if (!id) {
      try {
        id = await hermes.newChat();
      } catch (e) {
        setDraftError(`Couldn't start a chat: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      setSelectedId(id);
    }
    await hermes.send(id, text, attachments);
  };

  // An opened chat shows its stored history; a chat already open on this connection is left as it is. After a
  // reconnect the chat on screen loads again.
  useEffect(() => {
    if (selectedId && status === "connected") void hermes.open(selectedId);
  }, [hermes, selectedId, status]);

  // Back on the network: don't wait for the next retry, or for the owner if it gave up.
  useEffect(() => {
    const onOnline = () => void hermes.reconnect();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [hermes]);

  useEffect(() => {
    void hermes.sync();
    const timer = setInterval(() => void hermes.sync(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  }, [hermes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        newChat();
      } else if (k === "b") {
        e.preventDefault();
        setListOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="app">
      <Rail
        status={status}
        route={route}
        unsecure={unsecure}
        closedReason={closedReason}
        onReconnect={() => void hermes.reconnect()}
        onToggleList={() => setListOpen((o) => !o)}
        onNew={newChat}
      />
      {listOpen && (
        <ChatList profile={hermes.profile} chats={chats} syncError={syncError} selectedId={selectedId} onOpen={setSelectedId} />
      )}
      <main className="main">
        <ChatPane
          key={selected.id}
          chat={selected}
          status={status}
          onAttach={(paths) => hermes.checkAttachments(paths)}
          onSend={send}
          onStop={() => void hermes.stop(selected.id)}
        />
      </main>
    </div>
  );
}
