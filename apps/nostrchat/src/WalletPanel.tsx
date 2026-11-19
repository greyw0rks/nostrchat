import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  Copy,
  Lightning,
  LockKey,
  PaperPlaneTilt,
  ShieldCheck,
  SignOut,
  Wallet,
  WarningCircle,
} from "@phosphor-icons/react";
import QRCode from "qrcode";
import { inspectInvoice, parsePayload, type InvoicePayload } from "./protocol";
import type { Contact } from "./storage";
import type { AccountRequest, VerifiedInvoice, WalletState } from "./uiTypes";
import {
  IconButton,
  Modal,
  PrivacyNote,
  Spinner,
  errorMessage,
  isCancelled,
  numberFormat as nf,
} from "./ui";

export function WalletPanel({
  contact,
  request,
  onClose,
  onWallet,
  onNotice,
  onCopy,
  onShare,
  onReview,
  initialTab = "receive",
  generated,
  onGenerated,
  practiceWallets = false,
}: {
  contact?: Contact;
  request: AccountRequest;
  onClose(): void;
  onWallet(value: WalletState): void;
  onNotice(value: string): void;
  onCopy(value: string): Promise<void>;
  onShare(invoice: InvoicePayload, peer: string): Promise<void>;
  onReview(invoice: InvoicePayload): void;
  initialTab?: "receive" | "send";
  generated: VerifiedInvoice | null;
  onGenerated(value: VerifiedInvoice | null): void;
  practiceWallets?: boolean;
}) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uri, setUri] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [paste, setPaste] = useState("");
  const [tab, setTab] = useState(initialTab);
  const [error, setError] = useState("");
  const [qr, setQr] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const controller = useRef(new AbortController());
  const refreshGeneration = useRef(0);
  const current = () => !controller.current.signal.aborted;
  const signal = () => controller.current.signal;
  async function refresh() {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setError("");
    try {
      const value = await request<WalletState>(
        "/api/chat/wallet",
        undefined,
        "GET",
        signal(),
      );
      if (current() && generation === refreshGeneration.current) {
        setWallet(value);
        onWallet(value);
        if (value.error) setError(value.error);
      }
    } catch (err) {
      if (
        current() &&
        !isCancelled(err) &&
        generation === refreshGeneration.current
      )
        setError(errorMessage(err));
    } finally {
      if (current() && generation === refreshGeneration.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    controller.current = new AbortController();
    void refresh();
    return () => {
      controller.current.abort();
      refreshGeneration.current++;
    };
  }, [request]);
  useEffect(() => {
    let stopped = false;
    setQr("");
    if (generated)
      void QRCode.toDataURL(generated.bolt11, {
        width: 256,
        margin: 2,
        color: { dark: "#174f47", light: "#ffffff" },
      })
        .then((value) => {
          if (!stopped) setQr(value);
        })
        .catch(() => {
          /* The invoice remains available as selectable text. */
        });
    return () => {
      stopped = true;
    };
  }, [generated?.bolt11]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const connectionUri = uri.trim();
    try {
      if (!/^nostr(?:\+walletconnect|walletconnect):\/\//i.test(connectionUri))
        throw new Error(
          "Paste an NWC connection URI from your wallet provider.",
        );
      await request(
        "/api/chat/wallet/connect",
        { connectionUri },
        "POST",
        signal(),
      );
      if (!current()) return;
      setUri("");
      await refresh();
      if (current()) onNotice("Your Lightning wallet is connected.");
    } catch (err) {
      if (current() && !isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (current()) {
        setBusy(false);
        setUri("");
      }
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await request("/api/chat/wallet", undefined, "DELETE", signal());
      if (!current()) return;
      setWallet({ connected: false });
      onWallet({ connected: false });
      onGenerated(null);
      setDisconnecting(false);
      onNotice(
        "Wallet disconnected. You can revoke this connection in your wallet provider.",
      );
    } catch (err) {
      if (current() && !isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function connectPractice(wallet: "alice" | "bob") {
    setBusy(true);
    setError("");
    try {
      await request("/api/chat/wallet/practice", { wallet }, "POST", signal());
      if (!current()) return;
      await refresh();
      if (current())
        onNotice(
          "Regtest wallet connected. These practice sats have no monetary value.",
        );
    } catch (err) {
      if (current() && !isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function createInvoice(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const amountSats = Number(amount);
      if (
        !Number.isSafeInteger(amountSats) ||
        amountSats < 1 ||
        amountSats > 1_000_000
      )
        throw new Error("Choose a whole-sat amount between 1 and 1,000,000.");
      const value = await request<VerifiedInvoice>(
        "/api/chat/wallet/invoices",
        { amountSats, description: description.trim() || "NostrChat payment" },
        "POST",
        signal(),
      );
      const facts = inspectInvoice(value.bolt11);
      if (
        facts.paymentHash !== value.paymentHash ||
        facts.amountSats !== amountSats ||
        facts.amountSats !== value.amountSats ||
        facts.expiresAt !== value.expiresAt
      )
        throw new Error(
          "Your wallet returned an invoice with different details. Please check your wallet.",
        );
      if (current()) onGenerated(value);
    } catch (err) {
      if (current() && !isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function share() {
    if (!generated || !contact) return;
    setBusy(true);
    setError("");
    try {
      const facts = inspectInvoice(generated.bolt11);
      if (facts.expiresAt <= Date.now())
        throw new Error("This invoice has expired. Create a fresh request.");
      await onShare(
        {
          type: "invoice",
          bolt11: generated.bolt11,
          paymentHash: facts.paymentHash,
          amountSats: facts.amountSats,
          expiresAt: facts.expiresAt,
          description: generated.description,
        },
        contact.pubkey,
      );
      if (current()) {
        onNotice(
          `Payment request published to your conversation with ${contact.name}.`,
        );
        onGenerated(null);
        onClose();
      }
    } catch (err) {
      if (current() && !isCancelled(err)) setError(errorMessage(err));
    } finally {
      if (current()) setBusy(false);
    }
  }
  function reviewPaste() {
    setError("");
    try {
      const facts = inspectInvoice(paste.trim());
      if (facts.expiresAt <= Date.now())
        throw new Error(
          "This invoice has expired. Open its saved payment in Activity to check an earlier attempt, or ask for a new invoice.",
        );
      const invoice: InvoicePayload = {
        type: "invoice",
        bolt11: facts.bolt11,
        paymentHash: facts.paymentHash,
        amountSats: facts.amountSats,
        expiresAt: facts.expiresAt,
        description: facts.description ?? "",
        ...(facts.descriptionHash
          ? { descriptionHash: facts.descriptionHash }
          : {}),
      };
      parsePayload(JSON.stringify(invoice));
      onReview(invoice);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const canCreate = wallet?.capabilities?.includes("make_invoice");
  const canPay = wallet?.capabilities?.includes("pay_invoice");

  return (
    <Modal
      title="Sats, close at hand."
      eyebrow="YOUR LIGHTNING WALLET"
      onClose={onClose}
      drawer
    >
      <p className="dialog-intro">
        Bring your own wallet. Request a payment or review an invoice, right
        here.
      </p>
      <div className="wallet-balance">
        <span className="wallet-balance-icon">
          <Wallet size={26} />
        </span>
        <div>
          <span className="field-caption">AVAILABLE BALANCE</span>
          <strong>
            {loading
              ? "—"
              : wallet?.connected && typeof wallet.balanceSats === "number"
                ? nf.format(wallet.balanceSats)
                : "—"}
            <small>sats</small>
          </strong>
        </div>
        <IconButton
          label="Refresh wallet balance"
          onClick={() => void refresh()}
          disabled={loading || busy}
        >
          <ArrowClockwise size={20} />
        </IconButton>
        <footer>
          <span className={`status-dot ${wallet?.connected ? "online" : ""}`} />
          {loading
            ? "Checking your wallet"
            : wallet?.connected
              ? `${wallet.kind?.toUpperCase() || "NWC"} wallet connected${wallet.balanceSats === undefined ? " · balance unavailable" : ""}`
              : wallet
                ? "Connect a wallet to get started"
                : "Wallet status unavailable"}
        </footer>
      </div>
      {loading && (
        <div className="loading-line" role="status">
          <Spinner label="Checking your wallet connection…" />
        </div>
      )}
      {!loading && !wallet && (
        <div className="wallet-unavailable">
          <WarningCircle size={27} />
          <h3>Your wallet is out of reach.</h3>
          <p>
            Check your connection and try again. Your chat identity is still
            available.
          </p>
          <button
            className="button button-secondary button-full"
            onClick={() => void refresh()}
          >
            <ArrowClockwise size={18} /> Try again
          </button>
        </div>
      )}
      {!loading && wallet && !wallet.connected && (
        <>
          <div className="wallet-story">
            <span className="small-feature-icon">
              <ShieldCheck size={23} />
            </span>
            <h3>Your wallet, your permissions.</h3>
            <p>
              Create an NWC connection in your wallet. Choose the permissions
              and spending budget you are comfortable with.
            </p>
          </div>
          <form
            className="form-stack"
            onSubmit={(event) => void connect(event)}
          >
            <label>
              NWC connection URI
              <textarea
                data-autofocus
                value={uri}
                onChange={(event) => setUri(event.target.value)}
                rows={4}
                placeholder="nostr+walletconnect://…"
                maxLength={4000}
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy}
              />
            </label>
            <button
              className="button button-primary button-full"
              disabled={busy || !uri.trim()}
            >
              {busy ? <Spinner /> : <Wallet size={19} />}
              {busy ? "Connecting wallet…" : "Connect my wallet"}
            </button>
          </form>
          {practiceWallets && (
            <div className="practice-wallets">
              <span className="field-caption">
                LOCAL LIGHTNING LAB · NO MONETARY VALUE
              </span>
              <p>
                Connect an actual regtest wallet for a two-browser payment
                exercise.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void connectPractice("alice")}
                >
                  Connect Alice
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void connectPractice("bob")}
                >
                  Connect Bob
                </button>
              </div>
            </div>
          )}
          <PrivacyNote>
            Your delegated wallet connection is encrypted on the server. The URI
            is cleared from this form after use.
          </PrivacyNote>
        </>
      )}
      {!loading && wallet?.connected && (
        <>
          <div className="segmented wallet-tabs" aria-label="Wallet action">
            <button
              type="button"
              className={tab === "receive" ? "selected" : ""}
              aria-pressed={tab === "receive"}
              onClick={() => setTab("receive")}
              disabled={busy}
            >
              Request sats
            </button>
            <button
              type="button"
              className={tab === "send" ? "selected" : ""}
              aria-pressed={tab === "send"}
              onClick={() => setTab("send")}
              disabled={busy}
            >
              Pay invoice
            </button>
          </div>
          {tab === "receive" ? (
            <form
              className="form-stack"
              onSubmit={(event) => void createInvoice(event)}
            >
              <label>
                Amount in sats
                <div className="amount-input">
                  <input
                    data-autofocus
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0"
                    required
                    disabled={busy}
                  />
                  <span>SATS</span>
                </div>
              </label>
              <label>
                What’s it for?
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={120}
                  placeholder="e.g. Design review"
                  disabled={busy}
                />
              </label>
              <button
                className="button button-primary button-full"
                disabled={busy || !canCreate}
              >
                {busy ? <Spinner /> : <Lightning size={19} />}
                {busy ? "Creating your invoice…" : "Create Lightning invoice"}
              </button>
              {!canCreate && (
                <div className="permission-note">
                  <LockKey size={17} />
                  This wallet connection needs permission to create invoices.
                </div>
              )}
            </form>
          ) : (
            <div className="form-stack">
              <label>
                Lightning invoice
                <textarea
                  data-autofocus
                  value={paste}
                  onChange={(event) => setPaste(event.target.value)}
                  rows={4}
                  placeholder="lnbc…"
                  maxLength={12_000}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button
                className="button button-primary button-full"
                onClick={reviewPaste}
                disabled={!paste.trim() || !canPay}
              >
                Review payment <ArrowRight size={18} />
              </button>
              {!canPay && (
                <div className="permission-note">
                  <LockKey size={17} />
                  This wallet connection needs permission to pay invoices.
                </div>
              )}
              <PrivacyNote>
                You will review the fixed amount, network, and paying wallet
                before confirming. Pasted invoices are paid directly;
                conversation receipts belong to the original chat invoice.
              </PrivacyNote>
            </div>
          )}
          {generated && tab === "receive" && (
            <div className="generated-invoice">
              <div className="generated-heading">
                <CheckCircle size={19} />
                <span>Ready to share</span>
              </div>
              {qr ? (
                <img
                  src={qr}
                  alt={`Lightning invoice QR for ${nf.format(generated.amountSats)} sats`}
                  width={192}
                  height={192}
                />
              ) : (
                <div className="qr-placeholder" aria-hidden="true">
                  <Lightning size={32} />
                </div>
              )}
              <strong>
                {nf.format(generated.amountSats)} <span>sats</span>
              </strong>
              <p>{generated.description}</p>
              <textarea
                readOnly
                value={generated.bolt11}
                rows={2}
                spellCheck={false}
                aria-label="Generated Lightning invoice"
              />
              <button
                className="button button-secondary button-full"
                onClick={() => void onCopy(generated.bolt11)}
              >
                <Copy size={18} /> Copy invoice
              </button>
              <button
                className="button button-primary button-full"
                onClick={() => void share()}
                disabled={busy || !contact}
              >
                <PaperPlaneTilt size={18} />
                {contact
                  ? `Share with ${contact.name.split(" ")[0]}`
                  : "Open a chat to share this request"}
              </button>
            </div>
          )}
          <div className="wallet-permissions">
            <span className="field-caption">THIS CONNECTION CAN</span>
            <div>
              {wallet.capabilities?.length ? (
                wallet.capabilities.map((method) => (
                  <span key={method}>{method.replace(/_/g, " ")}</span>
                ))
              ) : (
                <span>Permissions unavailable</span>
              )}
            </div>
          </div>
          {disconnecting ? (
            <div className="disconnect-review">
              <p>Disconnect this wallet from NostrChat?</p>
              <div className="button-row">
                <button
                  className="button button-danger-quiet"
                  onClick={() => void disconnect()}
                  disabled={busy}
                >
                  {busy ? <Spinner /> : <SignOut size={17} />} Disconnect
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => setDisconnecting(false)}
                  disabled={busy}
                >
                  Keep connected
                </button>
              </div>
            </div>
          ) : (
            <button
              className="button button-danger-quiet button-full"
              onClick={() => setDisconnecting(true)}
              disabled={busy}
            >
              <SignOut size={17} /> Disconnect wallet
            </button>
          )}
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          <WarningCircle size={19} />
          {error}
        </div>
      )}
      <footer className="wallet-footer">
        <LockKey size={16} />
        Wallet actions use your connected provider.
      </footer>
    </Modal>
  );
}
