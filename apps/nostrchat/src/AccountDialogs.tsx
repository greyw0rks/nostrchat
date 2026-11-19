import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle,
  Copy,
  DownloadSimple,
  Globe,
  Key,
  LockKey,
  Plus,
  ShieldCheck,
  SignOut,
  Trash,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { nip19 } from "nostr-tools";
import {
  CONNECT_INSTALL_URL,
  nostrProviderStatus,
  watchNostrProviders,
} from "../../../packages/academy/src/signers";
import {
  createAvailableIdentity,
  createEncryptedBackup,
  createPracticeIdentity,
  destroyIdentity,
  normalizePublicKey,
  publicKeyLabel,
  unlockEncryptedBackup,
  validateRelayUrl,
  type AsyncGuard,
  type Identity,
} from "./protocol";
import { readLockedAccount, saveLockedAccount, type Contact } from "./storage";
import {
  Avatar,
  Modal,
  PrivacyNote,
  Spinner,
  errorMessage,
  isCancelled,
} from "./ui";

export function downloadFile(
  value: string,
  filename: string,
  type = "text/plain",
) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function IdentityDialog({
  onClose,
  onIdentity,
  isCurrent,
  initial = "connect",
}: {
  onClose(): void;
  onIdentity(identity: Identity): void;
  isCurrent(): boolean;
  initial?: "connect" | "create";
}) {
  const [locked] = useState(readLockedAccount);
  const [tab, setTab] = useState<"connect" | "create" | "unlock" | "restore">(
    initial === "create" ? "create" : locked ? "unlock" : "connect",
  );
  const [providers, setProviders] = useState(nostrProviderStatus);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [encrypted, setEncrypted] = useState("");
  const [backup, setBackup] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef(new AbortController());
  const created = useRef<Identity | null>(null);
  const accepted = useRef(false);
  const current = useRef(isCurrent);
  current.current = isCurrent;
  const guard = (): AsyncGuard => ({
    signal: controller.current.signal,
    isCurrent: () => current.current() && !controller.current.signal.aborted,
  });
  useEffect(
    () => watchNostrProviders(() => setProviders(nostrProviderStatus())),
    [],
  );
  useEffect(() => {
    controller.current = new AbortController();
    return () => {
      controller.current.abort();
      if (!accepted.current) destroyIdentity(created.current);
    };
  }, []);

  function move(next: typeof tab) {
    setTab(next);
    setError("");
    setPassword("");
    setConfirm("");
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const identity = await createAvailableIdentity(guard());
      if (!current.current() || controller.current.signal.aborted) return;
      onIdentity(identity);
      onClose();
    } catch (err) {
      if (!isCancelled(err) && !controller.current.signal.aborted)
        setError(errorMessage(err));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (tab === "create") {
        if (password.length < 10 || password !== confirm)
          throw new Error(
            "Use at least 10 characters and enter the same passphrase twice.",
          );
        const identity = createPracticeIdentity(name);
        destroyIdentity(created.current);
        created.current = identity;
        const ciphertext = await createEncryptedBackup(
          identity,
          password,
          guard(),
        );
        if (!current.current() || controller.current.signal.aborted) {
          destroyIdentity(identity);
          return;
        }
        saveLockedAccount({
          pubkey: identity.pubkey,
          name: identity.name,
          encryptedKey: ciphertext,
        });
        setBackup(ciphertext);
        setPassword("");
        setConfirm("");
      } else {
        const identity = await unlockEncryptedBackup(
          tab === "unlock" ? locked!.encryptedKey : encrypted.trim(),
          password,
          tab === "unlock" ? locked!.pubkey : undefined,
          tab === "unlock" ? locked!.name : name || "Restored account",
          guard(),
        );
        if (!current.current() || controller.current.signal.aborted) {
          destroyIdentity(identity);
          return;
        }
        if (tab === "restore")
          saveLockedAccount({
            pubkey: identity.pubkey,
            name: identity.name,
            encryptedKey: encrypted.trim(),
          });
        onIdentity(identity);
        onClose();
      }
    } catch (err) {
      if (!isCancelled(err) && !controller.current.signal.aborted) {
        destroyIdentity(created.current);
        created.current = null;
        setError(errorMessage(err));
      }
    } finally {
      if (!controller.current.signal.aborted) {
        setBusy(false);
        if (tab !== "create") setPassword("");
      }
    }
  }
  async function loadKey(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 10_000)
        throw new Error("Choose a small .ncryptsec encrypted key file.");
      const value = (await file.text()).trim();
      if (!controller.current.signal.aborted) {
        setEncrypted(value);
        setError("");
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function copyBackup() {
    try {
      await navigator.clipboard.writeText(backup);
      if (!controller.current.signal.aborted) setError("");
    } catch {
      setError(
        "Clipboard access is unavailable. Download the backup or select the encrypted key to copy it.",
      );
    }
  }
  function continueWithKey() {
    const identity = created.current;
    if (
      !identity ||
      !saved ||
      !current.current() ||
      controller.current.signal.aborted
    )
      return;
    accepted.current = true;
    onIdentity(identity);
    onClose();
  }

  return (
    <Modal
      title={backup ? "A key worth keeping." : "Your identity. Your inbox."}
      onClose={onClose}
      eyebrow="WELCOME TO NOSTRCHAT"
    >
      {backup ? (
        <>
          <p className="dialog-intro">
            Your new Nostr key is ready. Save this encrypted backup and keep its
            passphrase somewhere you can find it.
          </p>
          <div className="account-preview">
            <Avatar name={created.current!.name} color={2} />
            <div>
              <strong>{created.current!.name}</strong>
              <span>{publicKeyLabel(created.current!.pubkey)}</span>
            </div>
            <ShieldCheck size={23} />
          </div>
          <div className="form-stack">
            <label>
              Encrypted key backup
              <textarea
                readOnly
                value={backup}
                rows={3}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  downloadFile(backup, "nostrchat-identity.ncryptsec")
                }
              >
                <DownloadSimple size={19} /> Download backup
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => void copyBackup()}
              >
                <Copy size={19} /> Copy
              </button>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I have saved my encrypted backup and its passphrase.
            </label>
          </div>
          <PrivacyNote>
            Your unencrypted key stays in this tab. The encrypted backup lets
            you unlock the same inbox after a refresh or on another device.
          </PrivacyNote>
          {error && (
            <div className="form-error" role="alert">
              <WarningCircle size={18} />
              {error}
            </div>
          )}
          <button
            className="button button-primary button-full"
            onClick={continueWithKey}
            disabled={!saved}
          >
            Open my inbox <ArrowRight size={19} />
          </button>
        </>
      ) : (
        <>
          <p className="dialog-intro">
            Connect your Nostr signer, or make a local key with an encrypted
            backup. Your public key is how people find you.
          </p>
          <div className="segmented identity-tabs" aria-label="Identity method">
            <button
              type="button"
              className={tab === "connect" ? "selected" : ""}
              aria-pressed={tab === "connect"}
              onClick={() => move("connect")}
              disabled={busy}
            >
              Connect
            </button>
            <button
              type="button"
              className={tab === "create" ? "selected" : ""}
              aria-pressed={tab === "create"}
              onClick={() => move("create")}
              disabled={busy}
            >
              New key
            </button>
            {locked && (
              <button
                type="button"
                className={tab === "unlock" ? "selected" : ""}
                aria-pressed={tab === "unlock"}
                onClick={() => move("unlock")}
                disabled={busy}
              >
                Unlock
              </button>
            )}
            <button
              type="button"
              className={tab === "restore" ? "selected" : ""}
              aria-pressed={tab === "restore"}
              onClick={() => move("restore")}
              disabled={busy}
            >
              Restore
            </button>
          </div>
          {tab === "connect" ? (
            <div className="connect-identity">
              <span className="large-feature-icon">
                <Key size={31} />
              </span>
              <h3>Bring your identity along.</h3>
              <p>
                Connect is preferred when available. A compatible NIP-07 signer
                also works with private messages.
              </p>
              <div className="provider-status">
                <span
                  className={`status-dot ${providers.connect || providers.nip07 ? "online" : ""}`}
                />
                {providers.connect
                  ? "Connect detected"
                  : providers.nip07
                    ? "Nostr signer detected"
                    : "Looking for a Nostr signer"}
                <small>Private-message support is checked on connection.</small>
              </div>
              <button
                type="button"
                className="button button-primary button-full"
                onClick={() => void connect()}
                disabled={busy}
              >
                {busy ? <Spinner /> : <Key size={19} />}
                {busy
                  ? "Connecting your identity…"
                  : providers.connect
                    ? "Connect with Connect"
                    : "Connect Nostr signer"}
                {!busy && <ArrowRight size={18} />}
              </button>
              <a
                className="button button-quiet button-full"
                href={CONNECT_INSTALL_URL}
                target="_blank"
                rel="noreferrer"
              >
                Get or enable Connect <ArrowUpRight size={17} />
              </a>
              <PrivacyNote>
                Your signer keeps your private key. Enable this website in your
                wallet or extension; NIP-44 encryption is required.
              </PrivacyNote>
            </div>
          ) : (
            <form
              className="form-stack"
              onSubmit={(event) => void submit(event)}
            >
              {tab !== "unlock" && (
                <label>
                  Your display name
                  <input
                    data-autofocus
                    autoComplete="nickname"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="What should we call you?"
                    maxLength={40}
                    required={tab === "create"}
                    disabled={busy}
                  />
                  <small>This name stays private to this browser.</small>
                </label>
              )}
              {tab === "unlock" && (
                <div className="account-preview">
                  <Avatar name={locked!.name} color={2} />
                  <div>
                    <strong>{locked!.name}</strong>
                    <span>{publicKeyLabel(locked!.pubkey)}</span>
                  </div>
                  <LockKey size={21} />
                </div>
              )}
              {tab === "restore" && (
                <>
                  <label>
                    Encrypted key
                    <textarea
                      value={encrypted}
                      onChange={(event) => setEncrypted(event.target.value)}
                      placeholder="ncryptsec1…"
                      rows={3}
                      maxLength={400}
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={busy}
                    />
                  </label>
                  <label className="file-button">
                    <UploadSimple size={17} />
                    Choose an encrypted key file
                    <input
                      type="file"
                      accept=".ncryptsec,text/plain"
                      onChange={(event) => {
                        void loadKey(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                      disabled={busy}
                    />
                  </label>
                </>
              )}
              <label>
                {tab === "create"
                  ? "Choose a backup passphrase"
                  : "Your backup passphrase"}
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={tab === "create" ? 10 : undefined}
                  autoComplete={
                    tab === "create" ? "new-password" : "current-password"
                  }
                  placeholder={
                    tab === "create"
                      ? "At least 10 characters"
                      : "Unlock your encrypted key"
                  }
                  required
                  disabled={busy}
                  data-autofocus={tab === "unlock" ? true : undefined}
                />
              </label>
              {tab === "create" && (
                <label>
                  Confirm your passphrase
                  <input
                    type="password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    minLength={10}
                    autoComplete="new-password"
                    required
                    disabled={busy}
                  />
                </label>
              )}
              <PrivacyNote>
                {tab === "create"
                  ? "A real Nostr identity is created on this device. You will save an encrypted backup before opening your inbox."
                  : "Only the encrypted key is saved here. Your passphrase and unencrypted key stay in memory."}
              </PrivacyNote>
              <button
                className="button button-primary button-full"
                disabled={busy}
              >
                {busy ? <Spinner /> : <Key size={18} />}
                {busy
                  ? tab === "create"
                    ? "Encrypting your backup…"
                    : "Unlocking your identity…"
                  : tab === "create"
                    ? "Create my key & backup"
                    : "Unlock my inbox"}
              </button>
            </form>
          )}
          {error && (
            <div className="form-error" role="alert">
              <WarningCircle size={18} />
              <span>{error}</span>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function ContactDialog({
  identity,
  contact,
  onClose,
  onSave,
  onRemove,
  onCopy,
}: {
  identity: Identity;
  contact?: Contact;
  onClose(): void;
  onSave(value: Contact): void;
  onRemove?(pubkey: string): void;
  onCopy(value: string): Promise<void>;
}) {
  const [name, setName] = useState(contact?.name || "");
  const [key, setKey] = useState(
    contact ? nip19.npubEncode(contact.pubkey) : "",
  );
  const [note, setNote] = useState(contact?.note || "");
  const [color, setColor] = useState(contact?.color || 0);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const pubkey = normalizePublicKey(key);
      if (pubkey === identity.pubkey)
        throw new Error(
          "That is your public key. Add the person you want to message.",
        );
      onSave({
        pubkey,
        name: name.trim() || publicKeyLabel(pubkey),
        color,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <Modal
      title={
        removing
          ? "Remove this contact?"
          : contact
            ? "A familiar face."
            : "Who’s on your mind?"
      }
      onClose={onClose}
      eyebrow={contact ? "CONTACT DETAILS" : "NEW CONVERSATION"}
    >
      {removing ? (
        <>
          <p className="dialog-intro">
            Remove {contact!.name} from your saved people. Their encrypted
            messages remain in your history and may bring the conversation back
            when you reconnect.
          </p>
          <div className="button-row">
            <button
              className="button button-danger"
              onClick={() => {
                onRemove?.(contact!.pubkey);
                onClose();
              }}
            >
              <Trash size={19} /> Remove contact
            </button>
            <button
              className="button button-secondary"
              onClick={() => setRemoving(false)}
            >
              Keep contact
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="dialog-intro">
            {contact
              ? "Names, notes, and colors are personal to this browser."
              : "Start with their Nostr public key. Your contact name stays private to this browser."}
          </p>
          <form className="form-stack" onSubmit={submit}>
            <div className="contact-avatar-editor">
              <Avatar name={name || "N"} color={color} size="large" />
              <div>
                <span className="field-caption">Contact color</span>
                <div className="color-options">
                  {[0, 1, 2, 3, 4].map((value) => (
                    <button
                      type="button"
                      className={`color-option avatar--${value}`}
                      key={value}
                      aria-label={`Contact color ${value + 1}`}
                      aria-pressed={color === value}
                      onClick={() => setColor(value)}
                    >
                      {color === value && <Check size={17} weight="bold" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <label>
              Contact name
              <input
                data-autofocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Kemi, design partner"
                autoComplete="off"
                maxLength={40}
              />
            </label>
            <label>
              Nostr public key
              <textarea
                aria-label="Nostr public key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="npub1…"
                rows={3}
                maxLength={200}
                readOnly={Boolean(contact)}
                spellCheck={false}
                autoComplete="off"
                required
              />
            </label>
            {contact && (
              <button
                type="button"
                className="button button-quiet"
                onClick={() => void onCopy(key)}
              >
                <Copy size={18} /> Copy public key
              </button>
            )}
            <label>
              Private note <span className="optional">optional</span>
              <textarea
                aria-label="Private note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={240}
                placeholder="How you know them, or something to remember"
              />
            </label>
            <PrivacyNote>
              Use a public npub key here. Messages are encrypted for this key
              before they reach your relay.
            </PrivacyNote>
            {error && (
              <div className="form-error" role="alert">
                <WarningCircle size={18} />
                {error}
              </div>
            )}
            <button className="button button-primary button-full">
              <Plus size={18} />
              {contact ? "Save contact" : "Open conversation"}
            </button>
          </form>
          {contact && onRemove && (
            <button
              className="button button-danger-quiet button-full"
              onClick={() => setRemoving(true)}
            >
              <Trash size={17} /> Remove contact
            </button>
          )}
        </>
      )}
    </Modal>
  );
}

export function SettingsDialog({
  identity,
  relayUrl,
  relayState,
  syncState,
  onClose,
  onRelay,
  onProfile,
  onLogout,
  onNotice,
  onCopy,
  onExportHistory,
  onExportContacts,
  onImport,
  isCurrent,
  onHelp,
}: {
  identity: Identity | null;
  relayUrl: string;
  relayState: string;
  syncState: string;
  onClose(): void;
  onRelay(url: string): void;
  onProfile(name: string): void;
  onLogout(clear?: boolean): void;
  onNotice(value: string): void;
  onCopy(value: string): Promise<void>;
  onExportHistory(): void;
  onExportContacts(): void;
  onImport(input: unknown): Promise<string>;
  isCurrent(): boolean;
  onHelp(): void;
}) {
  const [tab, setTab] = useState<"general" | "identity" | "data">("general");
  const [url, setUrl] = useState(relayUrl);
  const [external, setExternal] = useState(!isLocalRelay(relayUrl));
  const [name, setName] = useState(identity?.name || "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [clearWord, setClearWord] = useState("");
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef(new AbortController());
  const current = useRef(isCurrent);
  current.current = isCurrent;
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  function saveRelay(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const value = validateRelayUrl(url, external);
      onRelay(value);
      onNotice("Relay saved. Reconnecting your encrypted inbox.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function backup(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!identity?.secret) return;
    if (password.length < 10 || password !== confirm) {
      setError(
        "Use at least 10 characters and enter the same passphrase twice.",
      );
      return;
    }
    setBusy(true);
    try {
      const value = await createEncryptedBackup(identity, password, {
        signal: controller.current.signal,
        isCurrent: () => current.current(),
        expectedPubkey: identity.pubkey,
      });
      if (!current.current() || controller.current.signal.aborted) return;
      saveLockedAccount({
        pubkey: identity.pubkey,
        name: identity.name,
        encryptedKey: value,
      });
      downloadFile(value, "nostrchat-identity.ncryptsec");
      setPassword("");
      setConfirm("");
      onNotice(
        "Encrypted key backup downloaded. Keep its passphrase separately.",
      );
    } catch (err) {
      if (!isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function importFile(file: File | undefined) {
    if (!file || !identity) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 8_000_000)
        throw new Error("Choose a NostrChat export smaller than 8 MB.");
      const input: unknown = JSON.parse(await file.text());
      if (!current.current() || controller.current.signal.aborted) return;
      const message = await onImport(input);
      if (current.current() && !controller.current.signal.aborted)
        onNotice(message);
    } catch (err) {
      if (!isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <Modal
      title={clearing ? "Clear this device’s inbox?" : "Make this space yours."}
      onClose={onClose}
      wide
      eyebrow="SETTINGS & PRIVACY"
    >
      {clearing ? (
        <>
          <p className="dialog-intro">
            Your saved contacts, encrypted envelopes, encrypted recovery data,
            and local key backup for this account will be removed from this
            browser. Export what you need first.
          </p>
          <PrivacyNote>
            Encrypted events already on your relay remain available to your
            identity. Clearing this browser cannot delete a peer’s copy.
          </PrivacyNote>
          <div className="form-stack">
            <label>
              Type CLEAR to continue
              <input
                data-autofocus
                value={clearWord}
                onChange={(event) => setClearWord(event.target.value)}
                autoComplete="off"
                placeholder="CLEAR"
              />
            </label>
            <div className="button-row">
              <button
                className="button button-danger"
                disabled={clearWord !== "CLEAR"}
                onClick={() => onLogout(true)}
              >
                <Trash size={18} /> Clear & lock identity
              </button>
              <button
                className="button button-secondary"
                onClick={() => {
                  setClearing(false);
                  setClearWord("");
                }}
              >
                Keep my data
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div
            className="segmented settings-tabs"
            aria-label="Settings section"
          >
            {(["general", "identity", "data"] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={tab === value ? "selected" : ""}
                aria-pressed={tab === value}
                onClick={() => {
                  setTab(value);
                  setError("");
                }}
              >
                {value === "general"
                  ? "Connection"
                  : value === "identity"
                    ? "Identity"
                    : "Your data"}
              </button>
            ))}
          </div>
          {tab === "general" && (
            <div className="settings-section">
              <div className="section-heading">
                <span className="small-feature-icon">
                  <Globe size={22} />
                </span>
                <div>
                  <h3>A relay that works for you.</h3>
                  <p>
                    Your relay stores encrypted message envelopes. Your contact
                    needs to use the same relay to receive them.
                  </p>
                </div>
              </div>
              <form className="form-stack" onSubmit={saveRelay}>
                <label>
                  Relay URL
                  <input
                    data-autofocus
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="wss://your-relay.example"
                    spellCheck={false}
                    autoComplete="url"
                    required
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={external}
                    onChange={(event) => setExternal(event.target.checked)}
                  />
                  Connect to this external relay
                </label>
                <button className="button button-primary">
                  <Globe size={18} /> Save relay
                </button>
              </form>
              <div className="settings-facts">
                <div>
                  <span>Relay connection</span>
                  <strong>
                    {relayState === "connected"
                      ? "Connected"
                      : relayState === "connecting"
                        ? "Connecting"
                        : "Offline"}
                  </strong>
                </div>
                <div>
                  <span>Encrypted account sync</span>
                  <strong>{syncState}</strong>
                </div>
                <div>
                  <span>Private messages</span>
                  <strong>NIP-44 · NIP-17 · NIP-59</strong>
                </div>
              </div>
              <PrivacyNote>
                External relays use wss://. A relay can see encrypted envelopes,
                recipient keys, and connection metadata; message text stays
                private.
              </PrivacyNote>
              <button className="button button-quiet" onClick={onHelp}>
                How privacy and payments work <ArrowUpRight size={17} />
              </button>
            </div>
          )}
          {tab === "identity" && (
            <div className="settings-section">
              {identity ? (
                <>
                  <div className="account-preview">
                    <Avatar name={identity.name} color={2} />
                    <div>
                      <strong>{identity.name}</strong>
                      <span>
                        {identity.secret
                          ? "Local key · encrypted backup"
                          : "Connected Nostr signer"}
                      </span>
                    </div>
                    <ShieldCheck size={24} />
                  </div>
                  <form
                    className="form-stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      try {
                        if (name.trim()) {
                          onProfile(name.trim());
                          onNotice("Your private display name was updated.");
                        }
                      } catch (err) {
                        setError(errorMessage(err));
                      }
                    }}
                  >
                    <label>
                      Your private display name
                      <input
                        data-autofocus
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={40}
                        autoComplete="nickname"
                        required
                      />
                      <small>This name is personal to this browser.</small>
                    </label>
                    <button className="button button-secondary">
                      Save display name
                    </button>
                  </form>
                  <div className="public-key-box">
                    <span className="field-caption">YOUR PUBLIC KEY</span>
                    <textarea
                      readOnly
                      rows={3}
                      value={nip19.npubEncode(identity.pubkey)}
                      spellCheck={false}
                      aria-label="Your public Nostr key"
                    />
                    <button
                      className="button button-quiet"
                      onClick={() =>
                        void onCopy(nip19.npubEncode(identity.pubkey))
                      }
                    >
                      <Copy size={18} /> Copy public key
                    </button>
                  </div>
                  {identity.secret && (
                    <form
                      className="form-stack backup-form"
                      onSubmit={(event) => void backup(event)}
                    >
                      <h3>
                        <ShieldCheck size={20} /> Encrypted key backup
                      </h3>
                      <p className="muted">
                        Download a fresh backup for this identity. Changing this
                        passphrase protects this backup file.
                      </p>
                      <label>
                        New backup passphrase
                        <input
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          minLength={10}
                          autoComplete="new-password"
                          required
                          disabled={busy}
                        />
                      </label>
                      <label>
                        Confirm passphrase
                        <input
                          type="password"
                          value={confirm}
                          onChange={(event) => setConfirm(event.target.value)}
                          minLength={10}
                          autoComplete="new-password"
                          required
                          disabled={busy}
                        />
                      </label>
                      <button
                        className="button button-secondary"
                        disabled={busy}
                      >
                        {busy ? <Spinner /> : <DownloadSimple size={18} />}{" "}
                        Download encrypted backup
                      </button>
                    </form>
                  )}
                  <button
                    className="button button-quiet button-full signout-button"
                    onClick={() => onLogout()}
                    disabled={busy}
                  >
                    <SignOut size={18} />
                    {identity.secret
                      ? "Lock this identity"
                      : "Sign out of NostrChat"}
                  </button>
                </>
              ) : (
                <PrivacyNote>
                  Connect your identity to see your public key and account
                  controls.
                </PrivacyNote>
              )}
            </div>
          )}
          {tab === "data" && (
            <div className="settings-section">
              <div className="section-heading">
                <span className="small-feature-icon">
                  <LockKey size={22} />
                </span>
                <div>
                  <h3>Keep a copy. Stay in control.</h3>
                  <p>
                    Messages are stored as encrypted envelopes. Names and notes
                    stay private to your browser and any encrypted account
                    backup.
                  </p>
                </div>
              </div>
              <div className="data-actions">
                <div>
                  <strong>Encrypted message history</strong>
                  <p>
                    Export verified envelopes for this identity. Restore them
                    while the same identity is unlocked.
                  </p>
                  <button
                    className="button button-secondary"
                    onClick={onExportHistory}
                    disabled={!identity || busy}
                  >
                    <DownloadSimple size={18} /> Export encrypted history
                  </button>
                </div>
                <div>
                  <strong>Personal contacts</strong>
                  <p>
                    This file contains contact names, notes, and public keys.
                    Choose where you keep it.
                  </p>
                  <button
                    className="button button-secondary"
                    onClick={onExportContacts}
                    disabled={!identity || busy}
                  >
                    <DownloadSimple size={18} /> Export contacts
                  </button>
                </div>
              </div>
              <label
                className={`file-button file-button--large ${!identity || busy ? "is-disabled" : ""}`}
              >
                <UploadSimple size={20} />
                {busy ? "Importing your data…" : "Import history or contacts"}
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={!identity || busy}
                  onChange={(event) => {
                    void importFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              <div className="danger-zone">
                <div>
                  <h3>Clear this device</h3>
                  <p>
                    Remove this account’s saved chat data and lock the identity.
                  </p>
                </div>
                <button
                  className="button button-danger-quiet"
                  onClick={() => setClearing(true)}
                  disabled={!identity || busy}
                >
                  <Trash size={18} /> Clear device data
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              <WarningCircle size={19} />
              {error}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function HelpDialog({ onClose }: { onClose(): void }) {
  return (
    <Modal
      title="A little context goes a long way."
      onClose={onClose}
      wide
      eyebrow="HOW NOSTRCHAT WORKS"
    >
      <p className="dialog-intro">
        One identity, a shared relay, and a private place for conversations and
        their payments.
      </p>
      <div className="help-grid">
        <article>
          <span className="small-feature-icon">
            <Key size={23} />
          </span>
          <h3>1. Bring your identity</h3>
          <p>
            Use Connect or a NIP-07 signer with NIP-44. A local key works too:
            save the encrypted backup and use it to reopen the same inbox.
          </p>
          <a href={CONNECT_INSTALL_URL} target="_blank" rel="noreferrer">
            Enable Connect <ArrowUpRight size={15} />
          </a>
        </article>
        <article>
          <span className="small-feature-icon">
            <LockKey size={23} />
          </span>
          <h3>2. Exchange public keys</h3>
          <p>
            Add a contact’s npub key. Both of you use the same relay. Messages
            are encrypted before publication; the relay sees envelope and
            connection metadata.
          </p>
        </article>
        <article>
          <span className="small-feature-icon coral">
            <ShieldCheck size={23} />
          </span>
          <h3>3. Know what a check means</h3>
          <p>
            “Published” means the relay accepted the encrypted envelope.
            NostrChat does not report whether your contact is online or has read
            a message.
          </p>
        </article>
        <article>
          <span className="small-feature-icon coral">
            <CheckCircle size={23} />
          </span>
          <h3>4. Pay with your say-so</h3>
          <p>
            Connect an NWC wallet, share a fixed Lightning invoice, and review
            before paying. Only a wallet-verified result or matching payment
            preimage marks it paid.
          </p>
        </article>
      </div>
      <div className="help-note">
        <h3>If a payment is interrupted</h3>
        <p>
          Open the invoice or Activity and check your connected wallet.
          NostrChat keeps encrypted recovery details so a missing response can
          be reconciled before another payment attempt.
        </p>
      </div>
      <PrivacyNote>
        This release supports one-to-one text, invoices, encrypted history, and
        local contacts. Use your wallet provider to manage connection
        permissions or revoke its token.
      </PrivacyNote>
    </Modal>
  );
}

export function isLocalRelay(url: string) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
