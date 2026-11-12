// Settings → Snapshots (ADR 0123): the Snapshot host this computer publishes to, and every snapshot in its bucket.
// The host card saves the settings with their secret key, which Rust keeps in the keyring and the webview never sees
// again; Change asks for the secret once more, so it is never sent to an edited endpoint. The list is read from the
// bucket each time the tab opens, and after a Save, Remove or Revoke.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Copy, Pencil, PlugZap, RefreshCw, Trash2, X } from "lucide-react";
import {
  DEFAULT_PREFIX,
  clipboardText,
  endpointHost,
  sameHost,
  snapshotTime,
  tauriSnapshots,
  type Snapshot,
  type SnapshotApi,
  type SnapshotHost,
} from "../hermes/snapshots";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { Spinner } from "./bits";
import { errorText } from "../hermes/values";

type Form = SnapshotHost & { secret: string };

const EMPTY: Form = { endpoint: "", region: "", bucket: "", prefix: DEFAULT_PREFIX, keyId: "", secret: "" };

const FIELDS: { key: keyof Form; label: string; placeholder: string; hint?: string; optional?: true }[] = [
  { key: "endpoint", label: "Endpoint", placeholder: "https://s3.us-east-1.amazonaws.com", hint: "The host's S3 address, with no bucket or path." },
  { key: "region", label: "Region", placeholder: "us-east-1", hint: "Cloudflare R2 uses auto." },
  { key: "bucket", label: "Bucket", placeholder: "my-snapshots" },
  { key: "prefix", label: "Prefix", placeholder: "None", hint: "Every snapshot's name in the bucket starts with this.", optional: true },
  { key: "keyId", label: "Access key ID", placeholder: "AKIA…" },
  { key: "secret", label: "Secret access key", placeholder: "", hint: "Kept in this computer's keyring with the settings above. Hermes Chat never shows it again." },
];

/** What a form is missing, in words, or nothing when every required field is filled in. */
function formProblem(form: Form): string | undefined {
  const missing = FIELDS.filter((f) => !f.optional && !form[f.key].trim()).map((f) => f.label);
  if (!missing.length) return undefined;
  const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  return `${names} ${missing.length === 1 ? "is" : "are"} needed.`;
}

type HostOp = "saving" | "testing" | "confirmRemove" | "removing";
type RowOp = { id: string; kind: "linking" | "confirmRevoke" | "revoking" };
type Note = { where: "host" | `row:${string}`; ok: boolean; text: string };
type ListState = { snapshots?: Snapshot[]; loading: boolean; error?: string };

const titleOf = (s: Snapshot) => ("title" in s && s.title ? s.title : "Untitled snapshot");

export function SnapshotSettings({ api = tauriSnapshots, copyText = clipboardText }: { api?: SnapshotApi; copyText?: (text: string) => Promise<void> }) {
  const ids = useId();
  /** The saved host: undefined while it's read, null when none is saved. */
  const [host, setHost] = useState<SnapshotHost | null>();
  const [hostError, setHostError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [hostOp, setHostOp] = useState<HostOp>();
  const [rowOp, setRowOp] = useState<RowOp>();
  const [note, setNote] = useState<Note>();
  const [list, setList] = useState<ListState>({ loading: false });
  const alive = useRef(true);
  const shown = useRef<SnapshotHost | null>(null);
  const reads = useRef(0);

  const showHost = (h: SnapshotHost | null) => {
    shown.current = h;
    setHost(h);
  };

  /** Reads the list for the host shown. An answer read with other settings, or after a newer read, is dropped. */
  const readList = () => {
    const from = shown.current;
    if (!from) return;
    const read = ++reads.current;
    setList((l) => ({ ...l, loading: true, error: undefined }));
    api.list(from).then(
      (l) => {
        if (!alive.current || read !== reads.current) return;
        if (!shown.current || !sameHost(l.host, shown.current))
          return setList({ loading: false, error: "The snapshot host changed while the list was read. Refresh to read it again." });
        setList({ snapshots: l.snapshots, loading: false });
      },
      (e: unknown) => {
        if (!alive.current || read !== reads.current) return;
        setList((l) => ({ ...l, loading: false, error: errorText(e) }));
      },
    );
  };

  const readHost = () => {
    setHostError(undefined);
    api.host().then(
      (h) => {
        if (!alive.current) return;
        showHost(h);
        if (h) readList();
      },
      (e: unknown) => alive.current && setHostError(errorText(e)),
    );
  };

  useEffect(() => {
    alive.current = true;
    readHost();
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once each time the tab opens; `readHost` is new every render
  }, [api]);

  const busy = hostOp === "saving" || hostOp === "testing" || hostOp === "removing";

  const save = async () => {
    const problem = formProblem(form);
    if (problem) return setNote({ where: "host", ok: false, text: problem });
    const { secret, ...typed } = form;
    setHostOp("saving");
    setNote(undefined);
    try {
      const saved = await api.saveHost(typed, secret);
      if (!alive.current) return;
      showHost(saved);
      setEditing(false);
      setForm(EMPTY);
      setList({ loading: false });
      setNote({ where: "host", ok: true, text: "Saved. Test checks that the key can list the bucket." });
      readList();
    } catch (e) {
      if (alive.current) setNote({ where: "host", ok: false, text: `Not saved: ${errorText(e)}` });
    } finally {
      if (alive.current) setHostOp(undefined);
    }
  };

  const test = async () => {
    if (!host) return;
    setHostOp("testing");
    setNote(undefined);
    try {
      await api.testHost(host);
      if (alive.current) setNote({ where: "host", ok: true, text: "The host answered, and the key can list the bucket's snapshots." });
    } catch (e) {
      if (alive.current) setNote({ where: "host", ok: false, text: `The test failed: ${errorText(e)}` });
    } finally {
      if (alive.current) setHostOp(undefined);
    }
  };

  const remove = async () => {
    setHostOp("removing");
    setNote(undefined);
    try {
      await api.clearHost();
      if (!alive.current) return;
      showHost(null);
      reads.current++;
      setList({ loading: false });
      setRowOp(undefined);
      setNote({ where: "host", ok: true, text: "Removed from this computer. Snapshots already published stay in the bucket until they end." });
    } catch (e) {
      if (alive.current) setNote({ where: "host", ok: false, text: `Not removed: ${errorText(e)}` });
    } finally {
      if (alive.current) setHostOp(undefined);
    }
  };

  const copyLink = async (s: Snapshot) => {
    if (!host) return;
    setRowOp({ id: s.id, kind: "linking" });
    setNote(undefined);
    try {
      const url = await api.link(host, s.id);
      await copyText(url);
      if (alive.current) setNote({ where: `row:${s.id}`, ok: true, text: "Link copied." });
    } catch (e) {
      if (alive.current) setNote({ where: `row:${s.id}`, ok: false, text: `Couldn't copy the link: ${errorText(e)}` });
    } finally {
      if (alive.current) setRowOp(undefined);
    }
  };

  const revoke = async (s: Snapshot) => {
    if (!host) return;
    setRowOp({ id: s.id, kind: "revoking" });
    setNote(undefined);
    try {
      await api.revoke(host, s.id);
      if (!alive.current) return;
      setList((l) => ({ ...l, snapshots: l.snapshots?.filter((x) => x.id !== s.id) }));
      setRowOp(undefined);
      readList();
    } catch (e) {
      if (!alive.current) return;
      setRowOp(undefined);
      setNote({ where: `row:${s.id}`, ok: false, text: errorText(e) });
    }
  };

  const lineOf = (where: Note["where"]) =>
    note?.where === where && (
      <div className={`pk-line ${note.ok ? "ok" : "bad"}`} role={note.ok ? "status" : "alert"}>
        {note.text}
      </div>
    );

  const hostSection = (children: ReactNode) => (
    <SettingsSection
      title="Snapshot host"
      intro={
        <>
          Share snapshot publishes a chat's page to an S3-compatible bucket you name, such as Amazon S3, Cloudflare R2, Backblaze B2 or MinIO. The bucket
          stays private: each page is reached by a signed link that lasts at most 7 days. Use a key limited to the prefix, with <code>GetObject</code>,{" "}
          <code>PutObject</code>, <code>GetObjectVersion</code>, <code>DeleteObject</code>, <code>DeleteObjectVersion</code>, <code>ListBucket</code> and{" "}
          <code>ListBucketVersions</code>. Reading back, links and Revoke need the version permissions.
        </>
      }
    >
      {children}
    </SettingsSection>
  );

  const field = (f: (typeof FIELDS)[number]) => (
    <SettingRow key={f.key} name={<label htmlFor={`${ids}-${f.key}`}>{f.label}</label>} about={f.label} hint={f.hint}>
      <input
        id={`${ids}-${f.key}`}
        className="pk-input"
        type={f.key === "secret" ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        placeholder={f.placeholder}
        value={form[f.key]}
        disabled={busy}
        onChange={(e) => {
          setForm({ ...form, [f.key]: e.target.value });
          if (note?.where === "host" && !note.ok) setNote(undefined);
        }}
      />
    </SettingRow>
  );

  const hostForm = (
    <form
      className="si-add"
      aria-label={host ? "Change the snapshot host" : "Set up a snapshot host"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {host && <SettingNote role="status">Type the secret access key again: it is only ever sent with the settings it was saved with.</SettingNote>}
      {FIELDS.map(field)}
      <div className="confirm-actions">
        {host && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setForm(EMPTY);
              setNote(undefined);
            }}
          >
            Cancel
          </button>
        )}
        <button type="submit" className="btn primary" disabled={busy}>
          {hostOp === "saving" && <Spinner />} {hostOp === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      {lineOf("host")}
    </form>
  );

  const hostCard = (() => {
    if (hostError)
      return (
        <SettingNote tone="bad" role="alert">
          <AlertTriangle size={14} />
          <span>Couldn't read the snapshot host from the keyring: {hostError}</span>
          <button className="btn" onClick={readHost}>
            Try again
          </button>
        </SettingNote>
      );
    if (host === undefined)
      return (
        <SettingNote role="status">
          <Spinner /> Reading the snapshot host…
        </SettingNote>
      );
    if (!host || editing) return hostForm;
    return (
      <SettingRow
        name={<span className="mono">{endpointHost(host.endpoint)}</span>}
        hint={
          <>
            Bucket <span className="mono">{host.bucket}</span>, prefix <span className="mono">{host.prefix || "none"}</span>, region{" "}
            <span className="mono">{host.region}</span>, key <span className="mono">{host.keyId}</span>
          </>
        }
        control={
          hostOp !== "confirmRemove" &&
          hostOp !== "removing" && (
            <>
              <button className="btn" disabled={busy} onClick={() => void test()}>
                {hostOp === "testing" ? <Spinner /> : <PlugZap size={13} aria-hidden />} {hostOp === "testing" ? "Testing…" : "Test"}
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  const { endpoint, region, bucket, prefix, keyId } = host;
                  setForm({ endpoint, region, bucket, prefix, keyId, secret: "" });
                  setNote(undefined);
                  setEditing(true);
                }}
              >
                <Pencil size={13} aria-hidden /> Change
              </button>
              <button className="btn" disabled={busy} onClick={() => (setNote(undefined), setHostOp("confirmRemove"))}>
                <Trash2 size={13} aria-hidden /> Remove
              </button>
            </>
          )
        }
      >
        {(hostOp === "confirmRemove" || hostOp === "removing") && (
          <div className="confirm set-confirm" role="alertdialog" aria-label="Remove the snapshot host?">
            <span className="confirm-msg">
              Remove the host and its secret key from this computer? Snapshots already published stay in the bucket, and their links work until they end.
              Revoke them first to stop them sooner.
            </span>
            <div className="confirm-actions">
              <button className="btn" disabled={busy} onClick={() => setHostOp(undefined)}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void remove()}>
                {hostOp === "removing" && <Spinner />} {hostOp === "removing" ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        )}
        {lineOf("host")}
      </SettingRow>
    );
  })();

  const row = (s: Snapshot) => {
    const mine = rowOp?.id === s.id ? rowOp : undefined;
    const title = titleOf(s);
    const created = "created" in s && s.created ? `Published ${snapshotTime(s.created)}` : undefined;
    const hint: ReactNode = (() => {
      switch (s.state) {
        case "live":
          return `${created}. Ends ${snapshotTime(s.expires)}.`;
        case "expired":
          return `${created}. Ended ${snapshotTime(s.expires)}, but Hermes Chat couldn't delete it from the bucket.`;
        case "changed":
          return `${created ? `${created}. ` : ""}Something else changed this page in the bucket, so Hermes Chat won't offer its link.`;
        case "unrevoked":
          return "Revoke didn't finish: older copies of this page are still in the bucket.";
      }
    })();
    return (
      <SettingRow
        key={s.id}
        name={s.state === "unrevoked" ? <span className="mono">{s.id}</span> : title}
        about={s.state === "unrevoked" ? s.id : title}
        hint={hint}
        className={`snapshot-row ${s.state}`}
        control={
          !(mine?.kind === "confirmRevoke" || mine?.kind === "revoking") && (
            <>
              {s.state === "live" && (
                <button className="btn" disabled={!!rowOp} aria-label={`Copy link to ${title}`} onClick={() => void copyLink(s)}>
                  {mine?.kind === "linking" ? <Spinner /> : <Copy size={13} aria-hidden />} Copy link
                </button>
              )}
              <button className="btn" disabled={!!rowOp} aria-label={`Revoke ${s.state === "unrevoked" ? s.id : title}`} onClick={() => (setNote(undefined), setRowOp({ id: s.id, kind: "confirmRevoke" }))}>
                <X size={13} aria-hidden /> Revoke
              </button>
            </>
          )
        }
      >
        {(mine?.kind === "confirmRevoke" || mine?.kind === "revoking") && (
          <div className="confirm set-confirm" role="alertdialog" aria-label={`Revoke ${s.state === "unrevoked" ? s.id : title}?`}>
            <span className="confirm-msg">
              Delete every copy of this page from the bucket? Its link stops working for everyone. A copy someone already saved stays with them.
            </span>
            <div className="confirm-actions">
              <button className="btn" disabled={mine.kind === "revoking"} onClick={() => setRowOp(undefined)}>
                Cancel
              </button>
              <button className="btn danger" disabled={mine.kind === "revoking"} onClick={() => void revoke(s)}>
                {mine.kind === "revoking" && <Spinner />} {mine.kind === "revoking" ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </div>
        )}
        {lineOf(`row:${s.id}`)}
      </SettingRow>
    );
  };

  const listBody = (() => {
    if (!host)
      return (
        <SettingNote role="status">
          {host === null
            ? "Set up a snapshot host above to publish and list snapshots."
            : hostError
              ? "The snapshots show once the snapshot host can be read."
              : "Reading the snapshot host…"}
        </SettingNote>
      );
    const failed = list.error && (
      <SettingNote tone="bad" role="alert">
        <AlertTriangle size={14} />
        <span>Couldn't read the snapshots from the bucket: {list.error}</span>
        <button className="btn" onClick={readList}>
          Try again
        </button>
      </SettingNote>
    );
    if (!list.snapshots)
      return (
        failed || (
          <SettingNote role="status">
            <Spinner /> Reading the bucket…
          </SettingNote>
        )
      );
    return (
      <>
        {failed}
        {list.snapshots.length ? list.snapshots.map(row) : <SettingNote role="status">No snapshots in the bucket.</SettingNote>}
      </>
    );
  })();

  return (
    <>
      {hostSection(hostCard)}
      <SettingsSection
        title="Snapshots"
        intro="Every snapshot in the bucket, from this computer or any other that uses it. Expired ones are deleted as the list loads."
        action={
          host && (
            <button className="btn" disabled={list.loading} onClick={readList}>
              <RefreshCw size={14} aria-hidden /> Refresh
            </button>
          )
        }
      >
        {listBody}
      </SettingsSection>
    </>
  );
}
