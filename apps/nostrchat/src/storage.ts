import type { NostrEvent } from 'nostr-tools';
import { assertCurrent, awaitCurrent, inspectEncryptedBackup, invoiceScopeKey, isNip44Ciphertext, ownedGiftEvent, parsePayload, paymentProofMatches, type AsyncGuard, type ChatMessage, type Identity, type InvoicePayload } from './protocol';

export type Contact = { pubkey: string; name: string; color: number; note?: string };
export type LockedAccount = { pubkey: string; name: string; encryptedKey: string };
export type EncryptedHistory = { version: 1; owner: string; events: NostrEvent[] };
export type PaymentRecoveryRecord = {
  peer: string; invoiceId: string; invoice: InvoicePayload; attemptedAt: number;
  state: 'unknown' | 'confirmed'; preimage?: string; standalone?: true;
};
const prefix = 'nostrchat.v1.';
const HEX = /^[0-9a-f]{64}$/;
const MAX_CONTACTS = 200;
const MAX_EVENTS = 500;
const MAX_CACHE_BYTES = 2_000_000;
const MAX_RECOVERY_BYTES = 60_000;
const encoder = new TextEncoder();
const privateCredential = /(?:nsec1|ncryptsec1|nostr\+?walletconnect:\/\/)/i;
const storageError = () => new Error('Could not save recovery data on this device. Check your wallet before attempting another payment.');

function ownerKey(pubkey: string): boolean { return typeof pubkey === 'string' && HEX.test(pubkey); }
function readStored(key: string, maxBytes: number, strict = false): string | null {
  try {
    const value = localStorage.getItem(key);
    if (value !== null && (value.length > maxBytes || encoder.encode(value).length > maxBytes)) throw new Error();
    return value;
  } catch { if (strict) throw storageError(); return null; }
}
function writeStored(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function contactValue(value: unknown, owner?: string): Contact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const contact = value as Record<string, unknown>;
  if (typeof contact.pubkey !== 'string' || !HEX.test(contact.pubkey) || contact.pubkey === owner || typeof contact.name !== 'string' || !contact.name.trim() || contact.name.length > 40 || /[\u0000-\u001f\u007f]/.test(contact.name) || privateCredential.test(contact.name) || typeof contact.color !== 'number' || !Number.isInteger(contact.color) || contact.color < 0 || contact.color > 4) return null;
  if (contact.note !== undefined && (typeof contact.note !== 'string' || contact.note.length > 240 || privateCredential.test(contact.note))) return null;
  return { pubkey: contact.pubkey, name: contact.name.trim(), color: contact.color, ...(typeof contact.note === 'string' ? { note: contact.note } : {}) };
}
function contactsFrom(input: unknown, owner?: string, strict = false): Contact[] {
  if (!Array.isArray(input) || (strict && input.length > MAX_CONTACTS)) { if (strict) throw new Error('Import up to 200 valid contacts.'); return []; }
  const contacts = new Map<string, Contact>();
  for (const value of input.slice(0, MAX_CONTACTS)) {
    const contact = contactValue(value, owner);
    if (!contact) { if (strict) throw new Error('A contact has invalid public details.'); continue; }
    if (!contacts.has(contact.pubkey)) contacts.set(contact.pubkey, contact);
  }
  return [...contacts.values()];
}
export function validateContacts(input: unknown, owner?: string): Contact[] {
  if (owner !== undefined && !ownerKey(owner)) throw new Error('This contact account is invalid.');
  return contactsFrom(input, owner, true);
}
export function readContacts(pubkey: string): Contact[] {
  if (!ownerKey(pubkey)) return [];
  try { return contactsFrom(JSON.parse(readStored(prefix + 'contacts.' + pubkey, 160_000) || '[]'), pubkey); } catch { return []; }
}
export function saveContacts(pubkey: string, contacts: Contact[]): void {
  if (!ownerKey(pubkey)) return;
  writeStored(prefix + 'contacts.' + pubkey, JSON.stringify(contactsFrom(contacts, pubkey)));
}

function boundedEvents(events: NostrEvent[]): NostrEvent[] {
  const items: Array<{ event: NostrEvent; bytes: number }> = []; let bytes = 2;
  for (const event of events.slice(-MAX_EVENTS)) {
    const size = encoder.encode(JSON.stringify(event)).length + 1;
    items.push({ event, bytes: size }); bytes += size;
    while (items.length && bytes > MAX_CACHE_BYTES) bytes -= items.shift()!.bytes;
  }
  return items.map(item => item.event);
}
export function readEncryptedEvents(pubkey: string): NostrEvent[] {
  if (!ownerKey(pubkey)) return [];
  const cacheKey = prefix + 'events.' + pubkey;
  const stored = readStored(cacheKey, 5_000_000);
  try {
    const input: unknown = JSON.parse(stored || '[]');
    if (!Array.isArray(input)) { if (stored) writeStored(cacheKey, '[]'); return []; }
    const events = new Map<string, NostrEvent>();
    for (const value of input.slice(-MAX_EVENTS)) {
      const event = ownedGiftEvent(value, pubkey);
      if (event && !events.has(event.id)) events.set(event.id, event);
    }
    const bounded = boundedEvents([...events.values()]);
    const canonical = JSON.stringify(bounded);
    if (stored && canonical !== stored) writeStored(cacheKey, canonical);
    return bounded;
  } catch { if (stored) writeStored(cacheKey, '[]'); return []; }
}
export function saveEncryptedEvent(pubkey: string, input: NostrEvent): void {
  if (!ownerKey(pubkey)) return;
  const event = ownedGiftEvent(input, pubkey); if (!event) return;
  const current = readEncryptedEvents(pubkey); if (current.some(value => value.id === event.id)) return;
  // An unavailable/full cache must never suppress an authentic received message.
  writeStored(prefix + 'events.' + pubkey, JSON.stringify(boundedEvents([...current, event])));
}
export function exportEncryptedHistory(pubkey: string): EncryptedHistory {
  if (!ownerKey(pubkey)) throw new Error('Choose a valid account to export encrypted history.');
  return { version: 1, owner: pubkey, events: readEncryptedEvents(pubkey) };
}
export function importEncryptedHistory(pubkey: string, input: unknown): number {
  if (!ownerKey(pubkey)) throw new Error('Choose a valid account to import encrypted history.');
  let value = input;
  if (typeof value === 'string') {
    if (value.length > MAX_CACHE_BYTES || encoder.encode(value).length > MAX_CACHE_BYTES) throw new Error('Encrypted history is too large.');
    try { value = JSON.parse(value); } catch { throw new Error('This encrypted history backup is invalid.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('This encrypted history backup is invalid.');
  const history = value as Record<string, unknown>;
  if (history.version !== 1 || history.owner !== pubkey || !Array.isArray(history.events) || history.events.length > MAX_EVENTS) throw new Error('This encrypted history belongs to another account or exceeds the history limit.');
  const imported = new Map<string, NostrEvent>();
  let importedBytes = 2;
  for (const candidate of history.events) {
    const event = ownedGiftEvent(candidate, pubkey);
    if (!event) throw new Error('The history contains an invalid or misaddressed envelope.');
    importedBytes += encoder.encode(JSON.stringify(event)).length + 1;
    if (importedBytes > MAX_CACHE_BYTES) throw new Error('Encrypted history is too large.');
    imported.set(event.id, event);
  }
  const existing = readEncryptedEvents(pubkey); const ids = new Set(existing.map(event => event.id));
  const added = [...imported.values()].filter(event => !ids.has(event.id));
  const saved = boundedEvents([...existing, ...added]); const savedIds = new Set(saved.map(event => event.id));
  if (!writeStored(prefix + 'events.' + pubkey, JSON.stringify(saved))) throw new Error('Could not save encrypted history on this device.');
  return added.filter(event => savedIds.has(event.id)).length;
}

function lockedAccountValue(value: unknown): LockedAccount | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const account = value as Record<string, unknown>;
  if (typeof account.pubkey !== 'string' || !ownerKey(account.pubkey) || typeof account.name !== 'string' || !account.name.trim() || account.name.length > 40 || privateCredential.test(account.name) || typeof account.encryptedKey !== 'string') return null;
  try { return { pubkey: account.pubkey, name: account.name.trim(), encryptedKey: inspectEncryptedBackup(account.encryptedKey).encryptedKey }; } catch { return null; }
}
export function readLockedAccount(): LockedAccount | null {
  try { return lockedAccountValue(JSON.parse(readStored(prefix + 'vault', 1024) || 'null')); } catch { return null; }
}
export function saveLockedAccount(input: LockedAccount): void {
  const account = lockedAccountValue(input);
  if (!account) throw new Error('This encrypted account backup is invalid.');
  if (!writeStored(prefix + 'vault', JSON.stringify(account))) throw new Error('Could not save this encrypted backup on your device. Download and keep a copy before continuing.');
}

function recoveryKey(owner: string, record: PaymentRecoveryRecord): string {
  if (record.standalone) return 'standalone:' + record.invoice.paymentHash + ':' + record.invoice.bolt11;
  const message: ChatMessage = { id: record.invoiceId, sender: record.peer, recipient: owner, createdAt: record.attemptedAt, state: 'published', payload: record.invoice };
  return invoiceScopeKey(owner, record.peer, message);
}
async function recoveryRecords(owner: string, input: unknown, guard?: AsyncGuard): Promise<PaymentRecoveryRecord[]> {
  if (!Array.isArray(input) || input.length > 64) throw new Error('Payment recovery data is invalid or too large.');
  const records = new Map<string, PaymentRecoveryRecord>();
  for (const value of input) {
    assertCurrent(guard, owner);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Payment recovery data is invalid.');
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.peer !== 'string' || !HEX.test(candidate.peer) || typeof candidate.invoiceId !== 'string' || !HEX.test(candidate.invoiceId) || typeof candidate.attemptedAt !== 'number' || !Number.isSafeInteger(candidate.attemptedAt) || candidate.attemptedAt < 0 || candidate.attemptedAt > Date.now() + 60_000 || !['unknown', 'confirmed'].includes(String(candidate.state)) || (candidate.standalone !== undefined && candidate.standalone !== true)) throw new Error('Payment recovery data is invalid.');
    const parsed = parsePayload(JSON.stringify(candidate.invoice));
    if (parsed.type !== 'invoice' || (candidate.standalone === true ? candidate.peer !== owner || candidate.invoiceId !== parsed.paymentHash : candidate.peer === owner)) throw new Error('Payment recovery data belongs to another conversation.');
    const record: PaymentRecoveryRecord = { peer: candidate.peer, invoiceId: candidate.invoiceId, invoice: parsed, attemptedAt: candidate.attemptedAt, state: candidate.state as PaymentRecoveryRecord['state'], ...(candidate.standalone === true ? { standalone: true as const } : {}) };
    if (record.state === 'confirmed') {
      if (typeof candidate.preimage !== 'string' || !await paymentProofMatches(parsed.paymentHash, candidate.preimage, guard)) throw new Error('Saved payment proof does not match this invoice.');
      record.preimage = candidate.preimage;
    } else if (candidate.preimage !== undefined) throw new Error('Unconfirmed payment data cannot claim settlement proof.');
    const key = recoveryKey(owner, record); const existing = records.get(key);
    if (!existing || existing.state !== 'confirmed') records.set(key, record);
  }
  return [...records.values()];
}
export async function readPaymentRecovery(identity: Identity, guard?: AsyncGuard): Promise<PaymentRecoveryRecord[]> {
  const owner = identity.pubkey;
  if (!ownerKey(owner)) throw new Error('This payment recovery account is invalid.');
  assertCurrent(guard, owner);
  const stored = readStored(prefix + 'recovery.' + owner, 101_000, true); if (stored === null) return [];
  try {
    const wrapper = JSON.parse(stored) as { version?: unknown; owner?: unknown; ciphertext?: unknown };
    if (!wrapper || wrapper.version !== 1 || wrapper.owner !== owner || !isNip44Ciphertext(wrapper.ciphertext)) throw new Error();
    const plaintext = await awaitCurrent(identity.decrypt(owner, wrapper.ciphertext, guard), guard, owner);
    if (plaintext.length > MAX_RECOVERY_BYTES || encoder.encode(plaintext).length > MAX_RECOVERY_BYTES) throw new Error();
    const data = JSON.parse(plaintext) as { version?: unknown; owner?: unknown; records?: unknown };
    if (!data || data.version !== 1 || data.owner !== owner) throw new Error();
    const records = await recoveryRecords(owner, data.records, guard); assertCurrent(guard, owner); return records;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Could not read saved payment recovery. Check your wallet before attempting another payment.');
  }
}

const recoveryWrites = new Map<string, Promise<void>>();
export async function savePaymentRecovery(identity: Identity, input: PaymentRecoveryRecord[], guard?: AsyncGuard): Promise<void> {
  const owner = identity.pubkey;
  if (!ownerKey(owner)) throw new Error('This payment recovery account is invalid.');
  assertCurrent(guard, owner); const incoming = await recoveryRecords(owner, input, guard);
  const operation = (recoveryWrites.get(owner) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    assertCurrent(guard, owner);
    const current = await readPaymentRecovery(identity, guard);
    const records = new Map(current.map(record => [recoveryKey(owner, record), record]));
    for (const record of incoming) {
      const key = recoveryKey(owner, record); const existing = records.get(key);
      if (existing?.state === 'confirmed' && record.state === 'unknown') continue;
      records.set(key, { ...record, attemptedAt: Math.min(record.attemptedAt, existing?.attemptedAt ?? record.attemptedAt) });
    }
    const unknown = [...records.values()].filter(record => record.state === 'unknown');
    if (unknown.length > 32) throw new Error('Check existing payments before attempting more. Your unresolved recovery records are preserved.');
    const confirmed = [...records.values()].filter(record => record.state === 'confirmed').sort((a, b) => b.attemptedAt - a.attemptedAt).slice(0, 32);
    const next = [...unknown, ...confirmed].sort((a, b) => a.attemptedAt - b.attemptedAt);
    let plaintext = JSON.stringify({ version: 1, owner, records: next });
    while (encoder.encode(plaintext).length > MAX_RECOVERY_BYTES) {
      const index = next.findIndex(record => record.state === 'confirmed');
      if (index < 0) throw new Error('Payment recovery storage is full. Check unresolved payments before attempting more.');
      next.splice(index, 1); plaintext = JSON.stringify({ version: 1, owner, records: next });
    }
    assertCurrent(guard, owner);
    const ciphertext = await awaitCurrent(identity.encrypt(owner, plaintext, guard), guard, owner);
    if (!isNip44Ciphertext(ciphertext)) throw new Error('Could not encrypt payment recovery data.');
    assertCurrent(guard, owner);
    if (!writeStored(prefix + 'recovery.' + owner, JSON.stringify({ version: 1, owner, ciphertext }))) throw storageError();
  });
  recoveryWrites.set(owner, operation);
  const cleanup = () => { if (recoveryWrites.get(owner) === operation) recoveryWrites.delete(owner); };
  void operation.then(cleanup, cleanup); return awaitCurrent(operation, guard, owner);
}
export function clearLocalAccount(pubkey: string): void {
  if (!ownerKey(pubkey)) return;
  for (const kind of ['contacts', 'events', 'recovery', 'outbox', 'account', 'profile', 'preferences']) {
    try { localStorage.removeItem(prefix + kind + '.' + pubkey); } catch { /* storage may be disabled */ }
  }
  const account = readLockedAccount();
  if (account?.pubkey === pubkey) { try { localStorage.removeItem(prefix + 'vault'); } catch { /* storage may be disabled */ } }
}
