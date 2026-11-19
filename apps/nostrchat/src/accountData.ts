import type { NostrEvent } from "nostr-tools";
import {
  freshSignatureIsValid,
  isNip44Ciphertext,
  normalizePublicKey,
  publicKeyLabel,
  unwrapGift,
  validateRelayUrl,
  type AsyncGuard,
  type ChatMessage,
  type Identity,
} from "./protocol";
import {
  validateContacts as validateStoredContacts,
  type Contact,
} from "./storage";

const prefix = "nostrchat.v1.";
const hex = /^[0-9a-f]{64}$/;
const maxOutboxBytes = 2_000_000;
const encoder = new TextEncoder();
export type PrivateAccount = {
  version: 1;
  owner: string;
  name: string;
  contacts: Contact[];
  relayUrl: string;
};
export type OutboxItem = {
  id: string;
  ciphertext: string;
  state: "queued" | "published";
  updatedAt: number;
};
export type RetryBundle = {
  version: 1;
  owner: string;
  peer: string;
  id: string;
  events: NostrEvent[];
};

export function readPrivateName(pubkey: string): string | null {
  try {
    const value = localStorage.getItem(prefix + "profileName." + pubkey);
    return value?.trim() && value.length <= 40 ? value : null;
  } catch {
    return null;
  }
}
export function savePrivateName(pubkey: string, name: string) {
  try {
    localStorage.setItem(
      prefix + "profileName." + pubkey,
      name.trim().slice(0, 40),
    );
  } catch {
    /* A name can still be used in this tab. */
  }
}

export function validateContacts(input: unknown, owner: string): Contact[] {
  if (!Array.isArray(input) || input.length > 200)
    throw new Error("A contact file can contain up to 200 people.");
  const contacts = new Map<string, Contact>();
  for (const item of input) {
    if (!item || typeof item !== "object")
      throw new Error("This contact file contains invalid entries.");
    const value = item as Record<string, unknown>;
    if (
      typeof value.pubkey !== "string" ||
      typeof value.name !== "string" ||
      value.name.length > 40 ||
      (value.note !== undefined &&
        (typeof value.note !== "string" || value.note.length > 240))
    )
      throw new Error("This contact file contains invalid names or notes.");
    const pubkey = normalizePublicKey(value.pubkey);
    if (pubkey === owner) continue;
    const color =
      typeof value.color === "number" &&
      Number.isInteger(value.color) &&
      value.color >= 0 &&
      value.color <= 4
        ? value.color
        : parseInt(pubkey.slice(0, 2), 16) % 5;
    contacts.set(pubkey, {
      pubkey,
      name: value.name.trim() || publicKeyLabel(pubkey),
      color,
      ...(typeof value.note === "string" && value.note.trim()
        ? { note: value.note.trim() }
        : {}),
    });
  }
  return validateStoredContacts([...contacts.values()], owner);
}

function assertCurrent(guard?: AsyncGuard) {
  if (guard?.signal?.aborted || (guard?.isCurrent && !guard.isCurrent()))
    throw new DOMException("The active identity changed.", "AbortError");
}
export async function decodePrivateAccount(
  identity: Identity,
  ciphertext: string,
  guard?: AsyncGuard,
): Promise<PrivateAccount> {
  assertCurrent(guard);
  if (ciphertext.length > 100_000)
    throw new Error("This encrypted account backup is too large.");
  const text = await identity.decrypt(identity.pubkey, ciphertext, guard);
  assertCurrent(guard);
  if (new TextEncoder().encode(text).length > 60_000)
    throw new Error("This encrypted account backup is too large.");
  const value = JSON.parse(text) as Partial<PrivateAccount>;
  if (
    value.version !== 1 ||
    value.owner !== identity.pubkey ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 40 ||
    typeof value.relayUrl !== "string"
  )
    throw new Error(
      "This encrypted account backup belongs to a different identity or format.",
    );
  return {
    version: 1,
    owner: identity.pubkey,
    name: value.name.trim(),
    contacts: validateContacts(value.contacts, identity.pubkey),
    relayUrl: validateRelayUrl(value.relayUrl, true),
  };
}
export async function encodePrivateAccount(
  identity: Identity,
  data: PrivateAccount,
  guard?: AsyncGuard,
): Promise<string> {
  assertCurrent(guard);
  const text = JSON.stringify(data);
  if (
    data.owner !== identity.pubkey ||
    new TextEncoder().encode(text).length > 60_000
  )
    throw new Error(
      "Your address book is too large for one encrypted account backup. Export your contacts or shorten notes to restore cloud sync.",
    );
  const ciphertext = await identity.encrypt(identity.pubkey, text, guard);
  assertCurrent(guard);
  return ciphertext;
}

export function readLocalOutbox(pubkey: string): OutboxItem[] {
  try {
    const text = localStorage.getItem(prefix + "outbox." + pubkey) || "[]";
    if (
      text.length > maxOutboxBytes ||
      encoder.encode(text).length > maxOutboxBytes
    )
      return [];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    const items = new Map<string, OutboxItem>();
    for (const item of value.slice(-100)) {
      if (
        !item ||
        typeof item !== "object" ||
        !hex.test(item.id) ||
        !isNip44Ciphertext(item.ciphertext, 88_000) ||
        !["queued", "published"].includes(item.state) ||
        !Number.isSafeInteger(item.updatedAt) ||
        item.updatedAt < 0
      )
        continue;
      items.set(item.id, {
        id: item.id,
        ciphertext: item.ciphertext,
        state: item.state,
        updatedAt: item.updatedAt,
      });
    }
    return [...items.values()];
  } catch {
    return [];
  }
}
export function saveLocalOutbox(pubkey: string, item: OutboxItem): boolean {
  try {
    if (
      !hex.test(pubkey) ||
      !hex.test(item.id) ||
      !isNip44Ciphertext(item.ciphertext, 88_000) ||
      !["queued", "published"].includes(item.state) ||
      !Number.isSafeInteger(item.updatedAt) ||
      item.updatedAt < 0
    )
      return false;
    const existing = readLocalOutbox(pubkey),
      previous = existing.find((value) => value.id === item.id);
    if (previous && previous.ciphertext !== item.ciphertext) return false;
    const value: OutboxItem = {
      id: item.id,
      ciphertext: item.ciphertext,
      state: previous?.state === "published" ? "published" : item.state,
      updatedAt: item.updatedAt,
    };
    const next = [
      ...existing.filter((value) => value.id !== item.id),
      value,
    ].sort((a, b) => a.updatedAt - b.updatedAt);
    let text = JSON.stringify(next);
    while (next.length > 100 || encoder.encode(text).length > maxOutboxBytes) {
      const published = next.findIndex((value) => value.state === "published");
      if (published < 0) return false;
      next.splice(published, 1);
      text = JSON.stringify(next);
    }
    localStorage.setItem(prefix + "outbox." + pubkey, text);
    return true;
  } catch {
    return false;
  }
}
export function removeLocalOutbox(pubkey: string, id: string) {
  try {
    localStorage.setItem(
      prefix + "outbox." + pubkey,
      JSON.stringify(readLocalOutbox(pubkey).filter((item) => item.id !== id)),
    );
  } catch {
    /* An archived published bundle can remain as an encrypted local backup. */
  }
}
export async function encodeRetryBundle(
  identity: Identity,
  bundle: RetryBundle,
  guard?: AsyncGuard,
): Promise<string> {
  assertCurrent(guard);
  if (bundle.owner !== identity.pubkey)
    throw new Error("This message belongs to a different identity.");
  const text = JSON.stringify(bundle);
  if (new TextEncoder().encode(text).length > 60_000)
    throw new Error(
      "This encrypted message backup is too large. Shorten the message and try again.",
    );
  const ciphertext = await identity.encrypt(identity.pubkey, text, guard);
  assertCurrent(guard);
  return ciphertext;
}
export async function decodeRetryBundle(
  identity: Identity,
  item: OutboxItem,
  guard?: AsyncGuard,
): Promise<{ bundle: RetryBundle; message: ChatMessage }> {
  assertCurrent(guard);
  const text = await identity.decrypt(identity.pubkey, item.ciphertext, guard);
  assertCurrent(guard);
  if (new TextEncoder().encode(text).length > 60_000)
    throw new Error("This retry backup is too large.");
  const value = JSON.parse(text) as RetryBundle;
  if (
    value.version !== 1 ||
    value.owner !== identity.pubkey ||
    !hex.test(value.peer) ||
    value.peer === identity.pubkey ||
    value.id !== item.id ||
    !Array.isArray(value.events) ||
    value.events.length !== 2
  )
    throw new Error("This encrypted retry backup belongs to another message.");
  for (let index = 0; index < 2; index++) {
    const event = value.events[index],
      recipient = index === 0 ? value.peer : identity.pubkey;
    if (
      !event ||
      event.kind !== 1059 ||
      !freshSignatureIsValid(event) ||
      event.tags.filter((tag) => tag[0] === "p").length !== 1 ||
      !event.tags.some((tag) => tag[0] === "p" && tag[1] === recipient)
    )
      throw new Error(
        "This retry backup contains an invalid encrypted envelope.",
      );
  }
  const message = await unwrapGift(identity, value.events[1], guard);
  assertCurrent(guard);
  if (
    message.id !== value.id ||
    message.sender !== identity.pubkey ||
    message.recipient !== value.peer
  )
    throw new Error("This retry backup does not match its conversation.");
  return {
    bundle: value,
    message: {
      ...message,
      state: item.state === "published" ? "published" : "failed",
      ...(item.state === "queued"
        ? { error: "Publication was not confirmed." }
        : {}),
    },
  };
}
export function clearPrivateDeviceData(pubkey: string) {
  for (const name of ["outbox", "profileName"]) {
    try {
      localStorage.removeItem(prefix + name + "." + pubkey);
    } catch {
      /* Locking the in-memory identity still succeeds. */
    }
  }
}
