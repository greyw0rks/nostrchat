import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { bech32 } from '@scure/base';
import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools';
import { createGiftWraps, createPracticeIdentity, destroyIdentity, inspectInvoice, unwrapGift, type Identity } from '../apps/nostrchat/src/protocol.ts';
import { clearLocalAccount, exportEncryptedHistory, importEncryptedHistory, readContacts, readEncryptedEvents, readLockedAccount, readPaymentRecovery, saveContacts, saveEncryptedEvent, saveLockedAccount, savePaymentRecovery, validateContacts, type Contact, type PaymentRecoveryRecord } from '../apps/nostrchat/src/storage.ts';
import { invoiceFixture, outerEnvelope } from './nostrchat-fixtures.ts';

class MemoryStorage implements Storage {
  values = new Map<string, string>(); failRead = false; failWrite = false;
  get length() { return this.values.size; }
  getItem(key: string): string | null { if (this.failRead) throw new Error('Synthetic storage disabled'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.failWrite) throw new Error('Synthetic quota exceeded'); this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
}
function storage(t: TestContext): MemoryStorage {
  const store = new MemoryStorage(); const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }); return store;
}
function account(t: TestContext, name: string): Identity { const identity = createPracticeIdentity(name); t.after(() => destroyIdentity(identity)); return identity; }
const key = (kind: string, owner: Identity) => 'nostrchat.v1.' + kind + '.' + owner.pubkey;
function recovery(owner: Identity, peer: Identity, fixture = invoiceFixture()): PaymentRecoveryRecord {
  return { peer: peer.pubkey, invoiceId: crypto.randomUUID().replaceAll('-', '').repeat(2), invoice: fixture.invoice, attemptedAt: Date.now(), state: 'unknown' };
}
function syntheticLockedBackup(): string {
  const bytes = new Uint8Array(91); bytes[0] = 2; bytes[1] = 14; bytes[42] = 2;
  return bech32.encode('ncryptsec', bech32.toWords(bytes), 162);
}

test('contacts are owner scoped, bounded, deduplicated and stripped to public metadata', t => {
  const store = storage(t); const owner = account(t, 'Disposable contacts owner'); const peer = account(t, 'Disposable peer');
  const valid: Contact = { pubkey: peer.pubkey, name: 'Peer', color: 2, note: 'Contact note' };
  saveContacts(owner.pubkey, [valid, { ...valid, name: 'Duplicate' }, { ...valid, pubkey: owner.pubkey }, { ...valid, pubkey: 'invalid' }, { ...valid, color: -1 }, { ...valid, note: 'nostrwalletconnect://synthetic?secret=fixture' }, { ...valid, name: 'x'.repeat(41) }, { ...valid, unknownField: 'PRIVATE_FIELD_SENTINEL' } as Contact]);
  assert.deepEqual(readContacts(owner.pubkey), [valid]);
  assert.equal(store.getItem(key('contacts', owner))!.includes('PRIVATE_FIELD_SENTINEL'), false);
  assert.deepEqual(readContacts(peer.pubkey), []);
  assert.throws(() => validateContacts([{ ...valid, color: 99 }], owner.pubkey), /invalid/);
  assert.throws(() => validateContacts(Array.from({ length: 201 }, () => valid), owner.pubkey), /200/);
  store.setItem(key('contacts', owner), '{corrupt'); assert.deepEqual(readContacts(owner.pubkey), []);
  store.failRead = true; assert.deepEqual(readContacts(owner.pubkey), []);
});

test('encrypted cache skips corrupt, forged, public and wrong-owner objects without losing authentic envelopes', async t => {
  const store = storage(t); const alice = account(t, 'Disposable Alice'); const bob = account(t, 'Disposable Bob');
  const wrapped = await createGiftWraps(alice, bob.pubkey, { type: 'text', text: 'A secret that stays encrypted on disk.' });
  const secret = generateSecretKey(); let publicEvent: NostrEvent;
  try { publicEvent = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), content: 'Public content', tags: [] }, secret); } finally { secret.fill(0); }
  store.setItem(key('events', bob), JSON.stringify([null, 4, {}, publicEvent, wrapped.events[1], { ...wrapped.events[0], content: 'forged' }, wrapped.events[0]]));
  assert.deepEqual(readEncryptedEvents(bob.pubkey).map(event => event.id), [wrapped.events[0].id]);
  assert.equal(store.getItem(key('events', bob))!.includes('Public content'), false);
  const withExtra = { ...wrapped.events[0], rawSecret: 'PRIVATE_FIELD_SENTINEL', plaintext: 'PLAINTEXT_FIELD_SENTINEL' };
  store.setItem(key('events', bob), '[]'); saveEncryptedEvent(bob.pubkey, withExtra);
  const stored = store.getItem(key('events', bob))!;
  assert.equal(stored.includes('secret that stays'), false); assert.equal(stored.includes('FIELD_SENTINEL'), false);
  assert.equal((await unwrapGift(bob, readEncryptedEvents(bob.pubkey)[0])).payload.type, 'text');
  saveEncryptedEvent(bob.pubkey, wrapped.events[0]); assert.equal(readEncryptedEvents(bob.pubkey).length, 1);
});

test('cache writes are best effort when corrupt storage or quota failures would otherwise hide a received message', async t => {
  const store = storage(t); const alice = account(t, 'Disposable Alice'); const bob = account(t, 'Disposable Bob');
  const wraps = await createGiftWraps(alice, bob.pubkey, { type: 'text', text: 'Display me despite the cache quota.' });
  store.setItem(key('events', bob), '[null]'); store.failWrite = true;
  assert.doesNotThrow(() => saveEncryptedEvent(bob.pubkey, wraps.events[0]));
  const received = await unwrapGift(bob, wraps.events[0]); assert.equal(received.state, 'published');
  store.failRead = true; assert.doesNotThrow(() => saveEncryptedEvent(bob.pubkey, wraps.events[0])); assert.deepEqual(readEncryptedEvents(bob.pubkey), []);
});

test('encrypted cache prunes by bytes before a bounded localStorage write', async t => {
  const store = storage(t); const owner = account(t, 'Disposable cache owner'); const events: NostrEvent[] = [];
  for (let i = 0; i < 27; i++) events.push(await outerEnvelope(owner, 'x'.repeat(50_000)));
  while (new TextEncoder().encode(JSON.stringify(events)).length > 2_000_000) events.shift();
  const existingCount = events.length;
  store.setItem(key('events', owner), JSON.stringify(events));
  saveEncryptedEvent(owner.pubkey, await outerEnvelope(owner, 'z'.repeat(50_000)));
  const incoming = await outerEnvelope(owner, 'y'.repeat(50_000));
  saveEncryptedEvent(owner.pubkey, incoming);
  const stored = store.getItem(key('events', owner))!;
  assert.ok(new TextEncoder().encode(stored).length <= 2_000_000);
  assert.equal(readEncryptedEvents(owner.pubkey).some(event => event.id === incoming.id), true);
  assert.ok(readEncryptedEvents(owner.pubkey).length < existingCount + 2);
  assert.ok(readEncryptedEvents(owner.pubkey).length > 20);
});

test('history import validates the whole owner-bound batch before changing the cache', async t => {
  const store = storage(t); const alice = account(t, 'Disposable Alice'); const bob = account(t, 'Disposable Bob');
  const first = await createGiftWraps(alice, bob.pubkey, { type: 'text', text: 'First encrypted backup message' });
  const second = await createGiftWraps(alice, bob.pubkey, { type: 'text', text: 'Second encrypted backup message' });
  saveEncryptedEvent(bob.pubkey, first.events[0]);
  const before = store.getItem(key('events', bob));
  assert.throws(() => importEncryptedHistory(bob.pubkey, { version: 1, owner: alice.pubkey, events: [second.events[0]] }), /another account/);
  assert.throws(() => importEncryptedHistory(bob.pubkey, { version: 1, owner: bob.pubkey, events: [second.events[0], second.events[1]] }), /misaddressed/);
  assert.equal(store.getItem(key('events', bob)), before);
  assert.equal(importEncryptedHistory(bob.pubkey, { version: 1, owner: bob.pubkey, events: [first.events[0], second.events[0]] }), 1);
  assert.equal(importEncryptedHistory(bob.pubkey, exportEncryptedHistory(bob.pubkey)), 0);
  assert.equal(exportEncryptedHistory(bob.pubkey).events.length, 2);
  store.failWrite = true; assert.throws(() => importEncryptedHistory(bob.pubkey, exportEncryptedHistory(bob.pubkey)), /Could not save/);
});

test('locked-account storage validates NIP-49 structure and never writes extra secret fields', t => {
  const store = storage(t); const owner = account(t, 'Disposable vault owner');
  const vault = { pubkey: owner.pubkey, name: 'Local key', encryptedKey: syntheticLockedBackup(), secret: 'PRIVATE_FIELD_SENTINEL' };
  saveLockedAccount(vault); assert.deepEqual(readLockedAccount(), { pubkey: vault.pubkey, name: vault.name, encryptedKey: vault.encryptedKey });
  assert.equal(store.getItem('nostrchat.v1.vault')!.includes('PRIVATE_FIELD_SENTINEL'), false);
  const bytes = new Uint8Array(91); bytes[0] = 2; bytes[1] = 31; bytes[42] = 2;
  assert.throws(() => saveLockedAccount({ ...vault, encryptedKey: bech32.encode('ncryptsec', bech32.toWords(bytes), 162) }), /invalid/);
  store.setItem('nostrchat.v1.vault', JSON.stringify({ ...vault, name: 'x'.repeat(41) })); assert.equal(readLockedAccount(), null);
});

test('attempted payment recovery persists only NIP-44 self ciphertext and survives a new local identity instance', async t => {
  const store = storage(t); const owner = account(t, 'Disposable payer'); const peer = account(t, 'Disposable invoice author');
  const fixture = invoiceFixture(); const record = recovery(owner, peer, fixture);
  await savePaymentRecovery(owner, [record], { expectedPubkey: owner.pubkey });
  const persisted = store.getItem(key('recovery', owner))!;
  assert.equal(persisted.includes(fixture.invoice.bolt11), false); assert.equal(persisted.includes(fixture.invoice.description), false); assert.equal(persisted.includes(fixture.preimage), false); assert.equal(persisted.includes(record.peer), false);
  const restored = createPracticeIdentity('Restored disposable payer', owner.secret); t.after(() => destroyIdentity(restored));
  assert.deepEqual(await readPaymentRecovery(restored), [record]);
});

test('parallel recovery updates retain unresolved attempts and confirmed proof never downgrades', async t => {
  storage(t); const owner = account(t, 'Disposable payer'); const peer = account(t, 'Disposable author');
  const fixture = invoiceFixture(); const one = recovery(owner, peer, fixture); const two = recovery(owner, peer);
  await Promise.all([savePaymentRecovery(owner, [one]), savePaymentRecovery(owner, [two])]);
  assert.equal((await readPaymentRecovery(owner)).length, 2);
  await savePaymentRecovery(owner, [{ ...one, state: 'confirmed', preimage: fixture.preimage }]);
  await savePaymentRecovery(owner, [one]);
  const saved = await readPaymentRecovery(owner);
  assert.equal(saved.find(record => record.invoiceId === one.invoiceId)?.state, 'confirmed');
  assert.equal(saved.find(record => record.invoiceId === two.invoiceId)?.state, 'unknown');
});

test('standalone hash-only invoices retain exact opaque description facts in encrypted recovery', async t => {
  storage(t); const owner = account(t, 'Disposable payer'); const fixture = invoiceFixture({ descriptionHash: true });
  const descriptionHash = inspectInvoice(fixture.invoice.bolt11).descriptionHash!;
  const invoice = { ...fixture.invoice, description: '', descriptionHash };
  const record: PaymentRecoveryRecord = { peer: owner.pubkey, invoiceId: invoice.paymentHash, invoice, attemptedAt: Date.now(), state: 'unknown', standalone: true };
  await savePaymentRecovery(owner, [record]); assert.deepEqual(await readPaymentRecovery(owner), [record]);
  await assert.rejects(savePaymentRecovery(owner, [{ ...record, invoice: { ...invoice, descriptionHash: '00'.repeat(32) } }]), /do not match/);
  assert.deepEqual(await readPaymentRecovery(owner), [record]);
});

test('recovery claims require exact proof and standalone invoices use an explicit owner sentinel', async t => {
  storage(t); const owner = account(t, 'Disposable payer'); const peer = account(t, 'Disposable author'); const fixture = invoiceFixture();
  const record = recovery(owner, peer, fixture);
  await assert.rejects(savePaymentRecovery(owner, [{ ...record, state: 'confirmed', preimage: '00'.repeat(32) }]), /proof does not match/);
  await assert.rejects(savePaymentRecovery(owner, [{ ...record, preimage: fixture.preimage }]), /Unconfirmed/);
  await assert.rejects(savePaymentRecovery(owner, [{ ...record, peer: owner.pubkey }]), /another conversation/);
  const standalone: PaymentRecoveryRecord = { ...record, peer: owner.pubkey, invoiceId: fixture.invoice.paymentHash, standalone: true };
  await savePaymentRecovery(owner, [standalone]); assert.deepEqual(await readPaymentRecovery(owner), [standalone]);
  await assert.rejects(savePaymentRecovery(owner, [{ ...standalone, peer: peer.pubkey }]), /another conversation/);
});

test('disabled, full, copied or corrupted recovery storage fails closed before another payment attempt', async t => {
  const store = storage(t); const owner = account(t, 'Disposable payer'); const other = account(t, 'Disposable other payer'); const peer = account(t, 'Disposable author');
  const record = recovery(owner, peer);
  store.failRead = true; await assert.rejects(readPaymentRecovery(owner), /wallet/i); store.failRead = false;
  store.failWrite = true; await assert.rejects(savePaymentRecovery(owner, [record]), /wallet/i); store.failWrite = false;
  await savePaymentRecovery(owner, [record]); const original = store.getItem(key('recovery', owner))!;
  store.setItem(key('recovery', other), original); await assert.rejects(readPaymentRecovery(other), /saved payment recovery/);
  store.setItem(key('recovery', owner), '{corrupt'); await assert.rejects(readPaymentRecovery(owner), /saved payment recovery/);
  await assert.rejects(savePaymentRecovery(owner, [record]), /saved payment recovery/);
});

test('late self-encryption cannot persist a recovery record after an identity switch', async t => {
  const store = storage(t); const owner = account(t, 'Disposable payer'); const peer = account(t, 'Disposable author'); const record = recovery(owner, peer);
  let current = true; let release!: (value: string) => void; let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const identity: Identity = { ...owner, encrypt: async () => { started(); return new Promise<string>(resolve => { release = resolve; }); } };
  const pending = savePaymentRecovery(identity, [record], { expectedPubkey: owner.pubkey, isCurrent: () => current });
  await began; current = false; release(await owner.encrypt(owner.pubkey, '{"late":"ciphertext"}'));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(store.getItem(key('recovery', owner)), null);
});

test('clearing a device account removes its private caches while preserving other owners', t => {
  const store = storage(t); const owner = account(t, 'Disposable owner'); const other = account(t, 'Disposable other owner');
  for (const kind of ['contacts', 'events', 'recovery', 'outbox', 'account', 'profile', 'preferences']) { store.setItem(key(kind, owner), 'local fixture'); store.setItem(key(kind, other), 'other local fixture'); }
  saveLockedAccount({ pubkey: owner.pubkey, name: 'Local key', encryptedKey: syntheticLockedBackup() });
  clearLocalAccount(owner.pubkey);
  for (const kind of ['contacts', 'events', 'recovery', 'outbox', 'account', 'profile', 'preferences']) { assert.equal(store.getItem(key(kind, owner)), null); assert.equal(store.getItem(key(kind, other)), 'other local fixture'); }
  assert.equal(readLockedAccount(), null);
});
