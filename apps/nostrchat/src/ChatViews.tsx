import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle,
  ChatsCircle,
  Copy,
  Lightning,
  LockKey,
  MagnifyingGlass,
  PaperPlaneTilt,
  PencilSimple,
  Plus,
  ShieldCheck,
  Wallet,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { nip19 } from "nostr-tools";
import {
  invoiceScopeKey,
  publicKeyLabel,
  type ChatMessage,
  type Identity,
  type InvoicePayload,
} from "./protocol";
import type { Contact, PaymentRecoveryRecord } from "./storage";
import type { InvoiceStatus, WalletState } from "./uiTypes";
import {
  Avatar,
  ConversationArt,
  IconButton,
  Spinner,
  formatDate,
  formatTime,
  numberFormat as nf,
} from "./ui";

export function Landing({
  onConnect,
  onCreate,
  onHelp,
  relayState,
}: {
  onConnect(): void;
  onCreate(): void;
  onHelp(): void;
  relayState: string;
}) {
  return (
    <main className="landing" id="main-content">
      <div className="landing-hero">
        <div className="landing-copy">
          <span className="eyebrow">
            <span className="eyebrow-dot" />A LITTLE MORE HUMAN. A LOT MORE
            YOURS.
          </span>
          <h1>
            Your people.
            <br />
            Your conversations.
            <br />
            <span>Your sats.</span>
          </h1>
          <p>
            Private messages and Lightning payments.
            <br className="desktop-break" /> Together, in one thoughtful little
            space.
          </p>
          <div className="landing-actions">
            <button className="button button-primary" onClick={onConnect}>
              Connect your identity <ArrowRight size={20} />
            </button>
            <button className="button button-secondary" onClick={onCreate}>
              Create a private key
            </button>
          </div>
          <button className="text-button landing-how" onClick={onHelp}>
            A note on how it works <ArrowUpRight size={16} />
          </button>
          <div className="landing-privacy">
            <ShieldCheck size={19} />
            <span>Encrypted before it leaves your device.</span>
          </div>
        </div>
        <div className="landing-visual">
          <ConversationArt />
          <div className="art-caption">
            <span>
              Good conversations.
              <br />
              <strong>More possibilities.</strong>
            </span>
            <span className="caption-lock">
              <LockKey size={19} />
              Just between you.
            </span>
          </div>
        </div>
      </div>
      <div className="landing-features">
        <article>
          <span className="small-feature-icon">
            <ChatsCircle size={24} />
          </span>
          <div>
            <h2>Messages, made private.</h2>
            <p>
              Talk one-to-one using your own Nostr identity. Your relay holds
              encrypted envelopes.
            </p>
          </div>
        </article>
        <article>
          <span className="small-feature-icon coral">
            <Lightning size={24} />
          </span>
          <div>
            <h2>Payments, in the conversation.</h2>
            <p>
              Request sats, review an invoice, and keep a verified payment
              receipt in context.
            </p>
          </div>
        </article>
        <article>
          <span className="small-feature-icon">
            <Wallet size={24} />
          </span>
          <div>
            <h2>Your wallet comes with you.</h2>
            <p>
              Connect an NWC wallet. Choose its permissions and confirm each
              payment yourself.
            </p>
          </div>
        </article>
      </div>
      <footer className="landing-footer">
        <span>Nostr connects us. Bitcoin moves with us.</span>
        <span>
          <span
            className={
              "status-dot " + (relayState === "connected" ? "online" : "")
            }
          />
          {relayState === "connected"
            ? "Relay available"
            : relayState === "connecting"
              ? "Connecting to your relay"
              : "Choose or reconnect your relay in Settings"}
        </span>
      </footer>
    </main>
  );
}

export function EmptyThread({
  identity,
  wallet,
  onNew,
  onCopy,
  onWallet,
}: {
  identity: Identity;
  wallet: WalletState | null;
  onNew(): void;
  onCopy(value: string): Promise<void>;
  onWallet(): void;
}) {
  return (
    <div className="empty-thread">
      <div className="empty-thread-art">
        <ConversationArt small />
      </div>
      <span className="eyebrow">YOU’RE IN GOOD COMPANY</span>
      <h2>
        A little space
        <br />
        for your people.
      </h2>
      <p>
        Add someone’s public key, say hello,
        <br className="desktop-break" /> and keep the conversation going.
      </p>
      <button className="button button-primary" onClick={onNew}>
        <Plus size={18} /> Start a conversation
      </button>
      <div className="empty-thread-actions">
        <button
          className="text-button"
          onClick={() => void onCopy(nip19.npubEncode(identity.pubkey))}
        >
          <Copy size={17} /> Copy my public key
        </button>
        <button className="text-button" onClick={onWallet}>
          <Lightning size={17} />
          {wallet?.connected ? "Open my wallet" : "Connect my wallet"}
        </button>
      </div>
      <span className="empty-thread-note">
        <LockKey size={15} />
        Your identity is connected. Your next conversation is yours.
      </span>
    </div>
  );
}

export function Inbox({
  identity,
  contacts,
  allMessages,
  selected,
  query,
  onQuery,
  filter,
  onFilter,
  onSelect,
  onNew,
  onCopy,
  loading,
}: {
  identity: Identity;
  contacts: Contact[];
  allMessages: ChatMessage[];
  selected: string | null;
  query: string;
  onQuery(value: string): void;
  filter: "all" | "invoices";
  onFilter(value: "all" | "invoices"): void;
  onSelect(pubkey: string): void;
  onNew(): void;
  onCopy(value: string): Promise<void>;
  loading: boolean;
}) {
  const visible = [...contacts]
    .filter((person) => {
      const messages = allMessages.filter(
        (message) =>
          message.sender === person.pubkey ||
          message.recipient === person.pubkey,
      );
      if (
        filter === "invoices" &&
        !messages.some((message) => message.payload.type === "invoice")
      )
        return false;
      return (
        person.name +
        " " +
        person.pubkey +
        " " +
        nip19.npubEncode(person.pubkey) +
        " " +
        messages
          .map((message) =>
            message.payload.type === "text"
              ? message.payload.text
              : message.payload.type === "invoice"
                ? message.payload.description
                : "",
          )
          .join(" ")
      )
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    })
    .sort(
      (a, b) =>
        (allMessages
          .filter(
            (message) =>
              message.sender === b.pubkey || message.recipient === b.pubkey,
          )
          .at(-1)?.createdAt || 0) -
          (allMessages
            .filter(
              (message) =>
                message.sender === a.pubkey || message.recipient === a.pubkey,
            )
            .at(-1)?.createdAt || 0) || a.name.localeCompare(b.name),
    );
  return (
    <section className="inbox-pane" aria-label="Conversations">
      <div className="inbox-top">
        <label className="search-field">
          <MagnifyingGlass size={19} />
          <input
            type="search"
            placeholder="Search your conversations"
            aria-label="Search conversations"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <div className="inbox-filters" aria-label="Conversation filter">
          <button
            className={filter === "all" ? "selected" : ""}
            aria-pressed={filter === "all"}
            onClick={() => onFilter("all")}
          >
            All conversations <span>{contacts.length}</span>
          </button>
          <button
            className={filter === "invoices" ? "selected" : ""}
            aria-pressed={filter === "invoices"}
            onClick={() => onFilter("invoices")}
          >
            With invoices
          </button>
        </div>
      </div>
      <div className="conversation-list">
        {visible.map((person) => {
          const latest = allMessages
            .filter(
              (message) =>
                message.sender === person.pubkey ||
                message.recipient === person.pubkey,
            )
            .at(-1);
          return (
            <button
              className={
                "conversation-row " +
                (person.pubkey === selected ? "selected" : "")
              }
              aria-current={person.pubkey === selected ? "true" : undefined}
              key={person.pubkey}
              onClick={() => onSelect(person.pubkey)}
            >
              <Avatar name={person.name} color={person.color} />
              <div className="conversation-row-content">
                <div>
                  <strong>{person.name}</strong>
                  {latest && (
                    <time dateTime={new Date(latest.createdAt).toISOString()}>
                      {new Date(latest.createdAt).toDateString() ===
                      new Date().toDateString()
                        ? formatTime(latest.createdAt)
                        : formatDate(latest.createdAt)}
                    </time>
                  )}
                </div>
                <p>
                  {latest
                    ? latest.payload.type === "text"
                      ? (latest.sender === identity.pubkey ? "You: " : "") +
                        latest.payload.text
                      : latest.payload.type === "invoice"
                        ? nf.format(latest.payload.amountSats) +
                          " sats requested"
                        : "Payment proof shared"
                    : "Say hello. Keep it private."}
                </p>
              </div>
              {latest?.state === "failed" && (
                <WarningCircle
                  size={17}
                  className="row-warning"
                  aria-label="Message publication failed"
                />
              )}
            </button>
          );
        })}
        {!visible.length && (
          <div className="inbox-empty">
            <span className="small-feature-icon">
              <ChatsCircle size={27} />
            </span>
            <h3>
              {query
                ? "A fresh search, perhaps?"
                : filter === "invoices"
                  ? "No payment requests yet."
                  : "Good people belong here."}
            </h3>
            <p>
              {query
                ? "Try a name, public key, or a word from a decrypted message."
                : filter === "invoices"
                  ? "Invoices shared in your chats will appear in this filter."
                  : "Start with a public key. A private conversation follows."}
            </p>
            {query || filter !== "all" ? (
              <button
                className="text-button"
                onClick={() => {
                  onQuery("");
                  onFilter("all");
                }}
              >
                Show all conversations <ArrowRight size={16} />
              </button>
            ) : (
              <button className="text-button" onClick={onNew}>
                Add your first contact <ArrowRight size={16} />
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="inbox-footer">
        {loading ? (
          <Spinner label="Opening encrypted history…" />
        ) : (
          <>
            <LockKey size={15} />
            <span>Search stays in this browser.</span>
          </>
        )}
        <button
          className="icon-button"
          aria-label="Copy your public key"
          title="Copy your public key"
          onClick={() => void onCopy(nip19.npubEncode(identity.pubkey))}
        >
          <Copy size={18} />
        </button>
      </footer>
    </section>
  );
}

function InvoiceCard({
  message,
  identity,
  status,
  checking,
  attempted,
  onCheck,
  onReview,
  onCopy,
}: {
  message: ChatMessage;
  identity: Identity;
  status?: InvoiceStatus;
  checking: boolean;
  attempted: boolean;
  onCheck(message: ChatMessage): void;
  onReview(message: ChatMessage): void;
  onCopy(value: string): Promise<void>;
}) {
  const invoice = message.payload as InvoicePayload;
  const own = message.sender === identity.pubkey;
  const state =
    status?.state === "settled"
      ? "settled"
      : invoice.expiresAt <= Date.now()
        ? "expired"
        : status?.state || "pending";
  return (
    <div
      className={
        "invoice-card " + (state === "settled" ? "invoice-card--paid" : "")
      }
    >
      <div className="invoice-header">
        <span className="invoice-icon">
          <Lightning size={21} weight="fill" />
        </span>
        <span>LIGHTNING REQUEST</span>
        <span className={"invoice-status " + state}>
          {state === "settled" ? (
            <>
              <CheckCircle size={14} /> Paid
            </>
          ) : state === "expired" ? (
            "Expired"
          ) : attempted ? (
            "Check status"
          ) : (
            "Pending"
          )}
        </span>
      </div>
      <strong className="invoice-amount">
        {nf.format(invoice.amountSats)}
        <span>sats</span>
      </strong>
      <p className="invoice-description">
        {invoice.description || "Description unavailable"}
      </p>
      <div className="invoice-meta">
        <span>
          {invoice.paymentHash.slice(0, 9) +
            "…" +
            invoice.paymentHash.slice(-6)}
        </span>
        <IconButton
          label="Copy Lightning invoice"
          onClick={() => void onCopy(invoice.bolt11)}
        >
          <Copy size={17} />
        </IconButton>
      </div>
      {state === "settled" ? (
        <>
          <div className="invoice-proof">
            <ShieldCheck size={17} />
            <span>
              {status?.source === "proof"
                ? "Payment preimage verified"
                : "Confirmed by your wallet"}
            </span>
          </div>
          {own && status?.source === "proof" && (
            <button
              className="button button-invoice button-full"
              onClick={() => onCheck(message)}
              disabled={checking}
            >
              {checking ? <Spinner /> : <ArrowClockwise size={17} />}
              {checking
                ? "Verifying with your wallet…"
                : "Verify with my wallet"}
            </button>
          )}
        </>
      ) : own ? (
        <button
          className="button button-invoice button-full"
          onClick={() => onCheck(message)}
          disabled={checking}
        >
          {checking ? <Spinner /> : <ArrowClockwise size={17} />}
          {checking ? "Checking payment…" : "Check payment"}
        </button>
      ) : (
        <>
          <button
            className="button button-primary button-full"
            onClick={() => onReview(message)}
            disabled={checking || (state === "expired" && !attempted)}
          >
            {attempted ? <ArrowClockwise size={17} /> : <Lightning size={17} />}
            {attempted
              ? "Recover payment status"
              : state === "expired"
                ? "Invoice expired"
                : "Review payment"}
          </button>
          <button
            className="button button-quiet button-full invoice-check"
            onClick={() => onCheck(message)}
            disabled={checking}
          >
            {checking ? <Spinner /> : <ArrowClockwise size={16} />} Check wallet
            status
          </button>
        </>
      )}
      <footer>
        <span>{own ? "Requested by you" : "Shared privately with you"}</span>
        <time dateTime={new Date(invoice.expiresAt).toISOString()}>
          {state === "expired" ? "Expired " : "Expires "}
          {formatDate(invoice.expiresAt)} · {formatTime(invoice.expiresAt)}
        </time>
      </footer>
    </div>
  );
}

export function Thread({
  identity,
  contact,
  messages,
  draft,
  onDraft,
  onSend,
  sending,
  canSend,
  offline,
  loading,
  error,
  onDismissError,
  onBack,
  onEdit,
  onWallet,
  onHelp,
  onCopy,
  statuses,
  checking,
  attempts,
  onCheckInvoice,
  onReviewInvoice,
  onRetry,
  retryable,
  receiptStates,
}: {
  identity: Identity;
  contact: Contact;
  messages: ChatMessage[];
  draft: string;
  onDraft(value: string): void;
  onSend(event?: FormEvent): void;
  sending: boolean;
  canSend: boolean;
  offline: boolean;
  loading: boolean;
  error: string;
  onDismissError(): void;
  onBack(): void;
  onEdit(): void;
  onWallet(): void;
  onHelp(): void;
  onCopy(value: string): Promise<void>;
  statuses: Record<string, InvoiceStatus>;
  checking: string;
  attempts: Set<string>;
  onCheckInvoice(message: ChatMessage): void;
  onReviewInvoice(message: ChatMessage): void;
  onRetry(message: ChatMessage): void;
  retryable: Set<string>;
  receiptStates: Record<string, "verified" | "unverified">;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    stick.current = true;
    setShowJump(false);
    bottom.current?.scrollIntoView({ block: "end" });
  }, [contact.pubkey]);
  useEffect(() => {
    if (stick.current)
      bottom.current?.scrollIntoView({
        block: "end",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
  }, [messages.length]);
  useEffect(() => {
    if (composer.current) {
      composer.current.style.height = "44px";
      composer.current.style.height =
        Math.min(140, composer.current.scrollHeight) + "px";
    }
  }, [draft]);
  return (
    <section
      className="thread-pane"
      aria-label={"Conversation with " + contact.name}
    >
      <header className="thread-header">
        <IconButton
          label="Back to conversations"
          className="thread-back"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </IconButton>
        <button
          className="thread-person"
          onClick={onEdit}
          aria-label={"Edit contact " + contact.name}
        >
          <Avatar name={contact.name} color={contact.color} />
          <span>
            <strong>{contact.name}</strong>
            <small>{publicKeyLabel(contact.pubkey)}</small>
          </span>
        </button>
        <div className="thread-actions">
          <button
            className="button button-secondary button-small"
            onClick={onWallet}
            title="Request sats"
          >
            <Lightning size={18} />
            <span>Request sats</span>
          </button>
          <IconButton label="Contact details" onClick={onEdit}>
            <PencilSimple size={19} />
          </IconButton>
        </div>
      </header>
      <div className="thread-privacy">
        <LockKey size={15} />
        <span>Encrypted for you and {contact.name.split(" ")[0]}.</span>
        <button onClick={onHelp}>
          About privacy <ArrowUpRight size={13} />
        </button>
      </div>
      <div
        className="message-scroll"
        ref={scroll}
        role="log"
        aria-label={"Messages with " + contact.name}
        aria-live={loading ? "off" : "polite"}
        aria-relevant="additions"
        aria-busy={loading}
        onScroll={() => {
          const element = scroll.current;
          if (element) {
            stick.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              100;
            setShowJump(!stick.current);
          }
        }}
      >
        {loading && (
          <div className="history-loading">
            <Spinner label="Decrypting your history…" />
          </div>
        )}
        {!loading && !messages.length && (
          <div className="conversation-start">
            <Avatar name={contact.name} color={contact.color} size="large" />
            <h3>This is the beginning.</h3>
            <p>
              Say hello to {contact.name.split(" ")[0]}.<br />
              Your conversation starts with a message.
            </p>
            <span className="private-pill">
              <LockKey size={14} />
              Only you two can read it.
            </span>
          </div>
        )}
        {messages.map((message, index) => {
          const own = message.sender === identity.pubkey,
            type = message.payload.type;
          const showDate =
            index === 0 ||
            new Date(message.createdAt).toDateString() !==
              new Date(messages[index - 1].createdAt).toDateString();
          const peer = own ? message.recipient : message.sender;
          const scope =
            type === "invoice"
              ? invoiceScopeKey(identity.pubkey, peer, message)
              : "";
          return (
            <div key={message.id}>
              {showDate && (
                <div className="date-divider">
                  <span>
                    {new Date(message.createdAt).toDateString() ===
                    new Date().toDateString()
                      ? "Today"
                      : formatDate(message.createdAt)}
                  </span>
                </div>
              )}
              <div
                className={
                  "message-row " +
                  (own ? "message-row--own" : "") +
                  (type !== "text" ? " message-row--structured" : "")
                }
              >
                <div className="message-content">
                  {type === "text" ? (
                    <div className="message-bubble">
                      <p>
                        {message.payload.type === "text"
                          ? message.payload.text
                          : ""}
                      </p>
                    </div>
                  ) : type === "invoice" ? (
                    <InvoiceCard
                      message={message}
                      identity={identity}
                      status={statuses[scope]}
                      checking={checking === scope}
                      attempted={attempts.has(scope)}
                      onCheck={onCheckInvoice}
                      onReview={onReviewInvoice}
                      onCopy={onCopy}
                    />
                  ) : (
                    <div
                      className={
                        "receipt-card " +
                        (receiptStates[message.id] === "verified"
                          ? "receipt-card--verified"
                          : "")
                      }
                    >
                      {receiptStates[message.id] === "verified" ? (
                        <ShieldCheck size={20} />
                      ) : (
                        <WarningCircle size={20} />
                      )}
                      <div>
                        <strong>
                          {receiptStates[message.id] === "verified"
                            ? "Payment proof verified"
                            : "Payment claim · not verified"}
                        </strong>
                        <span>
                          {receiptStates[message.id] === "verified"
                            ? "The preimage matches this conversation’s invoice."
                            : "A claim alone does not mark an invoice paid."}
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="message-caption">
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {formatTime(message.createdAt)}
                    </time>
                    {own && (
                      <span
                        className={
                          "message-delivery " +
                          (message.state === "failed"
                            ? "message-delivery--failed"
                            : "")
                        }
                        title="Published means the relay acknowledged the encrypted envelope. It does not indicate that your contact read it."
                      >
                        {message.state === "publishing" ? (
                          <>
                            <Spinner />
                            Publishing…
                          </>
                        ) : message.state === "failed" ? (
                          <>
                            <WarningCircle size={13} />
                            Not published
                          </>
                        ) : (
                          <>
                            <Check size={14} />
                            Published
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  {own && message.state === "failed" && (
                    <div className="message-failure">
                      <span>
                        {message.error ||
                          "The relay did not acknowledge this envelope."}
                      </span>
                      {retryable.has(message.id) && (
                        <button
                          onClick={() => onRetry(message)}
                          className="text-button"
                        >
                          <ArrowClockwise size={15} /> Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {showJump && (
        <button
          className="jump-button"
          onClick={() => {
            stick.current = true;
            setShowJump(false);
            bottom.current?.scrollIntoView({
              block: "end",
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth",
            });
          }}
        >
          <ArrowDown size={17} />
          Jump to latest
        </button>
      )}
      {error && (
        <div className="chat-error" role="alert">
          <WarningCircle size={18} />
          <span>{error}</span>
          <IconButton label="Dismiss chat error" onClick={onDismissError}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      <form className="composer" onSubmit={onSend}>
        <IconButton
          label="Create a Lightning payment request"
          onClick={onWallet}
        >
          <Lightning size={21} />
        </IconButton>
        <textarea
          ref={composer}
          rows={1}
          aria-label={"Message " + contact.name}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          maxLength={4000}
          placeholder={"Message " + contact.name.split(" ")[0] + "…"}
          disabled={sending}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button
          type="submit"
          className="send-button"
          aria-label="Send encrypted message"
          title={
            offline ? "Reconnect your relay to send" : "Send encrypted message"
          }
          disabled={!draft.trim() || !canSend || sending}
        >
          {sending ? <Spinner /> : <PaperPlaneTilt size={21} weight="fill" />}
        </button>
      </form>
      <footer className="composer-footer">
        <span>
          <LockKey size={13} />
          {offline
            ? "Draft stays here while your relay reconnects."
            : "Encrypted before publication."}
        </span>
        <span>Enter to send · Shift + Enter for a new line</span>
      </footer>
    </section>
  );
}

export function People({
  identity,
  contacts,
  query,
  onQuery,
  onNew,
  onSelect,
  onEdit,
  onCopy,
}: {
  identity: Identity;
  contacts: Contact[];
  query: string;
  onQuery(value: string): void;
  onNew(): void;
  onSelect(pubkey: string): void;
  onEdit(contact: Contact): void;
  onCopy(value: string): Promise<void>;
}) {
  const visible = contacts
    .filter((contact) =>
      (
        contact.name +
        " " +
        contact.note +
        " " +
        contact.pubkey +
        " " +
        nip19.npubEncode(contact.pubkey)
      )
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="people-page">
      <div className="people-toolbar">
        <label className="search-field">
          <MagnifyingGlass size={19} />
          <input
            type="search"
            aria-label="Search contacts"
            placeholder="Find a person"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <span>
          {contacts.length + (contacts.length === 1 ? " person" : " people")} in
          your private address book
        </span>
      </div>
      {visible.length ? (
        <div className="people-grid">
          {visible.map((contact) => (
            <article className="person-card" key={contact.pubkey}>
              <div className="person-card-top">
                <Avatar
                  name={contact.name}
                  color={contact.color}
                  size="large"
                />
                <IconButton
                  label={"Edit " + contact.name}
                  onClick={() => onEdit(contact)}
                >
                  <PencilSimple size={19} />
                </IconButton>
              </div>
              <h2>{contact.name}</h2>
              <button
                className="person-key"
                onClick={() => void onCopy(nip19.npubEncode(contact.pubkey))}
              >
                {publicKeyLabel(contact.pubkey)}
                <Copy size={16} />
              </button>
              <p>
                {contact.note ||
                  "A private conversation is a good place to start."}
              </p>
              <button
                className="button button-secondary button-full"
                onClick={() => onSelect(contact.pubkey)}
              >
                <ChatsCircle size={18} />
                Open conversation <ArrowRight size={17} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="page-empty">
          <span className="large-feature-icon">
            <ChatsCircle size={32} />
          </span>
          <h2>
            {query ? "No familiar names here yet." : "Keep your people close."}
          </h2>
          <p>
            {query
              ? "Try another name or public key."
              : "Add a public key and a name you know. Your private address book belongs to you."}
          </p>
          <button
            className="button button-primary"
            onClick={query ? () => onQuery("") : onNew}
          >
            {query ? "Clear search" : "Add your first contact"}
            <ArrowRight size={18} />
          </button>
          {!query && (
            <button
              className="text-button"
              onClick={() => void onCopy(nip19.npubEncode(identity.pubkey))}
            >
              <Copy size={17} />
              Copy my public key to share
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Activity({
  identity,
  messages,
  contacts,
  statuses,
  filter,
  onFilter,
  onView,
  onCheck,
  checking,
  onWallet,
  recovery,
  onRecover,
}: {
  identity: Identity;
  messages: ChatMessage[];
  contacts: Contact[];
  statuses: Record<string, InvoiceStatus>;
  filter: "all" | "pending" | "settled";
  onFilter(value: "all" | "pending" | "settled"): void;
  onView(peer: string): void;
  onCheck(message: ChatMessage): void;
  checking: string;
  onWallet(): void;
  recovery: PaymentRecoveryRecord[];
  onRecover(record: PaymentRecoveryRecord): void;
}) {
  const invoices = messages
    .filter((message) => message.payload.type === "invoice")
    .reverse();
  const standalone = recovery
    .filter((record) => record.standalone && record.peer === identity.pubkey)
    .sort((a, b) => b.attemptedAt - a.attemptedAt);
  const visibleStandalone = standalone.filter(
    (record) =>
      filter === "all" ||
      (filter === "settled"
        ? record.state === "confirmed"
        : record.state !== "confirmed"),
  );
  const visible = invoices.filter((message) => {
    const peer =
      message.sender === identity.pubkey ? message.recipient : message.sender;
    const settled =
      statuses[invoiceScopeKey(identity.pubkey, peer, message)]?.state ===
      "settled";
    return filter === "all" || filter === "settled"
      ? filter === "all" || settled
      : !settled;
  });
  return (
    <div className="activity-page">
      <div className="activity-intro">
        <span className="small-feature-icon coral">
          <Lightning size={24} />
        </span>
        <div>
          <h2>Every request has a conversation.</h2>
          <p>
            These are the actual invoices in your decrypted chat history. A paid
            label requires a verified wallet result or matching preimage.
          </p>
        </div>
      </div>
      <div className="activity-filters" aria-label="Payment activity filter">
        {(["all", "pending", "settled"] as const).map((value) => (
          <button
            className={filter === value ? "selected" : ""}
            aria-pressed={filter === value}
            key={value}
            onClick={() => onFilter(value)}
          >
            {value === "all"
              ? "All requests"
              : value === "pending"
                ? "Unsettled"
                : "Verified paid"}
          </button>
        ))}
      </div>
      {visible.length ? (
        <div className="activity-list">
          <div className="activity-table-head">
            <span>Conversation & purpose</span>
            <span>Amount</span>
            <span>Status</span>
            <span>Check</span>
          </div>
          {visible.map((message) => {
            const invoice = message.payload as InvoicePayload,
              own = message.sender === identity.pubkey,
              peer = own ? message.recipient : message.sender;
            const person = contacts.find((contact) => contact.pubkey === peer),
              name = person?.name || publicKeyLabel(peer);
            const scope = invoiceScopeKey(identity.pubkey, peer, message),
              status = statuses[scope],
              state =
                status?.state === "settled"
                  ? "settled"
                  : invoice.expiresAt <= Date.now()
                    ? "expired"
                    : "pending";
            return (
              <article className="activity-row" key={message.id}>
                <button
                  className="activity-person"
                  onClick={() => onView(peer)}
                >
                  <Avatar name={name} color={person?.color} />
                  <span>
                    <strong>
                      {name}
                      <small>
                        {own ? "You requested" : "Requested from you"}
                      </small>
                    </strong>
                    <span>
                      {invoice.description || "Description unavailable"} ·{" "}
                      {formatDate(message.createdAt)}
                    </span>
                  </span>
                </button>
                <strong className="activity-amount">
                  {nf.format(invoice.amountSats)} <span>sats</span>
                </strong>
                <span className={"activity-status " + state}>
                  {state === "settled" ? (
                    <>
                      <ShieldCheck size={15} />
                      Verified paid
                    </>
                  ) : state === "expired" ? (
                    "Expired"
                  ) : (
                    "Unsettled"
                  )}
                </span>
                <IconButton
                  label={"Check payment status for " + invoice.description}
                  onClick={() => onCheck(message)}
                  disabled={checking === scope}
                >
                  {checking === scope ? (
                    <Spinner />
                  ) : (
                    <ArrowClockwise size={19} />
                  )}
                </IconButton>
              </article>
            );
          })}
        </div>
      ) : visibleStandalone.length ? null : (
        <div className="page-empty">
          <span className="large-feature-icon coral">
            <Lightning size={32} />
          </span>
          <h2>
            {invoices.length
              ? "Nothing in this view."
              : "Small payments. Full context."}
          </h2>
          <p>
            {invoices.length
              ? "Try another filter to see your conversation invoices."
              : "Create an invoice with your wallet and share it inside a private conversation."}
          </p>
          <button
            className="button button-primary"
            onClick={invoices.length ? () => onFilter("all") : onWallet}
          >
            {invoices.length ? "Show all requests" : "Open my wallet"}
            <ArrowRight size={18} />
          </button>
        </div>
      )}
      {visibleStandalone.length > 0 && (
        <section className="standalone-activity">
          <h2>Direct wallet payments</h2>
          <p>
            Saved encrypted payment attempts from pasted invoices. Status checks
            remain available after an invoice expires.
          </p>
          <div className="standalone-list">
            {visibleStandalone.map((record) => (
              <article key={record.invoiceId} className="standalone-row">
                <span className="small-feature-icon coral">
                  <Wallet size={21} />
                </span>
                <div>
                  <strong>
                    {record.invoice.description || "Description unavailable"}
                  </strong>
                  <span>
                    {formatDate(record.attemptedAt)} ·{" "}
                    {record.state === "confirmed"
                      ? "Matching preimage verified"
                      : "Payment result needs reconciliation"}
                  </span>
                </div>
                <strong>
                  {nf.format(record.invoice.amountSats)} <small>sats</small>
                </strong>
                <button
                  className="button button-secondary button-small"
                  onClick={() => onRecover(record)}
                >
                  {record.state === "confirmed" ? (
                    <ShieldCheck size={17} />
                  ) : (
                    <ArrowClockwise size={17} />
                  )}
                  {record.state === "confirmed"
                    ? "View receipt"
                    : "Check status"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="activity-note">
        <LockKey size={16} />
        Invoice details are decrypted in this browser. Relay acknowledgements
        describe publication, not payment.
      </div>
    </div>
  );
}
