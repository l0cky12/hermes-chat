import { useEffect, useState, useSyncExternalStore } from "react";
import { connect, type Hermes } from "./hermes/transport";
import { type Account, type SavedSignIn, savedSignIn, signIn, signOut } from "./hermes/account";
import { localChatCache } from "./hermes/chatCache";
import { systemKeyring } from "./hermes/tauriKeyring";
import { tauriPipe, type SignInDetails } from "./hermes/tauriPipe";
import type { Attachment, Chat, Found } from "./hermes/model";
import { ChatList, Rail } from "./ui/Sidebar";
import { ChatPane } from "./ui/ChatPane";
import { SearchPalette } from "./ui/Search";
import { SettingsScreen } from "./ui/Settings";
import { SignIn } from "./ui/SignIn";

const SAVED = "hermes-chat.sign-in"; // Everything but the password, which is in the system keyring.
// Hermes also announces store changes over the socket; the poll catches anything it misses.
const SYNC_EVERY_MS = 60_000;
const TOAST_MS = 5_000;

/** A short notice above the composer; `undo` puts back what it reports. `at` restarts the timer for a repeat. */
type Toast = { text: string; undo?: () => void; at: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function loadSignIn(): SavedSignIn {
  const blank = { mode: "ssh" as const, sshTarget: "", url: "", username: "" };
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(SAVED) ?? "{}") };
  } catch {
    return blank;
  }
}

const account: Account = {
  keyring: systemKeyring,
  store: { load: loadSignIn, save: (d) => localStorage.setItem(SAVED, JSON.stringify(d)) },
  connect: (d) => connect(tauriPipe(d), undefined, localChatCache),
};

/** What launch ends in: signed in with the saved password, or the sign-in screen and why. */
type Launch = { hermes: Hermes } | { initial: SignInDetails; error?: string };
let launching: Promise<Launch> | undefined;

/**
 * Signs in with the saved password, if there is one. If that fails the sign-in screen has it filled in, so Connect
 * tries again. Runs once, though StrictMode runs effects twice.
 */
function launch(): Promise<Launch> {
  return (launching ??= (async () => {
    const saved = await savedSignIn(account);
    if (!saved) return { initial: { ...loadSignIn(), password: "" } };
    try {
      return { hermes: await account.connect(saved) };
    } catch (e) {
      return { initial: saved, error: messageOf(e) };
    }
  })());
}

export default function App() {
  const [hermes, setHermes] = useState<Hermes | null>(null);
  // The sign-in screen's details; none while launch is signing in with the saved password.
  const [initial, setInitial] = useState<SignInDetails>();
  const [error, setError] = useState<string>();
  // Why the keyring couldn't save the password at sign-in, shown once signed in.
  const [notSaved, setNotSaved] = useState<string>();

  useEffect(() => {
    void launch().then((l) => {
      if ("hermes" in l) return setHermes(l.hermes);
      setInitial(l.initial);
      setError(l.error);
    });
  }, []);

  if (hermes)
    return (
      <Main
        hermes={hermes}
        username={account.store.load().username}
        notSaved={notSaved}
        onSignOut={async () => {
          let failure: string | undefined;
          try {
            await signOut(hermes, account);
          } catch (e) {
            failure = messageOf(e);
          }
          setHermes(null);
          setNotSaved(undefined);
          setInitial({ ...loadSignIn(), password: "" });
          setError(failure);
        }}
      />
    );
  if (!initial)
    return (
      <div className="first-run">
        <div className="first-run-card">
          <div className="rail-brand big">H</div>
          <p className="muted">Signing in…</p>
        </div>
      </div>
    );
  return (
    <SignIn
      initial={initial}
      error={error}
      onSignIn={async (d) => {
        setError(undefined);
        try {
          const { hermes: h, notSaved } = await signIn(d, account);
          setNotSaved(notSaved);
          setHermes(h);
        } catch (e) {
          setError(messageOf(e));
        }
      }}
    />
  );
}

function Main({ hermes, username, notSaved, onSignOut }: { hermes: Hermes; username: string; notSaved?: string; onSignOut: () => Promise<void> }) {
  const { profile, chats, olderPulled, status, route, unsecure, closedReason, syncError } = useSyncExternalStore(
    hermes.subscribe,
    hermes.getSnapshot,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [draftError, setDraftError] = useState<string>();
  const [toast, setToast] = useState<Toast | null>(notSaved ? { text: notSaved, at: Date.now() } : null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The search result the chat on screen was opened from; `at` tells one pick from the next.
  const [picked, setPicked] = useState<{ found: Found; at: number } | null>(null);

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

  const openChat = (id: string | null) => {
    setSelectedId(id);
    setPicked(null);
    setSettingsOpen(false);
  };

  const newChat = () => {
    openChat(null);
    setDraftError(undefined);
  };

  const pick = (found: Found) => {
    hermes.reveal(found);
    setSelectedId(found.chatId);
    setPicked({ found, at: Date.now() });
    setSearchOpen(false);
    setSettingsOpen(false);
  };
  const findTarget =
    picked?.found.chatId === selected.id && picked.found.find
      ? { query: picked.found.find, itemId: hermes.locate(picked.found), at: picked.at }
      : undefined;

  const send = async (text: string, attachments: Attachment[]) => {
    let id = selectedId;
    if (!id) {
      try {
        id = await hermes.newChat();
      } catch (e) {
        setDraftError(`Couldn't start a chat: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      openChat(id);
    }
    await hermes.send(id, text, attachments);
  };

  // The other profile's chats replace the list, so the pane starts a fresh draft.
  const switchProfile = (name: string) => {
    newChat();
    setToast(null);
    void hermes.switchProfile(name);
  };

  // Undo sends the opposite change, not a stored copy, so it also works once the list has refreshed.
  const setSettled = (id: string, settled: boolean) => {
    const title = chats.find((c) => c.id === id)?.title ?? "";
    const move = (s: boolean) => void (s ? hermes.settle(id) : hermes.unsettle(id));
    move(settled);
    setToast({ text: `${settled ? "Settled" : "Moved to Active"}: ${title}`, undo: () => move(!settled), at: Date.now() });
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // An opened chat shows its stored history and is marked read; a chat already open on this connection is left as it
  // is. After a reconnect the chat on screen loads again. Settings covers the chat, so it isn't on screen meanwhile.
  useEffect(() => {
    if (!selectedId || status !== "connected" || settingsOpen) return;
    void hermes.open(selectedId);
    return () => hermes.leave(selectedId);
  }, [hermes, selectedId, status, settingsOpen]);

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
      if (k === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (k === "n") {
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
        onSearch={() => setSearchOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      {listOpen && (
        <ChatList
          profile={profile}
          chats={chats}
          syncError={syncError}
          selectedId={settingsOpen ? null : selectedId}
          onOpen={openChat}
          onSettle={setSettled}
          onListProfiles={() => hermes.profiles()}
          onSwitchProfile={switchProfile}
        />
      )}
      <main className="main">
        {settingsOpen ? (
          <SettingsScreen
            status={status}
            route={route}
            unsecure={unsecure}
            username={username}
            passwordSaved={!notSaved}
            profile={profile}
            olderPulled={olderPulled}
            cacheBytes={() => hermes.cacheBytes()}
            onClearCache={() => hermes.clearCache()}
            onPullOlder={() => hermes.pullOlderHistory()}
            onSignOut={onSignOut}
            onClose={() => setSettingsOpen(false)}
          />
        ) : (
          <ChatPane
            key={selected.id}
            chat={selected}
            findTarget={findTarget}
            status={status}
            alsoPostsIn={hermes.alsoPostsIn(selected.id)}
            onAttach={(paths) => hermes.checkAttachments(paths)}
            onSend={send}
            onStop={() => void hermes.stop(selected.id)}
            onAnswer={(approvalId, choice) => void hermes.answerApproval(selected.id, approvalId, choice)}
            onSettle={selected === draft ? undefined : (s) => setSettled(selected.id, s)}
          />
        )}
      </main>
      {searchOpen && <SearchPalette onSearch={(q) => hermes.search(q)} onPick={pick} onClose={() => setSearchOpen(false)} />}
      {toast && (
        <div className="toast" key={toast.at} role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
