import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, verifyEvent, type EventTemplate, type NostrEvent, type UnsignedEvent } from 'nostr-tools';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { decrypt as decryptKey, encrypt as encryptKey } from 'nostr-tools/nip49';
import { getToken } from 'nostr-tools/nip98';
import type { WindowNostr } from 'nostr-tools/nip07';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';
import { decode as decodeBolt11 } from 'light-bolt11-decoder';
import { waitForIdentitySigner } from '../../../packages/academy/src/signers';

export type Rumor = UnsignedEvent & { id: string };
export type AsyncGuard = { signal?: AbortSignal; isCurrent?: () => boolean; expectedPubkey?: string };
export type ChatSigner = Omit<WindowNostr, 'signEvent'> & { signEvent(event: EventTemplate): Promise<unknown> };
export type Identity = {
  pubkey: string; name: string; mode: 'practice' | 'extension';
  sign(event: EventTemplate, guard?: AsyncGuard): Promise<NostrEvent>;
  encrypt(pubkey: string, plaintext: string, guard?: AsyncGuard): Promise<string>;
  decrypt(pubkey: string, ciphertext: string, guard?: AsyncGuard): Promise<string>;
  secret?: Uint8Array; destroy?(): void;
};
export type InvoicePayload = {
  type: 'invoice'; bolt11: string; paymentHash: string; amountSats: number;
  description: string; expiresAt: number; descriptionHash?: string;
};
export type ReceiptPayload = { type: 'receipt'; paymentHash: string; preimage: string; invoiceId?: string };
export type TextPayload = { type: 'text'; text: string };
export type ChatPayload = InvoicePayload | ReceiptPayload | TextPayload;
export type ChatMessage = {
  id: string; sender: string; recipient: string; createdAt: number; payload: ChatPayload;
  state: 'publishing' | 'published' | 'failed'; error?: string;
};
export type InvoiceFacts = {
  bolt11: string; paymentHash: string; amountSats: number; expiresAt: number;
  network: string; description?: string; descriptionHash?: string;
  // Decoding verifies encoding, not the invoice's signature or its payee.
  signatureVerified: false;
};

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const MAX_EVENT_BYTES = 80_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_PAYLOAD_BYTES = 18_000;
const MAX_PRIVATE_BYTES = 65_535;
const MAX_DATE = 8_640_000_000_000_000;
const MAX_API_BYTES = 2_500_000;
const TWO_DAYS = 2 * 24 * 60 * 60;
const utf8 = new TextEncoder();
const now = () => Math.floor(Date.now() / 1_000);
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function abortError(): DOMException { return new DOMException('This account operation was cancelled.', 'AbortError'); }

export function assertCurrent(guard?: AsyncGuard, pubkey?: string): void {
  if (guard?.signal?.aborted || (guard?.isCurrent && !guard.isCurrent())) throw abortError();
  if (guard?.expectedPubkey && (!HEX_KEY.test(guard.expectedPubkey) || (pubkey && guard.expectedPubkey !== pubkey))) throw abortError();
}

export function awaitCurrent<T>(operation: Promise<T>, guard?: AsyncGuard, pubkey?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: T, error?: unknown, failed = false) => {
      if (settled) return;
      settled = true; guard?.signal?.removeEventListener('abort', cancel);
      if (failed) reject(error); else resolve(value as T);
    };
    const cancel = () => finish(undefined, abortError(), true);
    // Consume late completions: a browser signer may not support cancellation itself.
    operation.then(value => {
      try { assertCurrent(guard, pubkey); finish(value); } catch (error) { finish(undefined, error, true); }
    }, error => finish(undefined, error, true));
    guard?.signal?.addEventListener('abort', cancel, { once: true });
    try { assertCurrent(guard, pubkey); } catch (error) { finish(undefined, error, true); }
  });
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function hasBytes(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && utf8.encode(value).length <= max;
}
function safeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Math.floor(MAX_DATE / 1000);
}
function currentSeconds(value: unknown): value is number { return safeSeconds(value) && value <= now() + 60; }

function copyTags(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const result: string[][] = []; let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const tag = own(value, String(i));
    if (!Array.isArray(tag) || tag.length < 1 || tag.length > 16) return null;
    const copied: string[] = [];
    for (let j = 0; j < tag.length; j++) {
      const part = own(tag, String(j));
      if (!hasBytes(part, 1024)) return null;
      bytes += utf8.encode(part).length;
      if (bytes > 16_000) return null;
      copied.push(part);
    }
    result.push(copied);
  }
  return result;
}
function copyTemplate(value: unknown): EventTemplate | null {
  const kind = own(value, 'kind'); const createdAt = own(value, 'created_at');
  const content = own(value, 'content'); const tags = copyTags(own(value, 'tags'));
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 65_535 || !safeSeconds(createdAt) || !hasBytes(content, MAX_EVENT_BYTES) || !tags) return null;
  return { kind, created_at: createdAt, content, tags };
}

export function canonicalSignedEvent(value: unknown): NostrEvent | null {
  try {
    const template = copyTemplate(value); const id = own(value, 'id'); const pubkey = own(value, 'pubkey'); const sig = own(value, 'sig');
    if (!template || typeof id !== 'string' || !HEX_KEY.test(id) || typeof pubkey !== 'string' || !HEX_KEY.test(pubkey) || typeof sig !== 'string' || !HEX_SIGNATURE.test(sig)) return null;
    const candidate: NostrEvent = { ...template, id, pubkey, sig };
    if (utf8.encode(JSON.stringify(candidate)).length > MAX_EVENT_BYTES) return null;
    // Verify a separate canonical object. A verification Symbol or toJSON/getter
    // cannot substitute the data being displayed, decrypted, or persisted.
    return verifyEvent({ ...candidate, tags: candidate.tags.map(tag => [...tag]) }) ? candidate : null;
  } catch { return null; }
}
export function freshSignatureIsValid(value: unknown): value is NostrEvent { return canonicalSignedEvent(value) !== null; }

export function isNip44Ciphertext(value: unknown, maxLength = 100_000): value is string {
  if (typeof value !== 'string' || value.length < 132 || value.length > maxLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try { const decoded = atob(value); return decoded.length >= 99 && decoded.charCodeAt(0) === 2; } catch { return false; }
}
export function ownedGiftEvent(value: unknown, owner?: string): NostrEvent | null {
  const event = canonicalSignedEvent(value);
  if (!event || event.kind !== 1059 || !currentSeconds(event.created_at) || !isNip44Ciphertext(event.content, MAX_EVENT_BYTES)) return null;
  const recipients = event.tags.filter(tag => tag[0] === 'p');
  return recipients.length === 1 && recipients[0].length >= 2 && HEX_KEY.test(recipients[0][1]) && (!owner || recipients[0][1] === owner) ? event : null;
}
function randomBelow(max: number): number {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % max); const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= limit);
  return sample[0] % max;
}
const privateTimestamp = () => Math.max(0, now() - randomBelow(TWO_DAYS));

export function normalizePublicKey(input: string): string {
  if (typeof input !== 'string' || input.length > 200) throw new Error('Enter an npub public key, never a private key.');
  const key = input.trim().replace(/^nostr:/i, '').toLowerCase();
  if (HEX_KEY.test(key)) return key;
  if (!key.startsWith('npub1')) throw new Error('Enter an npub public key, never a private key.');
  try { const decoded = nip19.decode(key); if (decoded.type === 'npub' && HEX_KEY.test(decoded.data)) return decoded.data; } catch { /* helpful error follows */ }
  throw new Error('That public key is not a valid npub.');
}
export function publicKeyLabel(pubkey: string): string {
  const npub = nip19.npubEncode(normalizePublicKey(pubkey));
  return npub.slice(0, 11) + '…' + npub.slice(-6);
}
export function validateRelayUrl(input: string, allowPublic = false): string {
  let url: URL;
  try { if (typeof input !== 'string' || input.length > 2048) throw new Error(); url = new URL(input.trim()); } catch { throw new Error('Enter a valid ws:// or wss:// relay URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use a ws:// or wss:// URL without credentials or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !allowPublic) throw new Error('Select “Use this external relay” to connect outside your local practice environment.');
  if (!local && url.protocol !== 'wss:') throw new Error('External relays must use encrypted wss:// connections.');
  return url.toString();
}

export function createPracticeIdentity(name: string, key?: Uint8Array): Identity {
  const source = key ?? generateSecretKey(); const secret = new Uint8Array(source);
  if (!key) source.fill(0);
  let pubkey: string;
  try { if (secret.length !== 32) throw new Error(); pubkey = getPublicKey(secret); } catch { secret.fill(0); throw new Error('This key cannot create a Nostr identity.'); }
  let destroyed = false;
  const ready = () => {
    if (destroyed) throw new Error('This local key is locked. Unlock it before continuing.');
    try { if (getPublicKey(secret) !== pubkey) throw new Error(); } catch { throw new Error('This local key is locked. Unlock it before continuing.'); }
  };
  return {
    pubkey, name: typeof name === 'string' ? name.trim().slice(0, 40) || 'Local account' : 'Local account', mode: 'practice', secret,
    destroy: () => { destroyed = true; secret.fill(0); },
    sign: async (event, operationGuard) => {
      ready(); assertCurrent(operationGuard, pubkey); const template = copyTemplate(event); if (!template) throw new Error('This event cannot be signed.');
      const signed = canonicalSignedEvent(finalizeEvent(template, secret));
      if (!signed) throw new Error('Could not verify the message signature.'); return signed;
    },
    encrypt: async (other, plaintext, operationGuard) => {
      ready(); assertCurrent(operationGuard, pubkey); if (!hasBytes(plaintext, MAX_PRIVATE_BYTES, 1)) throw new Error('Private data is too large.');
      const conversationKey = getConversationKey(secret, normalizePublicKey(other));
      try { return encrypt(plaintext, conversationKey); } finally { conversationKey.fill(0); }
    },
    decrypt: async (other, ciphertext, operationGuard) => {
      ready(); assertCurrent(operationGuard, pubkey); if (!isNip44Ciphertext(ciphertext)) throw new Error('This encrypted data is invalid.');
      const conversationKey = getConversationKey(secret, normalizePublicKey(other));
      try { const plaintext = decrypt(ciphertext, conversationKey); if (!hasBytes(plaintext, MAX_PRIVATE_BYTES, 1)) throw new Error('Private data is too large.'); return plaintext; } finally { conversationKey.fill(0); }
    },
  };
}
export function destroyIdentity(identity: Identity | null | undefined): void { identity?.destroy?.(); identity?.secret?.fill(0); }

export async function createExtensionIdentity(signer: ChatSigner, guard?: AsyncGuard): Promise<Identity> {
  assertCurrent(guard);
  if (!signer || typeof signer.getPublicKey !== 'function' || typeof signer.signEvent !== 'function' || typeof signer.nip44?.encrypt !== 'function' || typeof signer.nip44?.decrypt !== 'function') {
    throw new Error('Your signer needs NIP-44 encryption and Nostr signing for private messages. Enable a compatible signer or create a local key.');
  }
  const pubkey = normalizePublicKey(await awaitCurrent(signer.getPublicKey(), guard)); assertCurrent(guard, pubkey);
  let destroyed = false;
  const checkAccount = async (operationGuard?: AsyncGuard) => {
    if (destroyed) throw abortError(); assertCurrent(operationGuard, pubkey);
    if (normalizePublicKey(await awaitCurrent(signer.getPublicKey(), operationGuard, pubkey)) !== pubkey || destroyed) throw new Error('Your signer changed accounts. Reconnect the current account.');
  };
  const probe = 'NostrChat NIP-44 check ' + hex(crypto.getRandomValues(new Uint8Array(16)));
  try {
    const ciphertext = await awaitCurrent(signer.nip44.encrypt(pubkey, probe), guard, pubkey);
    if (!isNip44Ciphertext(ciphertext) || await awaitCurrent(signer.nip44.decrypt(pubkey, ciphertext), guard, pubkey) !== probe) throw new Error();
    await checkAccount(guard);
  } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new Error('Your signer could not complete NIP-44 encryption. Enable NIP-44 for this website and reconnect.'); }
  return {
    pubkey, name: 'Nostr account', mode: 'extension', destroy: () => { destroyed = true; },
    sign: async (event, operationGuard) => {
      const requested = copyTemplate(event); if (!requested) throw new Error('This event cannot be signed.');
      await checkAccount(operationGuard);
      // Keep the comparison separate from the mutable argument given to the extension.
      const result = canonicalSignedEvent(await awaitCurrent(signer.signEvent(structuredClone(requested)), operationGuard, pubkey)); await checkAccount(operationGuard);
      if (!result || result.pubkey !== pubkey || result.kind !== requested.kind || result.created_at !== requested.created_at || result.content !== requested.content || JSON.stringify(result.tags) !== JSON.stringify(requested.tags)) throw new Error('Your signer returned a different event or account than requested.');
      return result;
    },
    encrypt: async (other, plaintext, operationGuard) => {
      await checkAccount(operationGuard); if (!hasBytes(plaintext, MAX_PRIVATE_BYTES, 1)) throw new Error('Private data is too large.');
      const result = await awaitCurrent(signer.nip44!.encrypt(normalizePublicKey(other), plaintext), operationGuard, pubkey); await checkAccount(operationGuard);
      if (!isNip44Ciphertext(result)) throw new Error('Your signer returned invalid NIP-44 data.'); return result;
    },
    decrypt: async (other, ciphertext, operationGuard) => {
      await checkAccount(operationGuard); if (!isNip44Ciphertext(ciphertext)) throw new Error('This encrypted data is invalid.');
      const result = await awaitCurrent(signer.nip44!.decrypt(normalizePublicKey(other), ciphertext), operationGuard, pubkey); await checkAccount(operationGuard);
      if (!hasBytes(result, MAX_PRIVATE_BYTES, 1)) throw new Error('Your signer returned invalid private data.'); return result;
    },
  };
}
export async function createAvailableIdentity(guard?: AsyncGuard): Promise<Identity> {
  assertCurrent(guard); const signer = await awaitCurrent(waitForIdentitySigner(guard?.signal), guard);
  return createExtensionIdentity(signer, guard);
}

export function inspectEncryptedBackup(input: string): { encryptedKey: string; logN: number } {
  try {
    if (typeof input !== 'string' || input.trim().length !== 162) throw new Error();
    const encryptedKey = input.trim().toLowerCase(); const decoded = bech32.decode(encryptedKey, 162); const bytes = bech32.fromWords(decoded.words);
    if (decoded.prefix !== 'ncryptsec' || bytes.length !== 91 || bytes[0] !== 2 || bytes[1] < 14 || bytes[1] > 16 || ![0, 1, 2].includes(bytes[42])) throw new Error();
    return { encryptedKey, logN: bytes[1] };
  } catch { throw new Error('Use a valid NIP-49 encrypted backup with a supported work factor (14–16).'); }
}
function validPassword(password: string, creating = false): void {
  if (!hasBytes(password, 1024, creating ? 10 : 1) || password.normalize('NFKC').length > 1024) throw new Error(creating ? 'Use a passphrase of 10–1,024 characters.' : 'Enter your backup passphrase.');
}
export async function createEncryptedBackup(identity: Identity, password: string, guard?: AsyncGuard): Promise<string> {
  assertCurrent(guard, identity.pubkey); validPassword(password, true);
  if (!identity.secret || identity.secret.length !== 32) throw new Error('Back up this identity in your Nostr signer.');
  const secret = new Uint8Array(identity.secret);
  try {
    if (getPublicKey(secret) !== identity.pubkey) throw new Error('This local key is locked. Unlock it before continuing.');
    await awaitCurrent(new Promise<void>(resolve => setTimeout(resolve, 0)), guard, identity.pubkey);
    const result = encryptKey(secret, password, 16); assertCurrent(guard, identity.pubkey);
    return inspectEncryptedBackup(result).encryptedKey;
  } finally { secret.fill(0); }
}
export async function unlockEncryptedBackup(input: string, password: string, expectedPubkey?: string, name = 'Restored account', guard?: AsyncGuard): Promise<Identity> {
  assertCurrent(guard); validPassword(password);
  const { encryptedKey } = inspectEncryptedBackup(input); const expected = expectedPubkey ? normalizePublicKey(expectedPubkey) : undefined;
  await awaitCurrent(new Promise<void>(resolve => setTimeout(resolve, 0)), guard);
  let secret: Uint8Array | undefined; let identity: Identity | undefined;
  try {
    secret = decryptKey(encryptedKey, password);
    if (secret.length !== 32 || (expected && getPublicKey(secret) !== expected)) throw new Error();
    identity = createPracticeIdentity(name, secret); assertCurrent(guard, identity.pubkey); return identity;
  } catch (error) {
    destroyIdentity(identity);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Could not unlock this encrypted key for the requested account. Check your passphrase and backup.');
  } finally { secret?.fill(0); }
}

export function inspectInvoice(input: string): InvoiceFacts {
  try {
    if (typeof input !== 'string' || input.length > 12_000) throw new Error();
    const bolt11 = input.trim().replace(/^lightning:/i, '').toLowerCase();
    if (!/^ln(bc|tb|bcrt)/.test(bolt11)) throw new Error();
    const decoded = decodeBolt11(bolt11);
    const section = (name: string, required = false): unknown => {
      const parts = decoded.sections.filter(part => part.name === name);
      if (parts.length > 1 || (required && parts.length !== 1)) throw new Error();
      return parts[0] && 'value' in parts[0] ? parts[0].value : undefined;
    };
    const paymentHash = section('payment_hash', true); const amount = section('amount', true);
    if (typeof amount !== 'string' || !/^\d{1,24}$/.test(amount)) throw new Error();
    const msats = BigInt(amount); const timestamp = section('timestamp', true); const expiry = section('expiry') ?? 3600;
    if (typeof paymentHash !== 'string' || !HEX_KEY.test(paymentHash) || msats <= 0n || msats % 1000n !== 0n || msats / 1000n > BigInt(Number.MAX_SAFE_INTEGER) || !currentSeconds(timestamp) || typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry < 1) throw new Error();
    const expiresAt = (timestamp + expiry) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > MAX_DATE || expiresAt < 0) throw new Error();
    const description = section('description'); const descriptionHash = section('description_hash');
    if ((description !== undefined && typeof description !== 'string') || (descriptionHash !== undefined && (typeof descriptionHash !== 'string' || !HEX_KEY.test(descriptionHash))) || (description !== undefined && descriptionHash !== undefined) || (description === undefined && descriptionHash === undefined)) throw new Error();
    const networkPart = decoded.sections.find(part => part.name === 'coin_network'); const prefix = networkPart && 'letters' in networkPart ? networkPart.letters : '';
    const network = ({ bc: 'bitcoin', tb: 'testnet', tbs: 'signet', bcrt: 'regtest' } as Record<string, string>)[prefix]; if (!network) throw new Error();
    return { bolt11, paymentHash, amountSats: Number(msats / 1000n), expiresAt, network, ...(typeof description === 'string' ? { description } : {}), ...(typeof descriptionHash === 'string' ? { descriptionHash } : {}), signatureVerified: false };
  } catch { throw new Error('Use a valid Lightning invoice for a fixed, whole-sat amount and a safe expiry date.'); }
}
export function parsePayload(content: string): ChatPayload {
  if (!hasBytes(content, MAX_PAYLOAD_BYTES)) throw new Error('Message is too large.');
  const text = (): TextPayload => { if (!content.trim()) throw new Error('Message is empty.'); if (content.length > MAX_TEXT_LENGTH) throw new Error('Message is too long.'); return { type: 'text', text: content }; };
  let object: unknown;
  try { object = JSON.parse(content); } catch { return text(); }
  if (!object || typeof object !== 'object' || Array.isArray(object) || !('type' in object)) return text();
  const value = object as Record<string, unknown>;
  if (value.type === 'text') {
    if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_TEXT_LENGTH || !hasBytes(value.text, MAX_PAYLOAD_BYTES)) throw new Error('Message is empty or too long.');
    return { type: 'text', text: value.text };
  }
  if (value.type === 'invoice') {
    if (typeof value.bolt11 !== 'string' || typeof value.description !== 'string' || value.description.length > 160) throw new Error('Invoice details are invalid.');
    const parsed = inspectInvoice(value.bolt11);
    const opaqueDescription = parsed.descriptionHash !== undefined && value.description === '';
    if (parsed.paymentHash !== value.paymentHash || parsed.amountSats !== value.amountSats || parsed.expiresAt !== value.expiresAt || (parsed.description !== undefined && parsed.description !== value.description) || (opaqueDescription ? value.descriptionHash !== parsed.descriptionHash : parsed.descriptionHash && hex(sha256(utf8.encode(value.description))) !== parsed.descriptionHash) || (value.descriptionHash !== undefined && value.descriptionHash !== parsed.descriptionHash)) throw new Error('Invoice details do not match the actual Lightning invoice.');
    return { type: 'invoice', bolt11: parsed.bolt11, description: value.description, paymentHash: parsed.paymentHash, amountSats: parsed.amountSats, expiresAt: parsed.expiresAt, ...(opaqueDescription ? { descriptionHash: parsed.descriptionHash } : {}) };
  }
  if (value.type === 'receipt') {
    if (typeof value.paymentHash !== 'string' || typeof value.preimage !== 'string' || !HEX_KEY.test(value.paymentHash) || !HEX_KEY.test(value.preimage) || (value.invoiceId !== undefined && (typeof value.invoiceId !== 'string' || !HEX_KEY.test(value.invoiceId)))) throw new Error('Payment proof details are invalid.');
    return { type: 'receipt', paymentHash: value.paymentHash, preimage: value.preimage, ...(typeof value.invoiceId === 'string' ? { invoiceId: value.invoiceId } : {}) };
  }
  // Unknown structured messages stay text; a peer's "paid" flag has no effect.
  return text();
}

function privateWrap(seal: NostrEvent, recipient: string): NostrEvent {
  const secret = generateSecretKey(); let conversationKey: Uint8Array | undefined;
  try {
    conversationKey = getConversationKey(secret, recipient);
    const event = finalizeEvent({ kind: 1059, created_at: privateTimestamp(), tags: [['p', recipient]], content: encrypt(JSON.stringify(seal), conversationKey) }, secret);
    const canonical = ownedGiftEvent(event, recipient); if (!canonical) throw new Error('Could not verify this encrypted envelope.'); return canonical;
  } finally { conversationKey?.fill(0); secret.fill(0); }
}
export async function createGiftWraps(identity: Identity, recipientKey: string, payload: ChatPayload, timestamp = now(), guard?: AsyncGuard): Promise<{ rumor: Rumor; events: NostrEvent[] }> {
  const owner = normalizePublicKey(identity.pubkey); assertCurrent(guard, owner); const recipient = normalizePublicKey(recipientKey);
  if (recipient === owner) throw new Error('Choose another account to start a conversation.');
  if (!currentSeconds(timestamp)) throw new Error('This message has an invalid date.');
  let content = payload.type === 'text' ? payload.text.trim() : JSON.stringify(payload);
  if (payload.type === 'text') {
    try {
      const literal: unknown = JSON.parse(content);
      if (literal && typeof literal === 'object' && 'type' in literal && ['text', 'invoice', 'receipt'].includes(String(literal.type))) content = JSON.stringify({ type: 'text', text: content });
    } catch { /* ordinary NIP-17 text remains plain content */ }
  }
  parsePayload(content);
  const rumor: Rumor = { kind: 14, pubkey: owner, content, tags: [['p', recipient], ['message-id', hex(crypto.getRandomValues(new Uint8Array(16)))]], created_at: timestamp, id: '' };
  rumor.id = getEventHash(rumor); const plaintext = JSON.stringify(rumor); const events: NostrEvent[] = [];
  for (const target of [recipient, owner]) {
    assertCurrent(guard, owner); const ciphertext = await awaitCurrent(identity.encrypt(target, plaintext, guard), guard, owner);
    if (!isNip44Ciphertext(ciphertext)) throw new Error('Your signer returned invalid NIP-44 data.');
    const requested: EventTemplate = { kind: 13, created_at: privateTimestamp(), tags: [], content: ciphertext };
    const seal = canonicalSignedEvent(await awaitCurrent(identity.sign(structuredClone(requested), guard), guard, owner));
    if (!seal || seal.pubkey !== owner || seal.kind !== requested.kind || seal.created_at !== requested.created_at || seal.content !== requested.content || seal.tags.length !== 0) throw new Error('Could not verify the requested message seal.');
    events.push(privateWrap(seal, target));
  }
  assertCurrent(guard, owner); return { rumor, events };
}
function parsePrivateJson(plaintext: unknown, maxBytes: number, error: string): unknown {
  if (!hasBytes(plaintext, maxBytes, 1)) throw new Error(error);
  try { return JSON.parse(plaintext); } catch { throw new Error(error); }
}
export async function unwrapGift(identity: Identity, gift: NostrEvent, guard?: AsyncGuard): Promise<ChatMessage> {
  const owner = normalizePublicKey(identity.pubkey); assertCurrent(guard, owner); const envelope = ownedGiftEvent(gift, owner);
  if (!envelope) throw new Error('This envelope is invalid or belongs to another account.');
  const sealObject = parsePrivateJson(await awaitCurrent(identity.decrypt(envelope.pubkey, envelope.content, guard), guard, owner), MAX_PRIVATE_BYTES, 'Message seal failed validation.');
  const seal = canonicalSignedEvent(sealObject);
  if (!seal || seal.kind !== 13 || seal.tags.length !== 0 || !currentSeconds(seal.created_at) || !isNip44Ciphertext(seal.content)) throw new Error('Message seal failed signature validation.');
  const object = parsePrivateJson(await awaitCurrent(identity.decrypt(seal.pubkey, seal.content, guard), guard, owner), 24_000, 'Message author or content failed validation.');
  const template = copyTemplate(object); const pubkey = own(object, 'pubkey'); const id = own(object, 'id');
  if (!template || template.kind !== 14 || !currentSeconds(template.created_at) || !hasBytes(template.content, MAX_PAYLOAD_BYTES) || pubkey !== seal.pubkey || typeof id !== 'string' || !HEX_KEY.test(id) || Object.getOwnPropertyDescriptor(object as object, 'sig')) throw new Error('Message author or content failed validation.');
  const rumor: Rumor = { ...template, pubkey: seal.pubkey, id };
  if (getEventHash(rumor) !== id) throw new Error('Message author or content failed validation.');
  const recipients = rumor.tags.filter(tag => tag[0] === 'p');
  if (recipients.length !== 1 || recipients[0].length < 2 || !HEX_KEY.test(recipients[0][1]) || recipients[0][1] === rumor.pubkey || (rumor.pubkey !== owner && recipients[0][1] !== owner)) throw new Error('Message is not addressed to this conversation.');
  assertCurrent(guard, owner);
  return { id, sender: rumor.pubkey, recipient: recipients[0][1], createdAt: rumor.created_at * 1000, payload: parsePayload(rumor.content), state: 'published' };
}
export async function paymentProofMatches(paymentHash: string, preimage: string, guard?: AsyncGuard): Promise<boolean> {
  assertCurrent(guard);
  if (typeof paymentHash !== 'string' || typeof preimage !== 'string' || !HEX_KEY.test(paymentHash) || !HEX_KEY.test(preimage)) return false;
  const bytes = Uint8Array.from(preimage.match(/.{2}/g)!.map(part => parseInt(part, 16)));
  const result = hex(sha256(bytes)); bytes.fill(0); assertCurrent(guard); return result === paymentHash;
}
function inConversation(message: ChatMessage, owner: string, peer: string): boolean {
  return (message.sender === owner && message.recipient === peer) || (message.sender === peer && message.recipient === owner);
}
export function invoiceScopeKey(ownerKey: string, peerKey: string, message: ChatMessage): string {
  const owner = normalizePublicKey(ownerKey); const peer = normalizePublicKey(peerKey);
  if (owner === peer || !HEX_KEY.test(message.id) || message.payload.type !== 'invoice' || !inConversation(message, owner, peer)) throw new Error('This invoice does not belong to the requested conversation.');
  const invoice = parsePayload(JSON.stringify(message.payload)); if (invoice.type !== 'invoice') throw new Error('This invoice is invalid.');
  return owner + ':' + peer + ':' + message.id + ':' + hex(sha256(utf8.encode(JSON.stringify(invoice))));
}
export async function matchingReceiptInvoices(ownerKey: string, receipt: ChatMessage, invoices: ChatMessage[], guard?: AsyncGuard): Promise<ChatMessage[]> {
  const owner = normalizePublicKey(ownerKey); assertCurrent(guard, owner);
  if (receipt.payload.type !== 'receipt' || !HEX_KEY.test(receipt.id) || receipt.sender === receipt.recipient) return [];
  const peer = receipt.sender === owner ? receipt.recipient : receipt.sender;
  if (!HEX_KEY.test(peer) || !inConversation(receipt, owner, peer)) return [];
  const payload = receipt.payload; if (!await paymentProofMatches(payload.paymentHash, payload.preimage, guard)) return [];
  const matches = invoices.slice(-1000).filter(invoice => invoice.payload.type === 'invoice' && invoice.sender === receipt.recipient && invoice.recipient === receipt.sender && invoice.createdAt <= receipt.createdAt && invoice.payload.paymentHash === payload.paymentHash && (!payload.invoiceId || invoice.id === payload.invoiceId));
  const valid = matches.filter(invoice => { try { invoiceScopeKey(owner, peer, invoice); return true; } catch { return false; } });
  assertCurrent(guard, owner); return valid.length === 1 ? valid : [];
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); this.name = 'ApiError'; }
}
function responseMessage(value: unknown): { message: string; code?: string } {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const error = object.error && typeof object.error === 'object' ? object.error as Record<string, unknown> : {};
  const candidate = typeof object.error === 'string' ? object.error : typeof error.message === 'string' ? error.message : typeof object.message === 'string' ? object.message : 'This request could not be completed. Try again.';
  const code = typeof object.code === 'string' ? object.code : typeof error.code === 'string' ? error.code : undefined;
  return { message: candidate.replace(/(?:nsec1|ncryptsec1)[a-z0-9]+|nostr\+?walletconnect:\/\/\S+/gi, '[private credential]').slice(0, 240), ...(code ? { code: code.slice(0, 64) } : {}) };
}
async function readResponse(response: Response, guard?: AsyncGuard): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; let complete = false;
  try {
    while (true) {
      const part = await awaitCurrent(reader.read(), guard); if (part.done) break;
      size += part.value.length;
      if (size > MAX_API_BYTES) throw new ApiError(response.status, 'The server response is too large. Try a smaller history page.');
      chunks.push(part.value);
    }
    complete = true; const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    assertCurrent(guard); try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  } finally { if (!complete) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* an aborted read can still be pending */ } }
}
export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', guard?: AsyncGuard): Promise<T> {
  assertCurrent(guard);
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/api/') || path.includes('\\') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('This API request is invalid.');
  const headers: Record<string, string> = { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  if (guard?.expectedPubkey) headers['X-Nostr-Pubkey'] = guard.expectedPubkey;
  const response = await awaitCurrent(fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: guard?.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), guard);
  const echoedOwner = response.headers.get('X-Nostr-Pubkey');
  if (echoedOwner && guard?.expectedPubkey && echoedOwner !== guard.expectedPubkey) throw abortError();
  const value = await readResponse(response, guard); assertCurrent(guard);
  if (!response.ok) { const error = responseMessage(value); throw new ApiError(response.status, error.message, error.code); }
  if (value === null && response.status !== 204) throw new ApiError(response.status, 'The server returned an invalid response. Try again.');
  return value as T;
}
let authenticationQueue = Promise.resolve();
const authenticating = new Map<string, Promise<void>>();
export async function authenticateWallet(identity: Identity, guard?: AsyncGuard): Promise<void> {
  const owner = normalizePublicKey(identity.pubkey); assertCurrent(guard, owner); const captured = { ...guard, expectedPubkey: owner };
  const active = authenticating.get(owner);
  if (active) {
    try { return await awaitCurrent(active, captured, owner); }
    catch (error) {
      // A closed view can cancel its shared request while a new view is current.
      assertCurrent(captured, owner);
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
      if (authenticating.get(owner) === active) authenticating.delete(owner);
      return authenticateWallet(identity, captured);
    }
  }
  const operation = authenticationQueue.catch(() => undefined).then(async () => {
    assertCurrent(captured, owner);
    const session = await api<{ user?: { pubkey?: string } }>('/api/session', undefined, 'GET', captured);
    if (session.user?.pubkey === owner) return;
    const body = {}; const url = window.location.origin + '/api/auth/nostr';
    const authorization = await awaitCurrent(getToken(url, 'POST', event => {
      assertCurrent(captured, owner);
      const request = { ...event, tags: [...event.tags, ['client-nonce', hex(crypto.getRandomValues(new Uint8Array(16)))]] };
      return awaitCurrent(identity.sign(request, captured), captured, owner);
    }, true, body), captured, owner);
    assertCurrent(captured, owner);
    const response = await awaitCurrent(fetch('/api/auth/nostr', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: captured.signal, headers: { 'Content-Type': 'application/json', Authorization: authorization, 'X-Nostr-Pubkey': owner }, body: JSON.stringify(body) }), captured, owner);
    const result = await readResponse(response, captured); assertCurrent(captured, owner);
    if (!response.ok) { const error = responseMessage(result); throw new ApiError(response.status, error.message, error.code); }
    const user = result && typeof result === 'object' ? (result as { user?: { pubkey?: string } }).user : undefined;
    if (user?.pubkey !== owner) throw new Error('Could not authenticate the requested Nostr account. Reconnect your signer and retry.');
  });
  authenticating.set(owner, operation); authenticationQueue = operation.catch(() => undefined);
  const cleanup = () => { if (authenticating.get(owner) === operation) authenticating.delete(owner); };
  void operation.then(cleanup, cleanup); return awaitCurrent(operation, captured, owner);
}
export function mergeMessage(current: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (!incoming || !HEX_KEY.test(incoming.id) || !HEX_KEY.test(incoming.sender) || !HEX_KEY.test(incoming.recipient) || incoming.sender === incoming.recipient || !Number.isSafeInteger(incoming.createdAt) || incoming.createdAt < 0 || incoming.createdAt > MAX_DATE || !['publishing', 'published', 'failed'].includes(incoming.state)) return current;
  const existing = current.find(message => message.id === incoming.id);
  if (existing && (existing.sender !== incoming.sender || existing.recipient !== incoming.recipient || existing.createdAt !== incoming.createdAt || JSON.stringify(existing.payload) !== JSON.stringify(incoming.payload))) return current;
  const merged = existing ? { ...existing, ...incoming, state: existing.state === 'published' ? 'published' as const : incoming.state } : { ...incoming };
  if (merged.state !== 'failed') delete merged.error;
  return (existing ? current.map(message => message.id === incoming.id ? merged : message) : [...current, merged]).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-1000);
}
