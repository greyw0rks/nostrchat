import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AddressBook,
  ArrowClockwise,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  ChatsCircle,
  GearSix,
  Info,
  Key,
  Lightning,
  LockKey,
  Plus,
  ShieldCheck,
  Wallet,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import { nip19, type NostrEvent } from "nostr-tools";
import {
  ApiError,
  api,
  assertCurrent,
  authenticateWallet,
  createGiftWraps,
  destroyIdentity,
  inspectInvoice,
  invoiceScopeKey,
  matchingReceiptInvoices,
  mergeMessage,
  parsePayload,
  paymentProofMatches,
  publicKeyLabel,
  unwrapGift,
  validateRelayUrl,
  type AsyncGuard,
  type ChatMessage,
  type ChatPayload,
  type Identity,
  type InvoicePayload,
} from "./protocol";
import { ChatRelay, type RelayState } from "./relay";
import {
  clearLocalAccount,
  exportEncryptedHistory,
  importEncryptedHistory,
  readContacts,
  readEncryptedEvents,
  readPaymentRecovery,
  saveContacts,
  saveEncryptedEvent,
  savePaymentRecovery,
  type Contact,
  type PaymentRecoveryRecord,
} from "./storage";
import {
  ContactDialog,
  HelpDialog,
  IdentityDialog,
  SettingsDialog,
  downloadFile,
  isLocalRelay,
} from "./AccountDialogs";
import {
  clearPrivateDeviceData,
  decodePrivateAccount,
  decodeRetryBundle,
  encodePrivateAccount,
  encodeRetryBundle,
  readLocalOutbox,
  readPrivateName,
  removeLocalOutbox,
  saveLocalOutbox,
  savePrivateName,
  validateContacts,
  type OutboxItem,
  type RetryBundle,
} from "./accountData";
import {
  Activity,
  EmptyThread,
  Inbox,
  Landing,
  People,
  Thread,
} from "./ChatViews";
import { WalletPanel } from "./WalletPanel";
import {
  Avatar,
  Brand,
  IconButton,
  Modal,
  PrivacyNote,
  Spinner,
  errorMessage,
  isCancelled,
  numberFormat as nf,
} from "./ui";
import type {
  AccountRequest,
  InvoiceStatus,
  PaymentReview,
  VerifiedInvoice,
  WalletState,
} from "./uiTypes";

type Pane = "messages" | "people" | "activity";
type Overlay = "identity" | "contact" | "settings" | "help" | null;
type ChatConfig = {
  backend: "convex" | "local";
  relayUrl: string | null;
  publicRelay: boolean;
  messageLimit: number;
  lightningLabReady?: boolean;
};
type AccountResponse = {
  pubkey: string;
  ciphertext: string | null;
  revision: number;
  updatedAt: number | null;
};
type HistoryResponse = {
  events: NostrEvent[];
  cursor: string | null;
  hasMore: boolean;
};
type OutboxResponse = {
  items: OutboxItem[];
  cursor: string | null;
  hasMore: boolean;
};
type PaymentPreview = {
  reviewId: string;
  paymentHash: string;
  amountSats: number;
  network: string;
  expiresAt: number;
  reviewExpiresAt: number;
  wallet: { kind: string; network: string; alias?: string };
  walletReference: string;
};
type PaymentResult = {
  paymentHash: string;
  state: "settled" | "unknown" | "not_found";
  preimage?: string;
  amountSats?: number;
  settledAt?: number;
  message?: string;
};
type SyncState =
  "connecting" | "connected" | "saving" | "synced" | "offline" | "conflict";

const syncLabels: Record<SyncState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  saving: "Encrypting & saving",
  synced: "Encrypted backup current",
  offline: "Unavailable · stored locally",
  conflict: "Needs a refresh",
};
const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(
  window.location.hostname,
);
const defaultRelay = localHost
  ? "ws://" + window.location.hostname + ":4400/relay"
  : "";
const networkLabel = (value: string) =>
  value === "bitcoin" || value === "mainnet"
    ? "Bitcoin mainnet"
    : value === "regtest"
      ? "Bitcoin regtest"
      : value === "testnet"
        ? "Bitcoin testnet"
        : value;
const conversationPeer = (owner: string, message: ChatMessage) =>
  message.sender === owner ? message.recipient : message.sender;
const reviewIdentity = (value: PaymentReview) =>
  value.owner +
  ":" +
  (value.peer || "wallet") +
  ":" +
  (value.invoiceId || value.invoice.paymentHash);

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("messages");
  const [query, setQuery] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [inboxFilter, setInboxFilter] = useState<"all" | "invoices">("all");
  const [activityFilter, setActivityFilter] = useState<
    "all" | "pending" | "settled"
  >("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [identityEntry, setIdentityEntry] = useState<"connect" | "create">(
    "connect",
  );
  const [editingContact, setEditingContact] = useState<Contact | undefined>(
    undefined,
  );
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletTab, setWalletTab] = useState<"receive" | "send">("receive");
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [generatedInvoice, setGeneratedInvoice] =
    useState<VerifiedInvoice | null>(null);
  const [relayUrl, setRelayUrl] = useState(defaultRelay);
  const [relayState, setRelayState] = useState<RelayState>("connecting");
  const [relayRefresh, setRelayRefresh] = useState(0);
  const [config, setConfig] = useState<ChatConfig | null>(null);
  const [openingAccount, setOpeningAccount] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("connecting");
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [syncRefresh, setSyncRefresh] = useState(0);
  const [sendingPeer, setSendingPeer] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [chatError, setChatError] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [invoiceStatuses, setInvoiceStatuses] = useState<
    Record<string, InvoiceStatus>
  >({});
  const [checkingScope, setCheckingScope] = useState("");
  const [receiptStates, setReceiptStates] = useState<
    Record<string, "verified" | "unverified">
  >({});
  const [recovery, setRecovery] = useState<PaymentRecoveryRecord[]>([]);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [payment, setPayment] = useState<PaymentReview | null>(null);
  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(
    null,
  );
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [clockTick, setClockTick] = useState(Date.now());
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const active = useRef<Identity | null>(null);
  const accountEpoch = useRef(0);
  const accountController = useRef(new AbortController());
  const relayEpoch = useRef(0);
  const relay = useRef<ChatRelay | null>(null);
  const contactsRef = useRef(contacts);
  contactsRef.current = contacts;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const profileRevision = useRef(0);
  const profileGeneration = useRef(0);
  const profileWrites = useRef(Promise.resolve());
  const archiveQueue = useRef(Promise.resolve());
  const archiving = useRef(new Set<string>());
  const profileEdits = useRef(0);
  const relayChoice = useRef(0);
  const relayUrlRef = useRef(relayUrl);
  relayUrlRef.current = relayUrl;
  const retryBundles = useRef(
    new Map<string, { bundle: RetryBundle; ciphertext: string }>(),
  );
  const processed = useRef(new Set<string>());
  const decodeQueue = useRef(Promise.resolve());
  const queuedCount = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const paymentRef = useRef(payment);
  paymentRef.current = payment;
  const renderEpoch = accountEpoch.current;
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const closeWallet = useCallback(() => setWalletOpen(false), []);
  const notify = useCallback((value: string) => {
    setNotice(value);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 6000);
  }, []);

  function guardFor(
    account: Identity,
    epoch: number,
    signal?: AbortSignal,
  ): AsyncGuard {
    const accountSignal = accountController.current.signal;
    const combined =
      signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([accountSignal, signal])
        : signal || accountSignal;
    return {
      expectedPubkey: account.pubkey,
      signal: combined,
      isCurrent: () =>
        accountEpoch.current === epoch &&
        active.current?.pubkey === account.pubkey &&
        !accountSignal.aborted,
    };
  }
  const request: AccountRequest = useCallback(
    async <T,>(
      path: string,
      body?: unknown,
      method?: string,
      signal?: AbortSignal,
    ): Promise<T> => {
      if (!identity) throw new Error("Connect your Nostr identity first.");
      const account = identity,
        epoch = renderEpoch,
        guard = guardFor(account, epoch, signal);
      assertCurrent(guard, account.pubkey);
      await authenticateWallet(account, guard);
      assertCurrent(guard, account.pubkey);
      return api<T>(path, body, method, guard);
    },
    [identity?.pubkey, renderEpoch],
  );

  const contact = selected
    ? contacts.find((value) => value.pubkey === selected) || {
        pubkey: selected,
        name: publicKeyLabel(selected),
        color: parseInt(selected.slice(0, 2), 16) % 5,
      }
    : undefined;
  const conversation = useMemo(
    () =>
      identity && selected
        ? messages.filter(
            (message) =>
              (message.sender === identity.pubkey &&
                message.recipient === selected) ||
              (message.sender === selected &&
                message.recipient === identity.pubkey),
          )
        : [],
    [identity?.pubkey, selected, messages],
  );
  const attempts = useMemo(() => {
    const result = new Set<string>();
    if (!identity) return result;
    for (const record of recovery) {
      if (record.standalone) continue;
      const original = messages.find(
        (message) =>
          message.id === record.invoiceId &&
          message.payload.type === "invoice" &&
          message.sender === record.peer &&
          message.recipient === identity.pubkey &&
          JSON.stringify(message.payload) === JSON.stringify(record.invoice),
      );
      if (original)
        result.add(invoiceScopeKey(identity.pubkey, record.peer, original));
    }
    return result;
  }, [identity?.pubkey, messages, recovery]);
  const overlayOpen = Boolean(overlay || walletOpen || payment);

  function updateContacts(
    update: Contact[] | ((current: Contact[]) => Contact[]),
  ) {
    setContacts((current) => {
      const next = typeof update === "function" ? update(current) : update;
      contactsRef.current = next;
      return next;
    });
  }
  function setSelectedRelay(url: string, explicit = true) {
    if (explicit) relayChoice.current++;
    relayEpoch.current++;
    relay.current?.close();
    relay.current = null;
    setRelayState("connecting");
    relayUrlRef.current = url;
    setRelayUrl(url);
    setRelayRefresh((value) => value + 1);
    setMessages((current) =>
      current.map((message) =>
        message.state === "publishing"
          ? {
              ...message,
              state: "failed",
              error: "Relay changed before publication was confirmed.",
            }
          : message,
      ),
    );
  }
  function resetAccountState() {
    setContacts([]);
    contactsRef.current = [];
    setMessages([]);
    messagesRef.current = [];
    setSelected(null);
    setQuery("");
    setPeopleQuery("");
    setPane("messages");
    setDrafts({});
    setWalletOpen(false);
    setWalletState(null);
    setGeneratedInvoice(null);
    setSendingPeer(null);
    setInvoiceStatuses({});
    setCheckingScope("");
    setReceiptStates({});
    setRecovery([]);
    recoveryRef.current = [];
    setRecoveryUnavailable(false);
    setPayment(null);
    setPreview(null);
    setPaymentResult(null);
    setPaymentBusy(false);
    setPaymentLoading(false);
    setPaymentError("");
    setChatError("");
    setGlobalError("");
    setHistoryMore(false);
    setHistoryCursor(null);
    setHistoryBusy(false);
    setAccountLoaded(false);
    setInboxFilter("all");
    setActivityFilter("all");
    retryBundles.current.clear();
    processed.current.clear();
    decodeQueue.current = Promise.resolve();
    queuedCount.current = 0;
    profileRevision.current = 0;
    profileWrites.current = Promise.resolve();
    archiveQueue.current = Promise.resolve();
    archiving.current.clear();
    profileGeneration.current++;
    profileEdits.current = 0;
    clearTimeout(noticeTimer.current);
    setNotice("");
  }
  function activateIdentity(value: Identity) {
    accountEpoch.current++;
    accountController.current.abort();
    accountController.current = new AbortController();
    relayEpoch.current++;
    relay.current?.close();
    relay.current = null;
    destroyIdentity(active.current);
    resetAccountState();
    const name = readPrivateName(value.pubkey) || value.name;
    const account = name === value.name ? value : { ...value, name };
    active.current = account;
    setIdentity(account);
    updateContacts(readContacts(value.pubkey));
    setOpeningAccount(true);
    setHistoryLoading(true);
    setSyncState("connecting");
    setRelayRefresh((current) => current + 1);
    notify("Your identity is ready. Opening your encrypted inbox.");
  }
  function logout(clear = false) {
    const previous = active.current;
    accountEpoch.current++;
    accountController.current.abort();
    accountController.current = new AbortController();
    relayEpoch.current++;
    relay.current?.close();
    relay.current = null;
    destroyIdentity(previous);
    active.current = null;
    if (clear && previous) {
      try {
        clearLocalAccount(previous.pubkey);
        clearPrivateDeviceData(previous.pubkey);
      } catch {
        /* The identity is locked even if browser storage is unavailable. */
      }
    }
    resetAccountState();
    setIdentity(null);
    setOverlay(null);
    setOpeningAccount(false);
    setHistoryLoading(false);
    const epoch = accountEpoch.current,
      signal = accountController.current.signal;
    void api("/api/session/logout", {}, "POST", {
      signal,
      expectedPubkey: previous?.pubkey,
      isCurrent: () =>
        accountEpoch.current === epoch && active.current === null,
    }).catch(() => undefined);
    setRelayRefresh((current) => current + 1);
    notify(
      clear
        ? "This device’s chat data was cleared and the identity was locked."
        : "Your identity is locked. Unlock the same key to return.",
    );
  }
  function openIdentity(initial: "connect" | "create" = "connect") {
    setIdentityEntry(initial);
    setWalletOpen(false);
    setPayment(null);
    setOverlay("identity");
  }
  function newConversation() {
    if (!identity) {
      openIdentity();
      return;
    }
    setEditingContact(undefined);
    setOverlay("contact");
  }
  function openWallet(tab: "receive" | "send" = "receive") {
    if (!identity) {
      openIdentity();
      return;
    }
    setWalletTab(tab);
    setOverlay(null);
    setWalletOpen(true);
  }
  function changePane(value: Pane) {
    if (!identity) {
      openIdentity();
      return;
    }
    setPane(value);
    if (value !== "messages") setSelected(null);
    setQuery("");
    setGlobalError("");
  }
  function showConversation(peer: string) {
    setSelected(peer);
    setPane("messages");
    setQuery("");
    setChatError("");
  }
  function saveContact(value: Contact) {
    if (!active.current) return;
    if (
      contactsRef.current.length >= 200 &&
      !contactsRef.current.some((contact) => contact.pubkey === value.pubkey)
    )
      throw new Error(
        "Your address book is full. Remove a contact before adding another.",
      );
    const checked = validateContacts([value], active.current.pubkey)[0];
    if (!checked) throw new Error("This contact could not be validated.");
    profileEdits.current++;
    updateContacts((current) =>
      current.some((contact) => contact.pubkey === checked.pubkey)
        ? current.map((contact) =>
            contact.pubkey === checked.pubkey ? checked : contact,
          )
        : [...current, checked],
    );
    showConversation(checked.pubkey);
  }
  function removeContact(pubkey: string) {
    profileEdits.current++;
    updateContacts((current) =>
      current.filter((contact) => contact.pubkey !== pubkey),
    );
    if (selected === pubkey) setSelected(null);
    notify("Contact removed from your private address book.");
  }
  function saveProfile(name: string) {
    const account = active.current;
    if (!account) return;
    if (
      !name.trim() ||
      name.length > 40 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      /(?:nsec1|ncryptsec1|nostr\+?walletconnect:\/\/)/i.test(name)
    )
      throw new Error(
        "Use a display name rather than a private key or wallet connection.",
      );
    profileEdits.current++;
    savePrivateName(account.pubkey, name);
    const next = { ...account, name };
    active.current = next;
    setIdentity(next);
  }
  async function copy(value: string) {
    const epoch = accountEpoch.current;
    try {
      await navigator.clipboard.writeText(value);
      if (accountEpoch.current === epoch) notify("Copied to clipboard.");
    } catch {
      if (accountEpoch.current === epoch)
        setGlobalError(
          "Clipboard access is unavailable. Open the contact or identity settings to select and copy the public key.",
        );
    }
  }

  useEffect(() => {
    const controller = new AbortController(),
      choice = relayChoice.current;
    void api<ChatConfig>("/api/chat/config", undefined, "GET", {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setConfig(value);
        if (
          value.relayUrl &&
          relayChoice.current === choice &&
          (!active.current || !relayUrlRef.current)
        )
          setSelectedRelay(
            validateRelayUrl(value.relayUrl, value.publicRelay),
            false,
          );
        else if (!value.relayUrl && !defaultRelay) setRelayState("offline");
      })
      .catch((err) => {
        if (!isCancelled(err) && !defaultRelay) setRelayState("offline");
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const tick = setInterval(() => setClockTick(Date.now()), 15_000);
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        "--viewport-height",
        (viewport?.height || window.innerHeight) + "px",
      );
      setKeyboardOpen(
        Boolean(viewport && window.innerHeight - viewport.height > 120),
      );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      clearInterval(tick);
      viewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
      clearTimeout(noticeTimer.current);
    };
  }, []);
  useEffect(() => {
    if (accountController.current.signal.aborted)
      accountController.current = new AbortController();
    return () => {
      accountController.current.abort();
      relay.current?.close();
      destroyIdentity(active.current);
      active.current = null;
    };
  }, []);
  useEffect(() => {
    if (!identity || active.current?.pubkey !== identity.pubkey) return;
    try {
      saveContacts(identity.pubkey, contacts);
    } catch {
      /* Encrypted cloud sync can remain available when browser storage is full. */
    }
  }, [contacts, identity?.pubkey]);

  function queueEnvelope(
    account: Identity,
    epoch: number,
    event: NostrEvent,
    cache = false,
  ): Promise<void> {
    if (queuedCount.current > 500) return Promise.resolve();
    queuedCount.current++;
    const guard = guardFor(account, epoch);
    const operation = decodeQueue.current
      .catch(() => undefined)
      .then(async () => {
        assertCurrent(guard, account.pubkey);
        if (processed.current.has(event.id)) return;
        try {
          const message = await unwrapGift(account, event, guard);
          assertCurrent(guard, account.pubkey);
          rememberEnvelope(event.id);
          saveEncryptedEvent(account.pubkey, event);
          setMessages((current) => mergeMessage(current, message));
          const peer = conversationPeer(account.pubkey, message);
          updateContacts((current) =>
            current.some((contact) => contact.pubkey === peer) ||
            current.length >= 200
              ? current
              : [
                  ...current,
                  {
                    pubkey: peer,
                    name: publicKeyLabel(peer),
                    color: parseInt(peer.slice(0, 2), 16) % 5,
                  },
                ],
          );
          if (cache)
            void request("/api/chat/history", { event }).catch((err) => {
              if (!isCancelled(err) && guard.isCurrent?.())
                setSyncState("offline");
            });
        } catch (err) {
          if (isCancelled(err)) throw err;
          rememberEnvelope(event.id);
        }
      })
      .finally(() => {
        if (accountEpoch.current === epoch)
          queuedCount.current = Math.max(0, queuedCount.current - 1);
      });
    decodeQueue.current = operation;
    return operation;
  }
  function rememberEnvelope(id: string) {
    processed.current.add(id);
    while (processed.current.size > 2000) {
      const oldest = processed.current.values().next().value;
      if (!oldest) break;
      processed.current.delete(oldest);
    }
  }

  useEffect(() => {
    if (!relayUrl) {
      setRelayState("offline");
      setHistoryLoading(false);
      return;
    }
    const account = identity,
      epoch = renderEpoch,
      generation = relayEpoch.current;
    let stopped = false;
    const client = new ChatRelay(relayUrl, (value) => {
      if (
        !stopped &&
        relay.current === client &&
        relayEpoch.current === generation
      )
        setRelayState(value);
    });
    relay.current = client;
    client.connect();
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    if (account) {
      const receive = (event: NostrEvent) =>
        !stopped && accountEpoch.current === epoch && relay.current === client
          ? queueEnvelope(account, epoch, event, true).catch(() => undefined)
          : Promise.resolve();
      client.subscribe(
        "private-" + account.pubkey.slice(0, 12),
        [{ kinds: [1059], "#p": [account.pubkey], limit: 200 }],
        receive,
        {
          onEose: () => {
            void decodeQueue.current
              .catch(() => undefined)
              .then(() => {
                if (!stopped && accountEpoch.current === epoch)
                  setHistoryLoading(false);
              });
          },
          onClosed: () => {
            if (!stopped && accountEpoch.current === epoch) {
              setHistoryLoading(false);
              setChatError(
                "This relay declined the private-message subscription. Choose another relay in Settings.",
              );
            }
          },
        },
      );
      endTimer = setTimeout(() => {
        if (!stopped && accountEpoch.current === epoch)
          setHistoryLoading(false);
      }, 10_000);
    }
    return () => {
      stopped = true;
      clearTimeout(endTimer);
      client.close();
      if (relay.current === client) relay.current = null;
    };
  }, [identity?.pubkey, renderEpoch, relayUrl, relayRefresh]);

  useEffect(() => {
    if (!identity) return;
    const account = identity,
      epoch = renderEpoch,
      controller = new AbortController(),
      guard = guardFor(account, epoch, controller.signal);
    const choice = relayChoice.current,
      edits = profileEdits.current;
    setOpeningAccount(true);
    setHistoryLoading(true);
    setAccountLoaded(false);
    setSyncState("connecting");
    for (const event of readEncryptedEvents(account.pubkey))
      void queueEnvelope(account, epoch, event).catch(() => undefined);
    const restoreOutbox = async (items: OutboxItem[], archive = false) => {
      for (const item of items) {
        assertCurrent(guard, account.pubkey);
        try {
          const decoded = await decodeRetryBundle(account, item, guard);
          assertCurrent(guard, account.pubkey);
          const existing = readLocalOutbox(account.pubkey).find(
            (value) => value.id === item.id,
          );
          const state =
            existing?.state === "published" ? "published" : item.state;
          saveLocalOutbox(account.pubkey, { ...item, state });
          if (state === "queued")
            retryBundles.current.set(item.id, {
              bundle: decoded.bundle,
              ciphertext: item.ciphertext,
            });
          else {
            retryBundles.current.delete(item.id);
            saveEncryptedEvent(account.pubkey, decoded.bundle.events[1]);
            if (archive) archivePublishedOutbox(account, epoch, decoded.bundle);
          }
          setMessages((current) =>
            mergeMessage(current, {
              ...decoded.message,
              state: state === "published" ? "published" : "failed",
            }),
          );
          updateContacts((current) =>
            current.some((contact) => contact.pubkey === decoded.bundle.peer) ||
            current.length >= 200
              ? current
              : [
                  ...current,
                  {
                    pubkey: decoded.bundle.peer,
                    name: publicKeyLabel(decoded.bundle.peer),
                    color: parseInt(decoded.bundle.peer.slice(0, 2), 16) % 5,
                  },
                ],
          );
        } catch (err) {
          if (isCancelled(err)) throw err;
        }
      }
    };
    void restoreOutbox(readLocalOutbox(account.pubkey)).catch(() => undefined);
    void readPaymentRecovery(account, guard)
      .then((records) => {
        assertCurrent(guard, account.pubkey);
        setRecovery(records);
        recoveryRef.current = records;
      })
      .catch((err) => {
        if (!isCancelled(err) && guard.isCurrent?.()) {
          setRecoveryUnavailable(true);
          setGlobalError(
            "Encrypted payment recovery could not be read. Check your wallet before making another payment.",
          );
        }
      });
    void (async () => {
      try {
        await profileWrites.current.catch(() => undefined);
        assertCurrent(guard, account.pubkey);
        await authenticateWallet(account, guard);
        assertCurrent(guard, account.pubkey);
        const results = await Promise.allSettled([
          api<AccountResponse>("/api/chat/account", undefined, "GET", guard),
          api<HistoryResponse>(
            "/api/chat/history?limit=20",
            undefined,
            "GET",
            guard,
          ),
          api<OutboxResponse>(
            "/api/chat/outbox?limit=50",
            undefined,
            "GET",
            guard,
          ),
          api<WalletState>("/api/chat/wallet", undefined, "GET", guard),
        ]);
        assertCurrent(guard, account.pubkey);
        let complete = true;
        const accountResult = results[0];
        if (accountResult.status === "fulfilled") {
          const value = accountResult.value;
          if (
            value.pubkey !== account.pubkey ||
            !Number.isSafeInteger(value.revision) ||
            value.revision < 0
          )
            throw new Error(
              "The encrypted account response belongs to another identity.",
            );
          profileRevision.current = value.revision;
          if (value.ciphertext) {
            const restored = await decodePrivateAccount(
              account,
              value.ciphertext,
              guard,
            );
            assertCurrent(guard, account.pubkey);
            updateContacts((current) => {
              const merged = new Map(
                restored.contacts.map((contact) => [contact.pubkey, contact]),
              );
              for (const contact of current) {
                const saved = merged.get(contact.pubkey);
                if (
                  !saved ||
                  profileEdits.current !== edits ||
                  contact.name !== publicKeyLabel(contact.pubkey)
                )
                  merged.set(contact.pubkey, contact);
              }
              return [...merged.values()].slice(0, 200);
            });
            if (
              !readPrivateName(account.pubkey) &&
              profileEdits.current === edits
            ) {
              const next = { ...active.current!, name: restored.name };
              active.current = next;
              setIdentity(next);
              savePrivateName(account.pubkey, restored.name);
            }
            if (
              relayChoice.current === choice &&
              profileEdits.current === edits &&
              restored.relayUrl !== relayUrl
            )
              setSelectedRelay(restored.relayUrl, false);
          }
          setAccountLoaded(true);
        } else complete = false;
        const historyResult = results[1];
        if (historyResult.status === "fulfilled") {
          const page = historyResult.value;
          for (const event of page.events.slice(0, 20))
            await queueEnvelope(account, epoch, event);
          assertCurrent(guard, account.pubkey);
          setHistoryCursor(page.cursor);
          setHistoryMore(page.hasMore);
        } else complete = false;
        const outboxResult = results[2];
        if (outboxResult.status === "fulfilled") {
          let page = outboxResult.value;
          const collected: OutboxItem[] = [];
          const seenCursors = new Set<string>();
          while (true) {
            collected.push(
              ...page.items.slice(0, Math.max(0, 100 - collected.length)),
            );
            assertCurrent(guard, account.pubkey);
            if (
              !page.hasMore ||
              !page.cursor ||
              collected.length >= 100 ||
              seenCursors.has(page.cursor)
            )
              break;
            seenCursors.add(page.cursor);
            page = await api<OutboxResponse>(
              "/api/chat/outbox?limit=50&cursor=" +
                encodeURIComponent(page.cursor),
              undefined,
              "GET",
              guard,
            );
          }
          await restoreOutbox(collected, true);
        } else complete = false;
        const walletResult = results[3];
        if (walletResult.status === "fulfilled")
          setWalletState(walletResult.value);
        assertCurrent(guard, account.pubkey);
        setSyncState(complete ? "connected" : "offline");
      } catch (err) {
        if (!isCancelled(err) && guard.isCurrent?.()) setSyncState("offline");
      } finally {
        if (guard.isCurrent?.() && !controller.signal.aborted) {
          setOpeningAccount(false);
          await decodeQueue.current.catch(() => undefined);
          if (guard.isCurrent?.()) setHistoryLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [identity?.pubkey, renderEpoch, syncRefresh]);

  useEffect(() => {
    if (!identity || !accountLoaded) return;
    const account = active.current!,
      epoch = renderEpoch,
      generation = ++profileGeneration.current;
    const controller = new AbortController(),
      guard = guardFor(account, epoch, controller.signal);
    const snapshot = {
      version: 1 as const,
      owner: account.pubkey,
      name: account.name,
      contacts,
      relayUrl: relayUrl || defaultRelay,
    };
    if (!snapshot.relayUrl) return;
    let started = false;
    const timer = setTimeout(() => {
      started = true;
      const operation = profileWrites.current
        .catch(() => undefined)
        .then(async () => {
          try {
            assertCurrent(guard, account.pubkey);
            if (generation !== profileGeneration.current) return;
            setSyncState("saving");
            const ciphertext = await encodePrivateAccount(
              account,
              snapshot,
              guard,
            );
            assertCurrent(guard, account.pubkey);
            const result = await request<AccountResponse>(
              "/api/chat/account",
              { ciphertext, expectedRevision: profileRevision.current },
              "POST",
              controller.signal,
            );
            assertCurrent(guard, account.pubkey);
            if (
              result.pubkey !== account.pubkey ||
              !Number.isSafeInteger(result.revision)
            )
              throw new Error(
                "The encrypted backup response belongs to another identity.",
              );
            profileRevision.current = result.revision;
            if (generation === profileGeneration.current)
              setSyncState("synced");
          } catch (err) {
            if (isCancelled(err) || !guard.isCurrent?.()) return;
            if (err instanceof ApiError && err.status === 409) {
              setSyncState("conflict");
              setGlobalError(
                "Your encrypted account backup changed in another tab. Refresh sync to merge your private contacts.",
              );
            } else {
              setSyncState("offline");
              if (!(err instanceof ApiError)) setGlobalError(errorMessage(err));
            }
          }
        });
      profileWrites.current = operation;
    }, 600);
    return () => {
      clearTimeout(timer);
      if (!started) controller.abort();
    };
  }, [
    identity?.pubkey,
    identity?.name,
    contacts,
    relayUrl,
    accountLoaded,
    renderEpoch,
    syncRefresh,
  ]);

  useEffect(() => {
    if (!identity) return;
    const account = identity,
      epoch = renderEpoch,
      controller = new AbortController(),
      guard = guardFor(account, epoch, controller.signal);
    void (async () => {
      const states: Record<string, "verified" | "unverified"> = {};
      for (const receipt of messages.filter(
        (message) => message.payload.type === "receipt",
      )) {
        try {
          const originals = await matchingReceiptInvoices(
            account.pubkey,
            receipt,
            messages,
            guard,
          );
          assertCurrent(guard, account.pubkey);
          states[receipt.id] = originals.length ? "verified" : "unverified";
          for (const original of originals) {
            const scope = invoiceScopeKey(
              account.pubkey,
              conversationPeer(account.pubkey, original),
              original,
            );
            setInvoiceStatuses((current) =>
              current[scope]?.state === "settled"
                ? current
                : {
                    ...current,
                    [scope]: {
                      state: "settled",
                      source: "proof",
                      settledAt: receipt.createdAt,
                      preimage:
                        receipt.payload.type === "receipt"
                          ? receipt.payload.preimage
                          : undefined,
                    },
                  },
            );
          }
        } catch (err) {
          if (isCancelled(err)) return;
          states[receipt.id] = "unverified";
        }
      }
      for (const record of recovery) {
        if (
          record.standalone ||
          record.state !== "confirmed" ||
          !record.preimage
        )
          continue;
        const original = messages.find(
          (message) =>
            message.id === record.invoiceId &&
            message.payload.type === "invoice" &&
            message.sender === record.peer &&
            message.recipient === account.pubkey &&
            JSON.stringify(message.payload) === JSON.stringify(record.invoice),
        );
        if (
          original &&
          (await paymentProofMatches(
            record.invoice.paymentHash,
            record.preimage,
            guard,
          ))
        ) {
          const scope = invoiceScopeKey(account.pubkey, record.peer, original);
          setInvoiceStatuses((current) =>
            current[scope]?.state === "settled"
              ? current
              : {
                  ...current,
                  [scope]: {
                    state: "settled",
                    source: "proof",
                    preimage: record.preimage,
                  },
                },
          );
        }
      }
      assertCurrent(guard, account.pubkey);
      setReceiptStates(states);
    })().catch(() => undefined);
    return () => controller.abort();
  }, [identity?.pubkey, messages, recovery, renderEpoch]);

  async function loadOlderHistory() {
    if (!identity || historyBusy || !historyMore) return;
    const account = identity,
      epoch = renderEpoch,
      guard = guardFor(account, epoch);
    setHistoryBusy(true);
    try {
      const page = await request<HistoryResponse>(
        "/api/chat/history?limit=20" +
          (historyCursor ? "&cursor=" + encodeURIComponent(historyCursor) : ""),
      );
      for (const event of page.events.slice(0, 20))
        await queueEnvelope(account, epoch, event);
      assertCurrent(guard, account.pubkey);
      setHistoryCursor(page.cursor);
      setHistoryMore(page.hasMore);
    } catch (err) {
      if (!isCancelled(err) && guard.isCurrent?.())
        setGlobalError(errorMessage(err));
    } finally {
      if (guard.isCurrent?.()) setHistoryBusy(false);
    }
  }

  function archivePublishedOutbox(
    account: Identity,
    epoch: number,
    bundle: RetryBundle,
  ) {
    if (archiving.current.has(bundle.id)) return;
    archiving.current.add(bundle.id);
    const guard = guardFor(account, epoch);
    const operation = archiveQueue.current
      .catch(() => undefined)
      .then(async () => {
        assertCurrent(guard, account.pubkey);
        await request("/api/chat/history", { event: bundle.events[1] });
        assertCurrent(guard, account.pubkey);
        try {
          await request(
            "/api/chat/outbox/" + bundle.id,
            { confirmed: true },
            "DELETE",
          );
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        assertCurrent(guard, account.pubkey);
        removeLocalOutbox(account.pubkey, bundle.id);
      });
    archiveQueue.current = operation
      .catch((err) => {
        if (!isCancelled(err) && guard.isCurrent?.()) setSyncState("offline");
      })
      .finally(() => {
        if (accountEpoch.current === epoch) archiving.current.delete(bundle.id);
      });
  }
  async function persistOutbox(
    account: Identity,
    epoch: number,
    item: OutboxItem,
  ) {
    const guard = guardFor(account, epoch);
    assertCurrent(guard, account.pubkey);
    const local = saveLocalOutbox(account.pubkey, item);
    try {
      await request("/api/chat/outbox", {
        id: item.id,
        ciphertext: item.ciphertext,
        state: item.state,
      });
      assertCurrent(guard, account.pubkey);
    } catch (err) {
      if (isCancelled(err)) throw err;
      if (!local)
        throw new Error(
          "This encrypted message could not be saved. Free browser storage or reconnect encrypted sync before sending.",
        );
      if (guard.isCurrent?.()) setSyncState("offline");
    }
  }
  async function publishBundle(
    account: Identity,
    epoch: number,
    client: ChatRelay,
    generation: number,
    bundle: RetryBundle,
    ciphertext: string,
  ) {
    const guard = guardFor(account, epoch);
    const ensureRelay = () => {
      assertCurrent(guard, account.pubkey);
      if (relay.current !== client || relayEpoch.current !== generation)
        throw new DOMException("The relay changed.", "AbortError");
    };
    ensureRelay();
    setMessages((current) =>
      current.map((message) =>
        message.id === bundle.id
          ? { ...message, state: "publishing", error: undefined }
          : message,
      ),
    );
    try {
      await client.publish(bundle.events[0]);
      ensureRelay();
      saveEncryptedEvent(account.pubkey, bundle.events[1]);
      setMessages((current) =>
        current.map((message) =>
          message.id === bundle.id
            ? { ...message, state: "published", error: undefined }
            : message,
        ),
      );
      retryBundles.current.delete(bundle.id);
      try {
        await persistOutbox(account, epoch, {
          id: bundle.id,
          ciphertext,
          state: "published",
          updatedAt: Date.now(),
        });
        ensureRelay();
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (guard.isCurrent?.()) {
          setSyncState("offline");
          notify(
            "Message published. Its encrypted publication status will need a sync refresh.",
          );
        }
      }
      try {
        await request("/api/chat/history", { event: bundle.events[1] });
        ensureRelay();
        await request(
          "/api/chat/outbox/" + bundle.id,
          { confirmed: true },
          "DELETE",
        );
        ensureRelay();
        removeLocalOutbox(account.pubkey, bundle.id);
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (guard.isCurrent?.()) setSyncState("offline");
      }
      try {
        await client.publish(bundle.events[1]);
        ensureRelay();
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (guard.isCurrent?.())
          notify(
            "Message published. Your encrypted sender copy is saved here while the relay reconnects.",
          );
      }
    } catch (err) {
      if (
        !isCancelled(err) &&
        guard.isCurrent?.() &&
        relay.current === client
      ) {
        setMessages((current) =>
          current.map((message) =>
            message.id === bundle.id && message.state !== "published"
              ? { ...message, state: "failed", error: errorMessage(err) }
              : message,
          ),
        );
      }
      throw err;
    }
  }
  async function sendPayload(payload: ChatPayload, peer: string) {
    const account = active.current,
      epoch = accountEpoch.current,
      client = relay.current,
      generation = relayEpoch.current;
    if (!account || !peer || !client)
      throw new Error("Choose a contact and a relay before sending.");
    const guard = guardFor(account, epoch);
    if (client.state !== "connected")
      throw new Error(
        "Your relay is offline. Your draft stays here while it reconnects.",
      );
    assertCurrent(guard, account.pubkey);
    const canonicalPayload = parsePayload(JSON.stringify(payload));
    const wrapped = await createGiftWraps(
      account,
      peer,
      canonicalPayload,
      undefined,
      guard,
    );
    assertCurrent(guard, account.pubkey);
    if (relay.current !== client || relayEpoch.current !== generation)
      throw new DOMException("The relay changed.", "AbortError");
    const message: ChatMessage = {
      id: wrapped.rumor.id,
      sender: account.pubkey,
      recipient: peer,
      createdAt: wrapped.rumor.created_at * 1000,
      payload: canonicalPayload,
      state: "publishing",
    };
    const bundle: RetryBundle = {
      version: 1,
      owner: account.pubkey,
      peer,
      id: message.id,
      events: wrapped.events,
    };
    const ciphertext = await encodeRetryBundle(account, bundle, guard);
    assertCurrent(guard, account.pubkey);
    if (relay.current !== client || relayEpoch.current !== generation)
      throw new DOMException("The relay changed.", "AbortError");
    await persistOutbox(account, epoch, {
      id: message.id,
      ciphertext,
      state: "queued",
      updatedAt: Date.now(),
    });
    assertCurrent(guard, account.pubkey);
    if (relay.current !== client || relayEpoch.current !== generation)
      throw new DOMException("The relay changed.", "AbortError");
    retryBundles.current.set(message.id, { bundle, ciphertext });
    setMessages((current) => mergeMessage(current, message));
    await publishBundle(account, epoch, client, generation, bundle, ciphertext);
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!identity || !selected || sendingPeer || openingAccount) return;
    const account = identity,
      epoch = renderEpoch,
      peer = selected,
      text = (drafts[peer] || "").trim(),
      guard = guardFor(account, epoch);
    if (!text) return;
    setSendingPeer(peer);
    setChatError("");
    try {
      await sendPayload({ type: "text", text }, peer);
      assertCurrent(guard, account.pubkey);
      setDrafts((current) =>
        (current[peer] || "").trim() === text
          ? { ...current, [peer]: "" }
          : current,
      );
    } catch (err) {
      if (!isCancelled(err) && guard.isCurrent?.()) {
        setChatError(errorMessage(err));
        if (
          messagesRef.current.some(
            (message) =>
              message.sender === account.pubkey &&
              message.recipient === peer &&
              message.payload.type === "text" &&
              message.payload.text === text &&
              message.state === "failed",
          )
        )
          setDrafts((current) =>
            (current[peer] || "").trim() === text
              ? { ...current, [peer]: "" }
              : current,
          );
      }
    } finally {
      if (guard.isCurrent?.()) setSendingPeer(null);
    }
  }
  async function retryMessage(message: ChatMessage) {
    const account = active.current,
      epoch = accountEpoch.current,
      client = relay.current,
      generation = relayEpoch.current,
      value = retryBundles.current.get(message.id);
    if (
      !account ||
      !client ||
      !value ||
      message.sender !== account.pubkey ||
      value.bundle.owner !== account.pubkey ||
      value.bundle.peer !== message.recipient
    )
      return;
    const guard = guardFor(account, epoch);
    try {
      await publishBundle(
        account,
        epoch,
        client,
        generation,
        value.bundle,
        value.ciphertext,
      );
    } catch (err) {
      if (!isCancelled(err) && guard.isCurrent?.())
        setChatError(errorMessage(err));
    }
  }

  async function importData(input: unknown) {
    const account = active.current,
      epoch = accountEpoch.current;
    if (!account) throw new Error("Unlock your identity before importing.");
    const guard = guardFor(account, epoch);
    assertCurrent(guard, account.pubkey);
    if (
      input &&
      typeof input === "object" &&
      "format" in input &&
      input.format === "nostrchat.contacts"
    ) {
      const value = input as { version?: unknown; contacts?: unknown };
      if (value.version !== 1)
        throw new Error("This contact export uses an unsupported format.");
      const restored = validateContacts(value.contacts, account.pubkey);
      profileEdits.current++;
      updateContacts((current) =>
        [
          ...new Map(
            [...current, ...restored].map((contact) => [
              contact.pubkey,
              contact,
            ]),
          ).values(),
        ].slice(0, 200),
      );
      return (
        restored.length +
        (restored.length === 1 ? " contact imported." : " contacts imported.")
      );
    }
    const count = importEncryptedHistory(account.pubkey, input);
    for (const event of readEncryptedEvents(account.pubkey))
      await queueEnvelope(account, epoch, event, true);
    assertCurrent(guard, account.pubkey);
    return count + " encrypted envelopes imported for this identity.";
  }
  function exportHistory() {
    if (identity) {
      downloadFile(
        JSON.stringify(exportEncryptedHistory(identity.pubkey), null, 2),
        "nostrchat-encrypted-history.json",
        "application/json",
      );
      notify("Encrypted history export downloaded.");
    }
  }
  function exportContacts() {
    if (identity) {
      downloadFile(
        JSON.stringify(
          {
            format: "nostrchat.contacts",
            version: 1,
            owner: identity.pubkey,
            contacts,
          },
          null,
          2,
        ),
        "nostrchat-contacts.json",
        "application/json",
      );
      notify(
        "Contact export downloaded. Keep its private names and notes somewhere you trust.",
      );
    }
  }

  function paymentFromInvoice(message: ChatMessage): PaymentReview {
    if (
      !identity ||
      message.payload.type !== "invoice" ||
      message.recipient !== identity.pubkey ||
      message.sender === identity.pubkey
    )
      throw new Error("This request is not addressed to your identity.");
    invoiceScopeKey(identity.pubkey, message.sender, message);
    const record = recoveryRef.current.find(
      (value) =>
        !value.standalone &&
        value.peer === message.sender &&
        value.invoiceId === message.id &&
        JSON.stringify(value.invoice) === JSON.stringify(message.payload),
    );
    return {
      owner: identity.pubkey,
      peer: message.sender,
      invoiceId: message.id,
      invoice: message.payload,
      attempted: Boolean(record) || recoveryUnavailable,
      attemptedAt: record?.attemptedAt,
      preimage: record?.preimage,
    };
  }
  function openPayment(message: ChatMessage) {
    try {
      const value = paymentFromInvoice(message);
      setPreview(null);
      setPaymentError("");
      setPaymentResult(null);
      setWalletOpen(false);
      setOverlay(null);
      setPayment(value);
    } catch (err) {
      setChatError(errorMessage(err));
    }
  }
  function openPastedPayment(invoice: InvoicePayload) {
    if (!identity) return;
    const record = recoveryRef.current.find(
      (value) =>
        value.standalone &&
        value.invoiceId === invoice.paymentHash &&
        value.invoice.bolt11 === invoice.bolt11,
    );
    setWalletOpen(false);
    setPreview(null);
    setPaymentError("");
    setPaymentResult(null);
    setPayment({
      owner: identity.pubkey,
      peer: null,
      invoiceId: null,
      invoice,
      attempted: Boolean(record) || recoveryUnavailable,
      attemptedAt: record?.attemptedAt,
      preimage: record?.preimage,
    });
  }
  function openSavedPayment(record: PaymentRecoveryRecord) {
    if (
      !identity ||
      !record.standalone ||
      record.peer !== identity.pubkey ||
      record.invoiceId !== record.invoice.paymentHash
    )
      return;
    setWalletOpen(false);
    setOverlay(null);
    setPreview(null);
    setPaymentError("");
    setPayment({
      owner: identity.pubkey,
      peer: null,
      invoiceId: null,
      invoice: record.invoice,
      attempted: true,
      attemptedAt: record.attemptedAt,
      preimage: record.preimage,
    });
    setPaymentResult(
      record.state === "confirmed" && record.preimage
        ? {
            paymentHash: record.invoice.paymentHash,
            state: "settled",
            preimage: record.preimage,
            amountSats: record.invoice.amountSats,
          }
        : null,
    );
  }
  function recoveryRecord(
    review: PaymentReview,
    state: "unknown" | "confirmed",
    preimage?: string,
  ): PaymentRecoveryRecord {
    return {
      peer: review.peer || review.owner,
      invoiceId: review.invoiceId || review.invoice.paymentHash,
      invoice: review.invoice,
      attemptedAt: review.attemptedAt || Date.now(),
      state,
      ...(preimage ? { preimage } : {}),
      ...(!review.peer ? { standalone: true } : {}),
    };
  }
  async function persistRecovery(
    account: Identity,
    epoch: number,
    record: PaymentRecoveryRecord,
  ) {
    const guard = guardFor(account, epoch);
    assertCurrent(guard, account.pubkey);
    const next = [
      ...recoveryRef.current.filter(
        (value) =>
          !(
            value.peer === record.peer &&
            value.invoiceId === record.invoiceId &&
            Boolean(value.standalone) === Boolean(record.standalone)
          ),
      ),
      record,
    ];
    await savePaymentRecovery(account, next, guard);
    assertCurrent(guard, account.pubkey);
    recoveryRef.current = next;
    setRecovery(next);
  }
  function originalForReview(review: PaymentReview) {
    if (!review.peer || !review.invoiceId) return undefined;
    return messagesRef.current.find(
      (message) =>
        message.id === review.invoiceId &&
        message.payload.type === "invoice" &&
        message.sender === review.peer &&
        message.recipient === review.owner &&
        JSON.stringify(message.payload) === JSON.stringify(review.invoice),
    );
  }
  async function shareVerifiedReceipt(review: PaymentReview, preimage: string) {
    const account = active.current,
      epoch = accountEpoch.current;
    if (
      !account ||
      account.pubkey !== review.owner ||
      !review.peer ||
      !review.invoiceId
    )
      return;
    if (!originalForReview(review))
      throw new Error(
        "Reopen the original conversation invoice before sharing this receipt.",
      );
    const guard = guardFor(account, epoch);
    if (
      !(await paymentProofMatches(review.invoice.paymentHash, preimage, guard))
    )
      throw new Error("This payment proof does not match the invoice.");
    assertCurrent(guard, account.pubkey);
    const existing = messagesRef.current.find(
      (message) =>
        message.sender === review.owner &&
        message.recipient === review.peer &&
        message.payload.type === "receipt" &&
        message.payload.invoiceId === review.invoiceId &&
        message.payload.preimage === preimage,
    );
    if (existing) return;
    await sendPayload(
      {
        type: "receipt",
        paymentHash: review.invoice.paymentHash,
        preimage,
        invoiceId: review.invoiceId,
      },
      review.peer,
    );
  }
  async function applyPaymentResult(
    account: Identity,
    epoch: number,
    review: PaymentReview,
    result: PaymentResult,
  ) {
    const guard = guardFor(account, epoch);
    assertCurrent(guard, account.pubkey);
    if (
      result.paymentHash !== review.invoice.paymentHash ||
      (result.amountSats !== undefined &&
        result.amountSats !== review.invoice.amountSats)
    )
      throw new Error(
        "Your wallet returned different payment details. Check the payment in your wallet.",
      );
    if (!["settled", "unknown", "not_found"].includes(result.state))
      throw new Error("Your wallet returned an unsupported payment status.");
    if (result.state !== "settled" && result.preimage !== undefined)
      throw new Error(
        "An unconfirmed wallet result cannot claim payment proof.",
      );
    if (result.state === "settled") {
      if (
        !result.preimage ||
        !(await paymentProofMatches(result.paymentHash, result.preimage, guard))
      )
        throw new Error(
          "The payment proof could not be verified. Check the payment in your wallet before continuing.",
        );
      assertCurrent(guard, account.pubkey);
      const original = originalForReview(review);
      if (original && review.peer) {
        const scope = invoiceScopeKey(account.pubkey, review.peer, original);
        setInvoiceStatuses((current) => ({
          ...current,
          [scope]: {
            state: "settled",
            source: "wallet",
            settledAt: result.settledAt,
            preimage: result.preimage,
          },
        }));
      }
      try {
        await persistRecovery(
          account,
          epoch,
          recoveryRecord(review, "confirmed", result.preimage),
        );
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (guard.isCurrent?.())
          setGlobalError(
            "Payment verified. This device could not cache the new proof; your wallet can reconcile it on your next visit.",
          );
      }
      assertCurrent(guard, account.pubkey);
      if (result.preimage && original) {
        try {
          await shareVerifiedReceipt(review, result.preimage);
        } catch (err) {
          if (isCancelled(err)) throw err;
          if (guard.isCurrent?.())
            notify(
              "Payment verified. Its proof will need publication when your relay is available.",
            );
        }
      }
    }
  }

  useEffect(() => {
    if (
      !payment ||
      !identity ||
      payment.owner !== identity.pubkey ||
      payment.attempted
    )
      return;
    const review = payment,
      account = identity,
      epoch = renderEpoch,
      controller = new AbortController(),
      guard = guardFor(account, epoch, controller.signal);
    setPaymentLoading(true);
    setPaymentError("");
    setPreview(null);
    void (async () => {
      try {
        if (review.invoice.expiresAt <= Date.now())
          throw new Error(
            "This invoice has expired. Ask your contact for a fresh request.",
          );
        const value = await request<PaymentPreview>(
          "/api/chat/payments/preview",
          { bolt11: review.invoice.bolt11 },
          "POST",
          controller.signal,
        );
        assertCurrent(guard, account.pubkey);
        if (
          value.paymentHash !== review.invoice.paymentHash ||
          value.amountSats !== review.invoice.amountSats ||
          value.expiresAt !== review.invoice.expiresAt ||
          typeof value.reviewId !== "string" ||
          !value.reviewId ||
          value.reviewExpiresAt <= Date.now() ||
          !value.wallet ||
          typeof value.walletReference !== "string"
        )
          throw new Error(
            "This payment review does not match the original invoice.",
          );
        if (
          paymentRef.current &&
          reviewIdentity(paymentRef.current) === reviewIdentity(review)
        )
          setPreview(value);
      } catch (err) {
        if (
          !isCancelled(err) &&
          guard.isCurrent?.() &&
          !controller.signal.aborted
        )
          setPaymentError(errorMessage(err));
      } finally {
        if (guard.isCurrent?.() && !controller.signal.aborted)
          setPaymentLoading(false);
      }
    })();
    return () => controller.abort();
  }, [
    identity?.pubkey,
    payment ? reviewIdentity(payment) : "",
    payment?.attempted,
    renderEpoch,
    reviewRefresh,
  ]);

  async function confirmPayment() {
    const review = payment,
      reviewed = preview,
      account = identity,
      epoch = renderEpoch;
    if (
      !review ||
      !reviewed ||
      !account ||
      review.owner !== account.pubkey ||
      review.attempted ||
      paymentBusy
    )
      return;
    const guard = guardFor(account, epoch);
    setPaymentBusy(true);
    setPaymentError("");
    let attempted = false;
    try {
      if (
        reviewed.reviewExpiresAt <= Date.now() ||
        review.invoice.expiresAt <= Date.now()
      )
        throw new Error(
          "This review expired. Refresh the review before paying.",
        );
      if (review.peer && !originalForReview(review))
        throw new Error(
          "The original conversation invoice is no longer available. Reopen that request.",
        );
      await persistRecovery(account, epoch, recoveryRecord(review, "unknown"));
      assertCurrent(guard, account.pubkey);
      attempted = true;
      const captured = {
        ...review,
        attempted: true,
        attemptedAt: review.attemptedAt || Date.now(),
      };
      setPayment(captured);
      const result = await request<PaymentResult>("/api/chat/payments", {
        reviewId: reviewed.reviewId,
        confirmed: true,
      });
      assertCurrent(guard, account.pubkey);
      if (!["settled", "unknown"].includes(result.state))
        throw new Error(
          "Your wallet returned an unsupported payment status. Check your wallet before retrying.",
        );
      await applyPaymentResult(account, epoch, captured, result);
      assertCurrent(guard, account.pubkey);
      setPaymentResult(result);
      if (result.state === "settled")
        notify(
          nf.format(review.invoice.amountSats) + " sats paid and verified.",
        );
      else
        setPaymentError(
          result.message ||
            "The wallet has not returned a final result. Check status before making another payment attempt.",
        );
    } catch (err) {
      if (!isCancelled(err) && guard.isCurrent?.()) {
        setPaymentError(errorMessage(err));
        if (attempted)
          setPaymentResult({
            paymentHash: review.invoice.paymentHash,
            state: "unknown",
            message:
              "A payment was attempted. Check status before trying again.",
          });
      }
    } finally {
      if (guard.isCurrent?.()) setPaymentBusy(false);
    }
  }
  async function recoverPayment(review: PaymentReview, displayInDialog = true) {
    const account = active.current,
      epoch = accountEpoch.current;
    if (!account || account.pubkey !== review.owner) return;
    const guard = guardFor(account, epoch);
    if (displayInDialog) {
      setPaymentBusy(true);
      setPaymentError("");
    }
    try {
      const result = await request<PaymentResult>(
        "/api/chat/payments/" + review.invoice.paymentHash,
      );
      assertCurrent(guard, account.pubkey);
      await applyPaymentResult(account, epoch, review, result);
      assertCurrent(guard, account.pubkey);
      if (
        displayInDialog &&
        paymentRef.current &&
        reviewIdentity(paymentRef.current) === reviewIdentity(review)
      ) {
        setPaymentResult(result);
        if (result.state === "not_found") {
          setPayment({ ...review, attempted: false });
          setReviewRefresh((value) => value + 1);
          setPaymentError(
            "No completed or pending payment is recorded for this invoice. Review the current wallet before confirming.",
          );
        } else if (result.state === "unknown")
          setPaymentError(
            result.message ||
              "The wallet result is still uncertain. Check again before another payment attempt.",
          );
      }
      if (result.state === "settled")
        notify("Payment verified by your wallet.");
      else if (!displayInDialog)
        notify(
          result.state === "unknown"
            ? "This payment still needs a wallet status check."
            : "No payment for this invoice is recorded by your connected wallet.",
        );
    } catch (err) {
      if (!isCancelled(err) && guard.isCurrent?.())
        displayInDialog
          ? setPaymentError(errorMessage(err))
          : setGlobalError(errorMessage(err));
    } finally {
      if (displayInDialog && guard.isCurrent?.()) setPaymentBusy(false);
    }
  }
  async function checkInvoice(message: ChatMessage) {
    const account = active.current,
      epoch = accountEpoch.current;
    if (!account || message.payload.type !== "invoice") return;
    const invoice = message.payload,
      peer = conversationPeer(account.pubkey, message),
      guard = guardFor(account, epoch);
    const scope = invoiceScopeKey(account.pubkey, peer, message);
    setCheckingScope(scope);
    setGlobalError("");
    setChatError("");
    try {
      if (message.sender !== account.pubkey) {
        const review = paymentFromInvoice(message);
        await recoverPayment(review, false);
        assertCurrent(guard, account.pubkey);
      } else {
        const result = await request<VerifiedInvoice>(
          "/api/chat/wallet/invoices/" + invoice.paymentHash,
        );
        assertCurrent(guard, account.pubkey);
        const facts = inspectInvoice(result.bolt11);
        if (
          result.paymentHash !== invoice.paymentHash ||
          result.bolt11 !== invoice.bolt11 ||
          result.amountSats !== invoice.amountSats ||
          result.expiresAt !== invoice.expiresAt ||
          facts.paymentHash !== invoice.paymentHash ||
          !["pending", "expired", "settled"].includes(result.state)
        )
          throw new Error(
            "The wallet returned different invoice details. Check your receiving wallet.",
          );
        if (
          result.state === "settled" &&
          (!result.preimage ||
            !(await paymentProofMatches(
              invoice.paymentHash,
              result.preimage,
              guard,
            )))
        )
          throw new Error(
            "The wallet’s settlement proof could not be verified.",
          );
        if (result.state !== "settled" && result.preimage !== undefined)
          throw new Error(
            "An unconfirmed invoice cannot claim settlement proof.",
          );
        assertCurrent(guard, account.pubkey);
        setInvoiceStatuses((current) => ({
          ...current,
          [scope]: {
            state: result.state,
            source: "wallet",
            settledAt: result.settledAt,
            preimage: result.preimage,
          },
        }));
        notify(
          result.state === "settled"
            ? "Payment verified by your receiving wallet."
            : result.state === "expired"
              ? "This invoice has expired."
              : "Your wallet has not received this payment yet.",
        );
      }
    } catch (err) {
      if (!isCancelled(err) && guard.isCurrent?.())
        setGlobalError(errorMessage(err));
    } finally {
      if (guard.isCurrent?.()) setCheckingScope("");
    }
  }

  const paymentPerson = payment?.peer
    ? contacts.find((person) => person.pubkey === payment.peer)?.name ||
      publicKeyLabel(payment.peer)
    : null;
  const paymentSettled = paymentResult?.state === "settled";
  const reviewExpired = Boolean(
    preview && preview.reviewExpiresAt <= clockTick,
  );
  const retryable = new Set(retryBundles.current.keys());
  const pageTitles: Record<Pane, string> = {
    messages: "Messages",
    people: "Your people",
    activity: "Payment activity",
  };

  return (
    <div
      className={
        "app-page " +
        (identity ? "app-page--signed-in " : "") +
        (keyboardOpen ? "keyboard-open " : "") +
        (selected && pane === "messages" ? "conversation-open" : "")
      }
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div
        className="app-content"
        inert={overlayOpen || undefined}
        aria-hidden={overlayOpen || undefined}
      >
        <header className="topbar">
          <button
            className="brand-button"
            onClick={() => {
              if (identity) {
                setPane("messages");
                setSelected(null);
              }
            }}
            aria-label="NostrChat home"
          >
            <Brand />
          </button>
          <nav className="desktop-navigation" aria-label="Main navigation">
            <button
              className={identity && pane === "messages" ? "selected" : ""}
              aria-current={
                identity && pane === "messages" ? "page" : undefined
              }
              onClick={() => changePane("messages")}
            >
              <ChatsCircle size={19} />
              Messages
            </button>
            <button
              className={identity && pane === "people" ? "selected" : ""}
              aria-current={identity && pane === "people" ? "page" : undefined}
              onClick={() => changePane("people")}
            >
              <AddressBook size={19} />
              People
            </button>
            <button
              className={identity && pane === "activity" ? "selected" : ""}
              aria-current={
                identity && pane === "activity" ? "page" : undefined
              }
              onClick={() => changePane("activity")}
            >
              <Lightning size={19} />
              Activity
            </button>
          </nav>
          <div className="topbar-actions">
            <button
              className={
                "relay-pill " +
                (relayState === "connected" ? "relay-pill--online" : "")
              }
              onClick={() => setOverlay("settings")}
              title={relayUrl || "Choose a relay"}
              aria-label={"Relay settings: " + relayState}
            >
              <span
                className={
                  "status-dot " + (relayState === "connected" ? "online" : "")
                }
              />
              <span>
                {relayState === "connected"
                  ? "Relay connected"
                  : relayState === "connecting"
                    ? "Connecting"
                    : "Relay offline"}
              </span>
              {relayState === "connected" ? (
                <WifiHigh size={17} />
              ) : (
                <WifiSlash size={17} />
              )}
            </button>
            <IconButton
              label="Help and privacy"
              className="header-help"
              onClick={() => setOverlay("help")}
            >
              <Info size={21} />
            </IconButton>
            {identity ? (
              <>
                <IconButton
                  label="Open Lightning wallet"
                  className="header-wallet"
                  onClick={() => openWallet()}
                >
                  <Wallet size={21} />
                </IconButton>
                <button
                  className="identity-button"
                  aria-label="Identity settings"
                  onClick={() => setOverlay("settings")}
                >
                  <Avatar name={identity.name} color={2} size="small" />
                  <span>{identity.name.split(" ")[0]}</span>
                </button>
              </>
            ) : (
              <button
                className="button button-primary button-small header-connect"
                onClick={() => openIdentity()}
              >
                <Key size={17} />
                Connect
              </button>
            )}
          </div>
        </header>
        {identity && (relayState === "offline" || syncState === "conflict") && (
          <div className="connection-banner" role="status">
            <WarningCircle size={18} />
            <span>
              {syncState === "conflict"
                ? "Your encrypted backup changed in another tab."
                : relayUrl
                  ? "Your relay is offline. Drafts and encrypted history stay available here."
                  : "Choose a relay to publish and receive private messages."}
            </span>
            <button
              onClick={() =>
                syncState === "conflict"
                  ? setSyncRefresh((value) => value + 1)
                  : relayUrl
                    ? setRelayRefresh((value) => value + 1)
                    : setOverlay("settings")
              }
            >
              {syncState === "conflict"
                ? "Refresh sync"
                : relayUrl
                  ? "Reconnect"
                  : "Choose relay"}
              <ArrowClockwise size={15} />
            </button>
          </div>
        )}
        {globalError && (
          <div className="global-error" role="alert">
            <WarningCircle size={18} />
            <span>{globalError}</span>
            {syncState === "conflict" && (
              <button
                className="text-button"
                onClick={() => {
                  setGlobalError("");
                  setSyncRefresh((value) => value + 1);
                }}
              >
                Refresh sync
              </button>
            )}
            <IconButton
              label="Dismiss notification"
              onClick={() => setGlobalError("")}
            >
              <X size={18} />
            </IconButton>
          </div>
        )}
        {!identity ? (
          <Landing
            onConnect={() => openIdentity()}
            onCreate={() => openIdentity("create")}
            onHelp={() => setOverlay("help")}
            relayState={relayState}
          />
        ) : (
          <main
            id="main-content"
            className={"signed-in-content signed-in-content--" + pane}
          >
            <header className="workspace-heading">
              <div>
                <span className="eyebrow">
                  {pane === "messages"
                    ? "YOUR PRIVATE SPACE"
                    : pane === "people"
                      ? "A PERSONAL ADDRESS BOOK"
                      : "LIGHTNING, WITH CONTEXT"}
                </span>
                <h1>
                  {pageTitles[pane]}
                  <span>.</span>
                </h1>
              </div>
              <div className="workspace-heading-actions">
                <button
                  className="sync-pill"
                  onClick={() => setSyncRefresh((value) => value + 1)}
                  title="Refresh encrypted account sync"
                >
                  <LockKey size={15} />
                  <span>
                    {openingAccount
                      ? "Opening encrypted inbox"
                      : syncLabels[syncState]}
                  </span>
                  {openingAccount || syncState === "saving" ? (
                    <Spinner />
                  ) : (
                    <ArrowClockwise size={14} />
                  )}
                </button>
                <button
                  className="button button-primary"
                  onClick={
                    pane === "activity" ? () => openWallet() : newConversation
                  }
                >
                  <Plus size={18} />
                  <span>
                    {pane === "activity" ? "Request sats" : "New conversation"}
                  </span>
                </button>
              </div>
            </header>
            {pane === "messages" ? (
              <>
                {historyMore && (
                  <div className="history-toolbar">
                    <button
                      className="text-button"
                      disabled={historyBusy}
                      onClick={() => void loadOlderHistory()}
                    >
                      {historyBusy ? <Spinner /> : <ArrowClockwise size={15} />}
                      Load older encrypted history
                    </button>
                  </div>
                )}
                <div className="message-grid">
                  <Inbox
                    identity={identity}
                    contacts={contacts}
                    allMessages={messages}
                    selected={selected}
                    query={query}
                    onQuery={setQuery}
                    filter={inboxFilter}
                    onFilter={setInboxFilter}
                    onSelect={showConversation}
                    onNew={newConversation}
                    onCopy={copy}
                    loading={openingAccount || historyLoading}
                  />
                  {contact ? (
                    <Thread
                      key={contact.pubkey}
                      identity={identity}
                      contact={contact}
                      messages={conversation}
                      draft={drafts[contact.pubkey] || ""}
                      onDraft={(value) =>
                        setDrafts((current) => ({
                          ...current,
                          [contact.pubkey]: value,
                        }))
                      }
                      onSend={(event) => void send(event)}
                      sending={sendingPeer === contact.pubkey}
                      canSend={
                        relayState === "connected" &&
                        !openingAccount &&
                        !sendingPeer
                      }
                      offline={relayState !== "connected"}
                      loading={historyLoading}
                      error={chatError}
                      onDismissError={() => setChatError("")}
                      onBack={() => setSelected(null)}
                      onEdit={() => {
                        setEditingContact(contact);
                        setOverlay("contact");
                      }}
                      onWallet={() => openWallet()}
                      onHelp={() => setOverlay("help")}
                      onCopy={copy}
                      statuses={invoiceStatuses}
                      checking={checkingScope}
                      attempts={attempts}
                      onCheckInvoice={(message) => void checkInvoice(message)}
                      onReviewInvoice={openPayment}
                      onRetry={(message) => void retryMessage(message)}
                      retryable={retryable}
                      receiptStates={receiptStates}
                    />
                  ) : (
                    <section className="thread-pane thread-pane--empty">
                      <EmptyThread
                        identity={identity}
                        wallet={walletState}
                        onNew={newConversation}
                        onCopy={copy}
                        onWallet={() => openWallet()}
                      />
                    </section>
                  )}
                </div>
              </>
            ) : pane === "people" ? (
              <People
                identity={identity}
                contacts={contacts}
                query={peopleQuery}
                onQuery={setPeopleQuery}
                onNew={newConversation}
                onSelect={showConversation}
                onEdit={(person) => {
                  setEditingContact(person);
                  setOverlay("contact");
                }}
                onCopy={copy}
              />
            ) : (
              <Activity
                identity={identity}
                messages={messages}
                contacts={contacts}
                statuses={invoiceStatuses}
                filter={activityFilter}
                onFilter={setActivityFilter}
                onView={showConversation}
                onCheck={(message) => void checkInvoice(message)}
                checking={checkingScope}
                recovery={recovery}
                onRecover={openSavedPayment}
                onWallet={() => openWallet()}
              />
            )}
          </main>
        )}
        {identity && (
          <nav className="mobile-navigation" aria-label="Phone navigation">
            <button
              aria-current={pane === "messages" ? "page" : undefined}
              className={pane === "messages" ? "selected" : ""}
              onClick={() => changePane("messages")}
            >
              <ChatsCircle
                size={22}
                weight={pane === "messages" ? "fill" : "regular"}
              />
              <span>Messages</span>
            </button>
            <button
              aria-current={pane === "people" ? "page" : undefined}
              className={pane === "people" ? "selected" : ""}
              onClick={() => changePane("people")}
            >
              <AddressBook
                size={22}
                weight={pane === "people" ? "fill" : "regular"}
              />
              <span>People</span>
            </button>
            <button
              aria-current={pane === "activity" ? "page" : undefined}
              className={pane === "activity" ? "selected" : ""}
              onClick={() => changePane("activity")}
            >
              <Lightning
                size={22}
                weight={pane === "activity" ? "fill" : "regular"}
              />
              <span>Activity</span>
            </button>
            <button onClick={() => openWallet()}>
              <Wallet size={22} />
              <span>Wallet</span>
            </button>
            <button onClick={() => setOverlay("settings")}>
              <GearSix size={22} />
              <span>Settings</span>
            </button>
          </nav>
        )}
      </div>
      {overlay === "identity" && (
        <IdentityDialog
          onClose={closeOverlay}
          initial={identityEntry}
          isCurrent={() => accountEpoch.current === renderEpoch}
          onIdentity={(value) => {
            if (accountEpoch.current === renderEpoch) activateIdentity(value);
            else destroyIdentity(value);
          }}
        />
      )}
      {overlay === "contact" && identity && (
        <ContactDialog
          identity={identity}
          contact={editingContact}
          onClose={closeOverlay}
          onSave={saveContact}
          onRemove={removeContact}
          onCopy={copy}
        />
      )}
      {overlay === "settings" && (
        <SettingsDialog
          identity={identity}
          relayUrl={relayUrl}
          relayState={relayState}
          syncState={syncLabels[syncState]}
          onClose={closeOverlay}
          onRelay={(url) => setSelectedRelay(url)}
          onProfile={saveProfile}
          onLogout={logout}
          onNotice={notify}
          onCopy={copy}
          onExportHistory={exportHistory}
          onExportContacts={exportContacts}
          onImport={importData}
          isCurrent={() => accountEpoch.current === renderEpoch}
          onHelp={() => setOverlay("help")}
        />
      )}
      {overlay === "help" && <HelpDialog onClose={closeOverlay} />}
      {walletOpen && identity && (
        <WalletPanel
          key={identity.pubkey + ":" + renderEpoch}
          contact={contact}
          request={request}
          onClose={closeWallet}
          onWallet={setWalletState}
          onNotice={notify}
          onCopy={copy}
          onShare={async (invoice, peer) => {
            await sendPayload(invoice, peer);
          }}
          onReview={openPastedPayment}
          initialTab={walletTab}
          practiceWallets={Boolean(
            localHost &&
            config?.backend === "local" &&
            config.lightningLabReady,
          )}
          generated={generatedInvoice}
          onGenerated={setGeneratedInvoice}
        />
      )}
      {payment && identity && (
        <Modal
          title={
            paymentSettled
              ? "A payment, verified."
              : payment.attempted
                ? "Let’s check that payment."
                : "A payment, with your say-so."
          }
          eyebrow={
            paymentSettled ? "PAYMENT RECEIPT" : "REVIEW YOUR LIGHTNING PAYMENT"
          }
          onClose={() => {
            if (!paymentBusy) {
              setPayment(null);
              setPreview(null);
              setPaymentResult(null);
              setPaymentError("");
            }
          }}
          canClose={!paymentBusy}
        >
          <p className="dialog-intro">
            {paymentSettled
              ? "Your connected wallet confirmed this invoice. Its receipt belongs to the original conversation."
              : payment.attempted
                ? "A payment was attempted for this invoice. Reconcile its status before making another attempt."
                : "Review the original invoice, network, and paying wallet before you confirm."}
          </p>
          <div
            className={
              "payment-review " +
              (paymentSettled ? "payment-review--settled" : "")
            }
          >
            <span>
              {paymentPerson
                ? "Payment to " + paymentPerson
                : "Lightning invoice payment"}
            </span>
            <strong>
              {nf.format(payment.invoice.amountSats)}
              <small>sats</small>
            </strong>
            <p>{payment.invoice.description || "Description unavailable"}</p>
            <code>
              {payment.invoice.paymentHash.slice(0, 12) +
                "…" +
                payment.invoice.paymentHash.slice(-8)}
            </code>
            {paymentSettled && (
              <span className="payment-verified">
                <ShieldCheck size={18} />
                {paymentResult?.preimage
                  ? "Matching payment preimage verified"
                  : "Confirmed by your wallet provider"}
              </span>
            )}
          </div>
          {paymentLoading && (
            <div className="loading-line" role="status">
              <Spinner label="Preparing your wallet-bound review…" />
            </div>
          )}
          {preview && !payment.attempted && !paymentSettled && (
            <div className="payment-wallet-facts">
              <div>
                <span>Network</span>
                <strong>{networkLabel(preview.network)}</strong>
              </div>
              <div>
                <span>Paying wallet</span>
                <strong>
                  {preview.wallet.alias || preview.wallet.kind.toUpperCase()} ·{" "}
                  {networkLabel(preview.wallet.network)}
                </strong>
              </div>
              <div>
                <span>Review</span>
                <strong>
                  {reviewExpired
                    ? "Expired · refresh before paying"
                    : "Bound to this identity and wallet"}
                </strong>
              </div>
            </div>
          )}
          {paymentError && (
            <div className="form-error" role="alert">
              <WarningCircle size={19} />
              <span>{paymentError}</span>
            </div>
          )}
          {!paymentSettled && (
            <PrivacyNote>
              {payment.attempted
                ? "Recovery details are encrypted for your identity. Checking status cannot send another payment."
                : "Confirmation uses this reviewed invoice and wallet. Payment is marked paid only after a verified result."}
            </PrivacyNote>
          )}
          {paymentSettled ? (
            <>
              <button
                className="button button-primary button-full"
                onClick={() => {
                  setPayment(null);
                  setPreview(null);
                  setPaymentResult(null);
                }}
              >
                {payment.peer ? "Keep chatting" : "Done"}{" "}
                <ArrowRight size={18} />
              </button>
              {payment.peer && paymentResult?.preimage && (
                <button
                  className="button button-secondary button-full"
                  onClick={() =>
                    void shareVerifiedReceipt(payment, paymentResult.preimage!)
                      .then(() =>
                        notify(
                          "Verified payment receipt is available in this conversation.",
                        ),
                      )
                      .catch((err) => {
                        if (!isCancelled(err))
                          setPaymentError(errorMessage(err));
                      })
                  }
                >
                  <ShieldCheck size={18} /> Publish verified receipt
                </button>
              )}
            </>
          ) : payment.attempted ? (
            <button
              className="button button-primary button-full"
              onClick={() => void recoverPayment(payment)}
              disabled={paymentBusy}
            >
              {paymentBusy ? <Spinner /> : <ArrowClockwise size={18} />}
              {paymentBusy
                ? "Checking payment…"
                : "Check wallet payment status"}
            </button>
          ) : preview && !reviewExpired ? (
            <button
              className="button button-primary button-full"
              onClick={() => void confirmPayment()}
              disabled={paymentBusy || paymentLoading}
            >
              {paymentBusy ? <Spinner /> : <Lightning size={18} />}
              {paymentBusy
                ? "Confirming payment…"
                : "Confirm " +
                  nf.format(payment.invoice.amountSats) +
                  "-sat payment"}
            </button>
          ) : (
            <button
              className="button button-secondary button-full"
              onClick={() => setReviewRefresh((value) => value + 1)}
              disabled={paymentLoading || paymentBusy}
            >
              {paymentLoading ? <Spinner /> : <ArrowClockwise size={18} />}
              Refresh payment review
            </button>
          )}
          {!paymentBusy &&
            !paymentSettled &&
            paymentError &&
            !payment.attempted && (
              <button
                className="button button-secondary button-full"
                onClick={() => {
                  setPayment(null);
                  openWallet("send");
                }}
              >
                <Wallet size={18} />
                Open wallet connection
              </button>
            )}
          {!paymentBusy && !paymentSettled && (
            <button
              className="button button-quiet button-full"
              onClick={() => {
                setPayment(null);
                setPreview(null);
                setPaymentResult(null);
              }}
            >
              Return to conversation
            </button>
          )}
        </Modal>
      )}
      {notice && (
        <div className="toast" role="status">
          <CheckCircle size={19} />
          <span>{notice}</span>
          <IconButton
            label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={17} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
