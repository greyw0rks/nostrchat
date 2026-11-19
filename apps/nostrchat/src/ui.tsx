import { useEffect, useId, useRef, type ReactNode } from "react";
import { CircleNotch, LockKey, X } from "@phosphor-icons/react";

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner">
      <CircleNotch size={18} className="spin" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = "",
  active = false,
}: {
  label: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className} ${active ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={active || undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Avatar({
  name,
  color = 0,
  size = "medium",
}: {
  name: string;
  color?: number;
  size?: "small" | "medium" | "large";
}) {
  const letters = name.startsWith("npub")
    ? "N"
    : name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "N";
  return (
    <span
      className={`avatar avatar--${Math.abs(color) % 5} avatar--${size}`}
      aria-hidden="true"
    >
      {letters}
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand-symbol" aria-hidden="true">
        n<span />
      </span>
      <span className="brand-name">
        nostrchat<span>.</span>
      </span>
    </span>
  );
}

export function Modal({
  title,
  eyebrow = "YOUR PRIVATE SPACE",
  children,
  onClose,
  wide = false,
  drawer = false,
  canClose = true,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
  drawer?: boolean;
  canClose?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const mayClose = useRef(canClose);
  close.current = onClose;
  mayClose.current = canClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const available = () =>
      [
        ...(panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
        ) || []),
      ].filter(
        (item) =>
          item.getClientRects().length > 0 &&
          item.getAttribute("aria-hidden") !== "true",
      );
    const frame = requestAnimationFrame(() =>
      (
        panel.current?.querySelector<HTMLElement>("[data-autofocus]") ||
        available()[0] ||
        panel.current
      )?.focus(),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && mayClose.current) {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = available();
      if (!items.length) {
        event.preventDefault();
        panel.current?.focus();
        return;
      }
      const first = items[0],
        last = items.at(-1)!;
      if (
        !panel.current?.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${drawer ? "modal-backdrop--drawer" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && canClose) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`dialog ${wide ? "dialog--wide" : ""} ${drawer ? "dialog--drawer" : ""}`}
      >
        <header className="dialog-header">
          <span className="eyebrow">
            <span className="eyebrow-dot" />
            {eyebrow}
          </span>
          <IconButton
            label="Close dialog"
            onClick={onClose}
            disabled={!canClose}
          >
            <X size={21} />
          </IconButton>
        </header>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function PrivacyNote({ children }: { children: ReactNode }) {
  return (
    <div className="info-note">
      <LockKey size={19} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function ConversationArt({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={`conversation-art ${small ? "conversation-art--small" : ""}`}
      viewBox="0 0 560 420"
      fill="none"
      role="img"
      aria-label="Private message envelopes connected by a Lightning payment"
    >
      <rect x="46" y="34" width="460" height="344" rx="36" fill="#F1F4EC" />
      <path
        d="M75 281C142 339 395 353 474 189M107 96C198 39 393 52 457 121"
        stroke="#CAD7CB"
        strokeWidth="1.5"
        strokeDasharray="6 8"
      />
      <g transform="rotate(-7 209 171)">
        <rect
          x="96"
          y="98"
          width="253"
          height="147"
          rx="21"
          fill="#FFFFFF"
          stroke="#D6E0D7"
        />
        <rect x="117" y="119" width="43" height="43" rx="15" fill="#D8EAE2" />
        <path
          d="M129 141H148M138.5 131.5V150.5"
          stroke="#185A50"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <rect x="174" y="129" width="112" height="7" rx="3.5" fill="#A6B9AD" />
        <rect x="174" y="144" width="81" height="6" rx="3" fill="#D3DDD3" />
        <rect x="117" y="180" width="193" height="7" rx="3.5" fill="#DFE6DD" />
        <rect x="117" y="197" width="156" height="7" rx="3.5" fill="#DFE6DD" />
        <path
          d="M298 223L312 239L329 215"
          stroke="#367366"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
      <g transform="rotate(6 339 278)">
        <rect x="220" y="208" width="251" height="139" rx="21" fill="#19594F" />
        <rect x="242" y="231" width="39" height="39" rx="14" fill="#347569" />
        <path
          d="M252 251C252 245 257 241 261.5 241C266 241 271 245 271 251C271 257 263 261 261.5 261C260 261 252 257 252 251Z"
          stroke="#E6F3EC"
          strokeWidth="1.7"
        />
        <rect x="297" y="239" width="112" height="7" rx="3.5" fill="#B9D8CA" />
        <rect x="297" y="254" width="70" height="6" rx="3" fill="#74A294" />
        <rect x="243" y="290" width="127" height="7" rx="3.5" fill="#75A596" />
        <rect x="243" y="307" width="92" height="7" rx="3.5" fill="#75A596" />
        <path
          d="M423 311L429 317L439 305"
          stroke="#B9D8CA"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
      <circle cx="428" cy="138" r="48" fill="#F1B59E" />
      <path
        d="M435 106L411 139H429L420 169L447 132H429L435 106Z"
        fill="#843C28"
      />
      <circle cx="121" cy="300" r="28" fill="#FFFFFF" stroke="#D6E0D7" />
      <rect x="112" y="299" width="18" height="15" rx="4" fill="#19594F" />
      <path
        d="M115 299V293A6 6 0 01127 293V299"
        stroke="#19594F"
        strokeWidth="2.5"
      />
      <circle cx="121" cy="306" r="1.8" fill="#FFFFFF" />
      <path
        d="M488 278H500M494 272V284M64 161H76M70 155V167"
        stroke="#CF7459"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="355" cy="72" r="4" fill="#19594F" />
      <circle cx="179" cy="361" r="4" fill="#CF7459" />
    </svg>
  );
}

export const numberFormat = new Intl.NumberFormat("en");
export const formatTime = (time: number) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
    time,
  );
export const formatDate = (time: number) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(
    time,
  );
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This could not be completed. Please try again.";
export const isCancelled = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";
