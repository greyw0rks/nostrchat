import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import { bech32, utils } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { finalizeEvent, getEventHash, getPublicKey, type NostrEvent } from 'nostr-tools';
import { encrypt, getConversationKey } from 'nostr-tools/nip44';
import { createWrap } from 'nostr-tools/nip59';
import schema from '../convex/schema';
import { internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { digestHex } from '../convex/lib';
import { signedBolt11 } from '../packages/chat/src/invoice';
import { CHAT_OUTBOX_COUNT } from '../packages/chat/src/validation';
import type { WalletInvoice } from '../packages/nwc-gate/src/types';

// Every identity, preimage, ciphertext, invoice, and session below is synthetic.
// These tests call Convex's in-memory model only; they never open a wallet or relay.
const modules = import.meta.glob('../convex/**/*.{ts,js}');
type T = TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 17, 12);
const secret = (byte: number) => new Uint8Array(32).fill(byte);
const OWNER_SECRET = secret(1), OTHER_SECRET = secret(2), SENDER_SECRET = secret(3);
const OWNER = getPublicKey(OWNER_SECRET), OTHER = getPublicKey(OTHER_SECRET), SENDER = getPublicKey(SENDER_SECRET);
const SERVICE = getPublicKey(secret(4));
const TOKEN = digestHex('synthetic-nostrchat-owner-session'), OTHER_TOKEN = digestHex('synthetic-nostrchat-other-session');
const VERSION = digestHex('synthetic-chat-connection-version'), NEXT_VERSION = digestHex('synthetic-next-chat-connection-version');
const FINGERPRINT = digestHex('synthetic-chat-source'), NEXT_FINGERPRINT = digestHex('synthetic-next-chat-source');
const PREIMAGE = '11'.repeat(32), PAYMENT_HASH = digestHex(Buffer.from(PREIMAGE, 'hex'));
const REVIEW_ID = '10000000-0000-4000-8000-000000000001', NEXT_REVIEW_ID = '10000000-0000-4000-8000-000000000002';
const ATTEMPT = 'synthetic-chat-attempt';
const auth = (owner = OWNER, now = NOW) => ({ tokenHash: owner === OWNER ? TOKEN : OTHER_TOKEN, expectedPubkey: owner, now });

function integerWords(input: number, width = 0): number[] {
  const result: number[] = [];
  do { result.unshift(input % 32); input = Math.floor(input / 32); } while (input > 0);
  while (result.length < width) result.unshift(0);
  return result;
}
const tag = (code: number, value: number[]) => [code, Math.floor(value.length / 32), value.length % 32, ...value];
function fixtureInvoice({ amountSats = 100, network = 'regtest', expiresSeconds = 600, payeeTag = true, timestamp = NOW / 1000, paymentHash = PAYMENT_HASH } = {}): WalletInvoice {
  const description = 'Synthetic NostrChat payment request';
  const prefix = `ln${network === 'regtest' ? 'bcrt' : network === 'signet' ? 'tbs' : 'bc'}${amountSats * 10}n`;
  const payeeKey = secret(5);
  const data = [
    ...integerWords(timestamp, 7),
    ...tag(1, bech32.toWords(Buffer.from(paymentHash, 'hex'))),
    ...tag(13, bech32.toWords(new TextEncoder().encode(description))),
    ...tag(6, integerWords(expiresSeconds)),
    ...(payeeTag ? tag(19, bech32.toWords(secp256k1.getPublicKey(payeeKey))) : []),
  ];
  const prefixBytes = new TextEncoder().encode(prefix), dataBytes = Uint8Array.from(utils.convertRadix2(data, 5, 8, true));
  const message = new Uint8Array(prefixBytes.length + dataBytes.length);
  message.set(prefixBytes); message.set(dataBytes, prefixBytes.length);
  const recovered = secp256k1.sign(sha256(message), payeeKey, { prehash: false, format: 'recovered' });
  const signature = new Uint8Array(65);
  signature.set(recovered.subarray(1)); signature[64] = recovered[0]; payeeKey.fill(0);
  const bolt11 = bech32.encode(prefix, [...data, ...bech32.toWords(signature)], 12_000);
  return { paymentHash, bolt11, amountSats, description, expiresAt: (timestamp + expiresSeconds) * 1000, state: 'pending' };
}
function amountTamperedInvoice(bolt11: string): string {
  const decoded = bech32.decode(bolt11 as `${string}1${string}`, 12_000);
  return bech32.encode('lnbcrt2000n', decoded.words, 12_000);
}
function invalidSignatureInvoice(bolt11: string): string {
  const decoded = bech32.decode(bolt11 as `${string}1${string}`, 12_000);
  return bech32.encode(decoded.prefix, [...decoded.words.slice(0, -104), ...new Array<number>(104).fill(0)], 12_000);
}
function selfCiphertext(plaintext = 'Synthetic private account data', owner = OWNER): string {
  const conversation = getConversationKey(owner === OWNER ? OWNER_SECRET : OTHER_SECRET, owner);
  try { return encrypt(plaintext, conversation); } finally { conversation.fill(0); }
}
function envelope(owner = OWNER, text = 'A synthetic private message'): NostrEvent {
  const rumor = { kind: 14, pubkey: SENDER, created_at: NOW / 1000, content: text, tags: [['p', owner]], id: '' };
  rumor.id = getEventHash(rumor);
  const conversation = getConversationKey(SENDER_SECRET, owner);
  try {
    const seal = finalizeEvent({ kind: 13, created_at: NOW / 1000, tags: [], content: encrypt(JSON.stringify(rumor), conversation) }, SENDER_SECRET);
    // A relay transports JSON; verification Symbols do not cross that boundary.
    return JSON.parse(JSON.stringify(createWrap(seal, owner))) as NostrEvent;
  } finally { conversation.fill(0); }
}
async function harness(connected = true): Promise<T> {
  const t = convexTest({ schema, modules, transactionLimits: true });
  await t.run(async ctx => {
    for (const [pubkey, tokenHash] of [[OWNER, TOKEN], [OTHER, OTHER_TOKEN]]) {
      await ctx.db.insert('users', { pubkey, createdAt: NOW });
      await ctx.db.insert('sessions', { pubkey, tokenHash, createdAt: NOW, expiresAt: NOW + 12 * 3600000 });
    }
    // An existing company connection must never become the chat connection.
    await ctx.db.insert('walletConnections', { pubkey: OWNER, sealedUri: 'v1.synthetic-finance-sealed-credential', version: NEXT_VERSION, walletPubkey: SERVICE, connectionFingerprint: NEXT_FINGERPRINT, network: 'bitcoin', updatedAt: NOW });
    if (connected) await ctx.db.insert('chatWalletConnections', { pubkey: OWNER, sealedUri: 'v1.synthetic-chat-encrypted-credential'.padEnd(80, 'x'), version: VERSION, walletPubkey: SERVICE, connectionFingerprint: FINGERPRINT, network: 'regtest', updatedAt: NOW });
  });
  return t;
}
async function rotateWallet(t: T, fingerprint = FINGERPRINT, version = NEXT_VERSION) {
  await t.run(async ctx => {
    const row = await ctx.db.query('chatWalletConnections').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique();
    await ctx.db.patch(row!._id, { version, connectionFingerprint: fingerprint });
  });
}
const review = (t: T, invoice = fixtureInvoice(), reviewId = REVIEW_ID, now = NOW) => t.mutation(internal.chatModel.createReview, { ...auth(OWNER, now), reviewId, bolt11: invoice.bolt11, walletFingerprint: FINGERPRINT, connectionVersion: VERSION, alias: 'Synthetic chat wallet' });
const claim = (t: T, reviewId = REVIEW_ID, now = NOW, attemptId = ATTEMPT) => t.mutation(internal.chatModel.claimPayment, { ...auth(OWNER, now), reviewId, attemptId, walletFingerprint: FINGERPRINT, connectionVersion: VERSION });
const recordInvoice = (t: T, invoice = fixtureInvoice()) => t.mutation(internal.chatModel.recordInvoice, { ...auth(), invoice, walletFingerprint: FINGERPRINT, connectionVersion: VERSION });
const receipt = (t: T, now = NOW) => t.query(internal.chatModel.paymentReceipt, { ...auth(OWNER, now), paymentHash: PAYMENT_HASH });
const settle = (t: T, id: Id<'chatPayments'>, overrides: Partial<{ attemptId: string; paymentHash: string; preimage: string; walletFingerprint: string; now: number }> = {}) => t.mutation(internal.chatModel.settlePayment, { id, attemptId: ATTEMPT, paymentHash: PAYMENT_HASH, preimage: PREIMAGE, walletFingerprint: FINGERPRINT, now: NOW + 1000, ...overrides });

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); });

describe('NostrChat model account and encrypted storage boundaries', () => {
  test('unauthenticated, expired, and mismatched identities cannot read or write chat data', async () => {
    const t = await harness();
    await expect(t.query(internal.chatModel.account, { ...auth(), tokenHash: digestHex('missing-session') })).rejects.toMatchObject({ data: { code: 'AUTH_REQUIRED' } });
    await expect(t.query(internal.chatModel.account, auth(OWNER, NOW + 12 * 3600000))).rejects.toMatchObject({ data: { code: 'AUTH_REQUIRED' } });
    for (const read of [internal.chatModel.account, internal.chatModel.history, internal.chatModel.outbox, internal.chatModel.walletContext]) {
      await expect(t.query(read, { ...auth(), expectedPubkey: OTHER })).rejects.toMatchObject({ data: { code: 'IDENTITY_CHANGED' } });
    }
    await expect(t.mutation(internal.chatModel.saveAccount, { ...auth(), expectedPubkey: OTHER, input: { ciphertext: selfCiphertext(), expectedRevision: 0 } })).rejects.toMatchObject({ data: { code: 'IDENTITY_CHANGED' } });
    expect(await t.run(ctx => ctx.db.query('chatAccounts').collect())).toEqual([]);
  });

  test('encrypted account saves use an owner namespace and reject stale revisions', async () => {
    const t = await harness(); const ciphertext = selfCiphertext('Private names and contacts stay encrypted');
    expect(await t.query(internal.chatModel.account, auth())).toMatchObject({ pubkey: OWNER, ciphertext: null, revision: 0 });
    expect(await t.mutation(internal.chatModel.saveAccount, { ...auth(), input: { ciphertext, expectedRevision: 0 } })).toMatchObject({ pubkey: OWNER, ciphertext, revision: 1 });
    await expect(t.mutation(internal.chatModel.saveAccount, { ...auth(), input: { ciphertext: selfCiphertext('Stale overwrite'), expectedRevision: 0 } })).rejects.toMatchObject({ data: { code: 'REVISION_CONFLICT' } });
    expect(await t.query(internal.chatModel.account, auth(OTHER))).toMatchObject({ pubkey: OTHER, ciphertext: null, revision: 0 });
    const stored = await t.run(ctx => ctx.db.query('chatAccounts').collect());
    expect(stored).toHaveLength(1); expect(JSON.stringify(stored)).not.toContain('Private names and contacts');
    expect(stored[0].ciphertext).toBe(ciphertext);
  });

  test('two concurrent account edits admit one revision without a lost update', async () => {
    const t = await harness();
    const results = await Promise.allSettled(['First edit', 'Second edit'].map(text => t.mutation(internal.chatModel.saveAccount, { ...auth(), input: { ciphertext: selfCiphertext(text), expectedRevision: 0 } })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await t.query(internal.chatModel.account, auth())).toMatchObject({ revision: 1 });
  });

  test('the supported 60KB private payload fits both profile and retry ciphertext bounds', async () => {
    const t = await harness(); const ciphertext = selfCiphertext('é'.repeat(30000));
    expect(ciphertext.length).toBeGreaterThan(65536);
    await t.mutation(internal.chatModel.saveAccount, { ...auth(), input: { ciphertext, expectedRevision: 0 } });
    await t.mutation(internal.chatModel.saveOutbox, { ...auth(), input: { id: digestHex('large-retry-packet'), ciphertext, state: 'queued' } });
    expect(await t.query(internal.chatModel.account, auth())).toMatchObject({ ciphertext, revision: 1 });
    expect((await t.query(internal.chatModel.outbox, auth())).items[0].ciphertext).toBe(ciphertext);
  });

  test.each(['plaintext message', 'nostr+walletconnect://synthetic-secret', 'nsec1syntheticprivatekey', 'A'.repeat(132)])('plaintext and invalid ciphertext cannot become a profile or outbox (%s)', async value => {
    const t = await harness();
    await expect(t.mutation(internal.chatModel.saveAccount, { ...auth(), input: { ciphertext: value, expectedRevision: 0 } })).rejects.toMatchObject({ data: { code: 'INVALID_CIPHERTEXT' } });
    await expect(t.mutation(internal.chatModel.saveOutbox, { ...auth(), input: { id: digestHex('invalid-outbox'), ciphertext: value, state: 'queued' } })).rejects.toMatchObject({ data: { code: 'INVALID_CIPHERTEXT' } });
    expect(await t.run(ctx => ctx.db.query('chatAccounts').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('chatOutbox').collect())).toEqual([]);
  });

  test('history accepts owner-addressed encrypted events and deduplicates replays', async () => {
    const t = await harness(), event = envelope();
    expect(await t.mutation(internal.chatModel.saveHistory, { ...auth(), input: { event } })).toEqual({ saved: true, duplicate: false });
    expect(await t.mutation(internal.chatModel.saveHistory, { ...auth(), input: { event } })).toEqual({ saved: true, duplicate: true });
    const page = await t.query(internal.chatModel.history, auth()); expect(page.events).toEqual([event]);
    expect(await t.query(internal.chatModel.history, auth(OTHER))).toMatchObject({ events: [] });
    const usage = await t.run(ctx => ctx.db.query('chatUsage').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique());
    expect(usage!.historyCount).toBe(1); expect(usage!.historyBytes).toBe(new TextEncoder().encode(JSON.stringify(event)).length);
    expect(JSON.stringify(await t.run(ctx => ctx.db.query('chatHistory').collect()))).not.toContain('A synthetic private message');
  });

  test('wrong recipients, duplicate recipient tags, and mutation after cached signature verification are rejected', async () => {
    const t = await harness(); const event = envelope();
    await expect(t.mutation(internal.chatModel.saveHistory, { ...auth(), input: { event: envelope(OTHER) } })).rejects.toMatchObject({ data: { code: 'WRONG_RECIPIENT' } });
    const duplicateRecipient = finalizeEvent({ kind: 1059, created_at: NOW / 1000, content: event.content, tags: [['p', OWNER], ['p', OWNER]] }, SENDER_SECRET);
    await expect(t.mutation(internal.chatModel.saveHistory, { ...auth(), input: { event: duplicateRecipient } })).rejects.toMatchObject({ data: { code: 'WRONG_RECIPIENT' } });
    const modified = finalizeEvent({ kind: 1059, created_at: NOW / 1000, content: event.content, tags: [['p', OWNER]] }, SENDER_SECRET);
    modified.content = selfCiphertext('Different content after nostr-tools marked the object verified');
    await expect(t.mutation(internal.chatModel.saveHistory, { ...auth(), input: { event: modified } })).rejects.toMatchObject({ data: { code: 'INVALID_ENVELOPE' } });
    expect(await t.run(ctx => ctx.db.query('chatHistory').collect())).toEqual([]);
  });

  test('history pagination and confirmed clearing remain scoped to the authenticated owner', async () => {
    const t = await harness(); const events = [envelope(OWNER, 'One'), envelope(OWNER, 'Two'), envelope(OWNER, 'Three')];
    for (let index = 0; index < events.length; index++) await t.mutation(internal.chatModel.saveHistory, { ...auth(OWNER, NOW + index), input: { event: events[index] } });
    const other = envelope(OTHER, 'Other inbox'); await t.mutation(internal.chatModel.saveHistory, { ...auth(OTHER), input: { event: other } });
    const page = await t.query(internal.chatModel.history, { ...auth(), limit: 2 }); expect(page.events).toEqual([events[2], events[1]]); expect(page.hasMore).toBe(true);
    const older = await t.query(internal.chatModel.history, { ...auth(), limit: 2, cursor: page.cursor }); expect(older.events).toEqual([events[0]]); expect(older.hasMore).toBe(false);
    await expect(t.query(internal.chatModel.history, { ...auth(), limit: 51 })).rejects.toMatchObject({ data: { code: 'INVALID_PAGE' } });
    await expect(t.mutation(internal.chatModel.clearHistory, { ...auth(), input: { confirmed: false } })).rejects.toMatchObject({ data: { code: 'INVALID_INPUT' } });
    await t.mutation(internal.chatModel.clearHistory, { ...auth(), input: { confirmed: true } });
    expect(await t.query(internal.chatModel.history, auth())).toMatchObject({ events: [] }); expect(await t.query(internal.chatModel.history, auth(OTHER))).toMatchObject({ events: [other] });
    expect(await t.run(ctx => ctx.db.query('chatUsage').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique())).toMatchObject({ historyBytes: 0, historyCount: 0 });
  });

  test('outbox ciphertext is immutable, published state cannot regress, and deletion is owner-confirmed', async () => {
    const t = await harness(); const id = digestHex('Synthetic retry bundle'), ciphertext = selfCiphertext('Exact encrypted retry bundle');
    const save = (state: 'queued' | 'published', owner = OWNER, value = ciphertext) => t.mutation(internal.chatModel.saveOutbox, { ...auth(owner), input: { id, ciphertext: value, state } });
    await save('queued'); await save('published'); expect(await save('queued')).toMatchObject({ state: 'published' });
    await expect(save('queued', OWNER, selfCiphertext('Different retry bundle'))).rejects.toMatchObject({ data: { code: 'OUTBOX_CONFLICT' } });
    expect(await t.query(internal.chatModel.outbox, auth(OTHER))).toMatchObject({ items: [] });
    await expect(t.mutation(internal.chatModel.deleteOutbox, { ...auth(), id, input: {} })).rejects.toMatchObject({ data: { code: 'INVALID_INPUT' } });
    await t.mutation(internal.chatModel.deleteOutbox, { ...auth(OTHER), id, input: { confirmed: true } }); expect((await t.query(internal.chatModel.outbox, auth())).items).toHaveLength(1);
    await t.mutation(internal.chatModel.deleteOutbox, { ...auth(), id, input: { confirmed: true } }); expect((await t.query(internal.chatModel.outbox, auth())).items).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.query('chatUsage').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique())).toMatchObject({ outboxBytes: 0, outboxCount: 0 });
  });

  test('outbox capacity is enforced and paginated entries remain recoverable after more than 20 sends', async () => {
    const t = await harness(); const ciphertext = selfCiphertext('Synthetic saved retry bundle');
    for (let index = 0; index < CHAT_OUTBOX_COUNT; index++) await t.mutation(internal.chatModel.saveOutbox, { ...auth(OWNER, NOW + index), input: { id: digestHex('outbox-item-' + index), ciphertext, state: index < 25 ? 'published' : 'queued' } });
    await expect(t.mutation(internal.chatModel.saveOutbox, { ...auth(), input: { id: digestHex('capacity-excess'), ciphertext, state: 'queued' } })).rejects.toMatchObject({ data: { code: 'OUTBOX_FULL' } });
    const first = await t.query(internal.chatModel.outbox, auth()); expect(first.items).toHaveLength(20); expect(first.hasMore).toBe(true);
    const second = await t.query(internal.chatModel.outbox, { ...auth(), cursor: first.cursor, limit: 50 }); expect(second.items).toHaveLength(50); expect(second.items.some(item => item.state === 'queued')).toBe(true);
    await t.mutation(internal.chatModel.deleteOutbox, { ...auth(), id: first.items[0].id, input: { confirmed: true } });
    await t.mutation(internal.chatModel.saveOutbox, { ...auth(), input: { id: digestHex('capacity-excess'), ciphertext, state: 'queued' } });
  });
});

describe('NostrChat invoice and immutable payment review boundaries', () => {
  test('signed BOLT11 fixtures verify with explicit and recovered payees; n-bound amount tampering and invalid signatures fail', () => {
    const explicit = fixtureInvoice(), recovered = fixtureInvoice({ payeeTag: false });
    expect(signedBolt11(explicit.bolt11)).toMatchObject({ paymentHash: PAYMENT_HASH, amountSats: 100, network: 'regtest' });
    expect(signedBolt11(recovered.bolt11)).toMatchObject({ paymentHash: PAYMENT_HASH, amountSats: 100, network: 'regtest' });
    expect(signedBolt11(explicit.bolt11).payeePubkey).toBe(signedBolt11(recovered.bolt11).payeePubkey);
    expect(() => signedBolt11(amountTamperedInvoice(explicit.bolt11))).toThrow();
    expect(() => signedBolt11(invalidSignatureInvoice(explicit.bolt11))).toThrow();
    expect(() => signedBolt11(explicit.bolt11.slice(0, -1))).toThrow();
  });

  test('chat wallet context is isolated from the pre-existing company connection', async () => {
    const t = await harness(false);
    expect(await t.query(internal.chatModel.walletContext, auth())).toMatchObject({ pubkey: OWNER, connection: null });
    await t.mutation(internal.chatModel.saveConnection, { ...auth(), sealedUri: 'v1.synthetic-chat-encrypted-credential'.padEnd(80, 'x'), version: VERSION, walletPubkey: SERVICE, connectionFingerprint: FINGERPRINT, network: 'regtest' });
    expect((await t.query(internal.chatModel.walletContext, auth())).connection).toMatchObject({ connectionFingerprint: FINGERPRINT, version: VERSION, network: 'regtest' });
    await t.mutation(internal.chatModel.disconnect, auth()); expect((await t.query(internal.chatModel.walletContext, auth())).connection).toBeNull();
    expect(await t.run(ctx => ctx.db.query('walletConnections').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique())).toMatchObject({ connectionFingerprint: NEXT_FINGERPRINT, version: NEXT_VERSION });
  });

  test('receiving invoices must match their signed amount, expiry, network, and unsettled provider state', async () => {
    const t = await harness(), invoice = fixtureInvoice();
    for (const value of [{ ...invoice, amountSats: 101 }, { ...invoice, expiresAt: invoice.expiresAt + 1000 }, { ...invoice, state: 'settled' as const, preimage: PREIMAGE }, fixtureInvoice({ network: 'bitcoin' })]) {
      await expect(recordInvoice(t, value)).rejects.toMatchObject({ data: { code: 'INVOICE_MISMATCH' } });
    }
    expect(await recordInvoice(t, invoice)).toMatchObject(invoice);
    await expect(recordInvoice(t, invoice)).rejects.toMatchObject({ data: { code: 'DUPLICATE_INVOICE' } });
    expect(await t.query(internal.chatModel.invoice, { ...auth(OTHER), paymentHash: PAYMENT_HASH })).toBeNull();
    await expect(t.query(internal.chatModel.invoiceReceipt, { ...auth(OTHER), paymentHash: PAYMENT_HASH })).rejects.toMatchObject({ data: { code: 'INVOICE_NOT_FOUND' } });
  });

  test('receiving settlement requires matching proof and source, and a late expired result cannot erase it', async () => {
    const t = await harness(), invoice = fixtureInvoice(); await recordInvoice(t, invoice);
    const verify = (verified: WalletInvoice, fingerprint = FINGERPRINT, version = VERSION) => t.mutation(internal.chatModel.verifyInvoice, { ...auth(OWNER, NOW + 1000), verified, walletFingerprint: fingerprint, connectionVersion: version });
    await expect(verify({ ...invoice, state: 'settled', preimage: '22'.repeat(32) })).rejects.toMatchObject({ data: { code: 'UNVERIFIED_PROOF' } });
    await expect(verify({ ...invoice, state: 'settled', preimage: PREIMAGE }, NEXT_FINGERPRINT)).rejects.toMatchObject({ data: { code: 'WALLET_CHANGED' } });
    const settled = await verify({ ...invoice, state: 'settled', preimage: PREIMAGE, settledAt: NOW + 1000 }); expect(settled).toMatchObject({ state: 'settled', preimage: PREIMAGE });
    await rotateWallet(t, NEXT_FINGERPRINT);
    expect(await verify({ ...invoice, state: 'expired' })).toEqual(settled);
    expect(await t.query(internal.chatModel.invoiceReceipt, { ...auth(), paymentHash: PAYMENT_HASH })).toEqual(settled);
  });

  test('reviews reject invalid signatures and wrong networks before a payment journal exists', async () => {
    const t = await harness();
    await expect(review(t, fixtureInvoice({ network: 'bitcoin' }))).rejects.toMatchObject({ data: { code: 'WRONG_NETWORK' } });
    await expect(review(t, { ...fixtureInvoice(), bolt11: amountTamperedInvoice(fixtureInvoice().bolt11) })).rejects.toMatchObject({ data: { code: 'INVALID_INVOICE_SIGNATURE' } });
    await expect(review(t, { ...fixtureInvoice(), bolt11: invalidSignatureInvoice(fixtureInvoice().bolt11) })).rejects.toMatchObject({ data: { code: 'INVALID_INVOICE_SIGNATURE' } });
    expect(await t.run(ctx => ctx.db.query('chatPaymentReviews').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toEqual([]);
  });

  test('a review fixes invoice facts and wallet reference and is inaccessible to another identity', async () => {
    const t = await harness(), invoice = fixtureInvoice();
    expect(await review(t, invoice)).toMatchObject({ reviewId: REVIEW_ID, paymentHash: PAYMENT_HASH, amountSats: 100, network: 'regtest', expiresAt: invoice.expiresAt, reviewExpiresAt: NOW + 90000, walletReference: FINGERPRINT });
    await expect(t.query(internal.chatModel.review, { ...auth(OTHER), reviewId: REVIEW_ID })).rejects.toMatchObject({ data: { code: 'REVIEW_NOT_FOUND' } });
    await expect(t.mutation(internal.chatModel.claimPayment, { ...auth(OTHER), reviewId: REVIEW_ID, attemptId: 'foreign-attempt', walletFingerprint: FINGERPRINT, connectionVersion: VERSION })).rejects.toMatchObject({ data: { code: 'REVIEW_NOT_FOUND' } });
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toEqual([]);
  });

  test('a duplicate review ID cannot replace facts or break the immutable review lookup', async () => {
    const t = await harness(); await review(t);
    await expect(review(t, fixtureInvoice({ amountSats: 200 }), REVIEW_ID)).rejects.toMatchObject({ data: { code: 'DUPLICATE_REVIEW' } });
    expect(await t.query(internal.chatModel.review, { ...auth(), reviewId: REVIEW_ID })).toMatchObject({ amountSats: 100, paymentHash: PAYMENT_HASH });
    expect(await t.run(ctx => ctx.db.query('chatPaymentReviews').collect())).toHaveLength(1);
  });

  test.each([['same source reconnected', FINGERPRINT], ['rotated delegated source', NEXT_FINGERPRINT]])('a wallet %s after preview requires a fresh review', async (_label, fingerprint) => {
    const t = await harness(); await review(t); await rotateWallet(t, fingerprint);
    await expect(claim(t)).rejects.toMatchObject({ data: { code: 'WALLET_CHANGED' } });
    await expect(t.query(internal.chatModel.assertWallet, { ...auth(), walletFingerprint: FINGERPRINT, connectionVersion: VERSION })).rejects.toMatchObject({ data: { code: 'WALLET_CHANGED' } });
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toEqual([]);
  });

  test('an unattempted expired review cannot claim payment', async () => {
    const t = await harness(); await review(t);
    await expect(claim(t, REVIEW_ID, NOW + 90000)).rejects.toMatchObject({ data: { code: 'REVIEW_EXPIRED' } });
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toEqual([]);
  });
});

describe('NostrChat durable payment claims and reconciliation', () => {
  test('concurrent confirmations create one attempt and expose only an existing receipt to the second caller', async () => {
    const t = await harness(); await review(t);
    const results = await Promise.all([claim(t, REVIEW_ID, NOW, ATTEMPT), claim(t, REVIEW_ID, NOW, 'synthetic-concurrent-attempt')]);
    expect(results.filter(result => result.existing === null)).toHaveLength(1); expect(results.filter(result => result.existing !== null)).toHaveLength(1);
    expect(results[0].id).toBe(results[1].id);
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toHaveLength(1);
  });

  test('an unknown attempt survives expiry and repeated confirmations cannot make a new claim', async () => {
    const t = await harness(); const invoice = fixtureInvoice(); await review(t, invoice); const first = await claim(t);
    await t.mutation(internal.chatModel.markPaymentUnknown, { id: first.id, attemptId: ATTEMPT });
    const expiredNow = invoice.expiresAt + 1000;
    expect(await receipt(t, expiredNow)).toMatchObject({ paymentHash: PAYMENT_HASH, state: 'unknown', amountSats: 100 });
    expect(await claim(t, REVIEW_ID, expiredNow, 'forbidden-repeat')).toMatchObject({ id: first.id, existing: { state: 'unknown' } });
    expect(await t.query(internal.chatModel.paymentReceipt, { ...auth(OTHER, expiredNow), paymentHash: PAYMENT_HASH })).toEqual({ paymentHash: PAYMENT_HASH, state: 'not_found' });
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toHaveLength(1);
    expect(await t.query(internal.chatModel.payment, { ...auth(), paymentHash: PAYMENT_HASH })).toMatchObject({ attemptId: ATTEMPT, state: 'unknown', walletFingerprint: FINGERPRINT, connectionVersion: VERSION });
  });

  test('another account cannot claim an invoice whose hash already has a payment attempt', async () => {
    const t = await harness(); await review(t); await claim(t);
    await t.mutation(internal.chatModel.saveConnection, { ...auth(OTHER), sealedUri: 'v1.synthetic-other-chat-encrypted-credential'.padEnd(80, 'x'), version: VERSION, walletPubkey: SERVICE, connectionFingerprint: FINGERPRINT, network: 'regtest' });
    await t.mutation(internal.chatModel.createReview, { ...auth(OTHER), reviewId: NEXT_REVIEW_ID, bolt11: fixtureInvoice().bolt11, walletFingerprint: FINGERPRINT, connectionVersion: VERSION });
    await expect(t.mutation(internal.chatModel.claimPayment, { ...auth(OTHER), reviewId: NEXT_REVIEW_ID, attemptId: 'foreign-repeat', walletFingerprint: FINGERPRINT, connectionVersion: VERSION })).rejects.toMatchObject({ data: { code: 'PAYMENT_ALREADY_REQUESTED' } });
    expect(await t.run(ctx => ctx.db.query('chatPayments').collect())).toHaveLength(1);
  });

  test.each(['attempt', 'hash', 'preimage', 'source'])('settlement rejects a changed %s without altering the durable unknown record', async mismatch => {
    const t = await harness(); await review(t); const first = await claim(t);
    await t.mutation(internal.chatModel.markPaymentUnknown, { id: first.id, attemptId: ATTEMPT });
    const changes = { attempt: { attemptId: 'different-attempt' }, hash: { paymentHash: digestHex('different-hash') }, preimage: { preimage: '22'.repeat(32) }, source: { walletFingerprint: NEXT_FINGERPRINT } };
    await expect(settle(t, first.id, changes[mismatch as keyof typeof changes])).rejects.toMatchObject({ data: { code: 'UNVERIFIED_PROOF' } });
    expect(await receipt(t)).toMatchObject({ state: 'unknown' });
    expect(await t.query(internal.chatModel.payment, { ...auth(), paymentHash: PAYMENT_HASH })).not.toHaveProperty('preimage');
  });

  test('verified reconciliation after expiry wins over a late error and remains idempotent', async () => {
    const t = await harness(); const invoice = fixtureInvoice(); await review(t, invoice); const first = await claim(t);
    await t.mutation(internal.chatModel.markPaymentUnknown, { id: first.id, attemptId: ATTEMPT });
    const settled = await settle(t, first.id, { now: invoice.expiresAt + 1000 });
    expect(settled).toMatchObject({ state: 'settled', paymentHash: PAYMENT_HASH, preimage: PREIMAGE, amountSats: 100 });
    expect(await t.mutation(internal.chatModel.markPaymentUnknown, { id: first.id, attemptId: ATTEMPT })).toEqual(settled);
    expect(await settle(t, first.id, { now: invoice.expiresAt + 5000 })).toEqual(settled);
    expect(await receipt(t, invoice.expiresAt + 6000)).toEqual(settled);
    expect(await claim(t, REVIEW_ID, invoice.expiresAt + 6000, 'late-repeat')).toMatchObject({ id: first.id, existing: settled });
  });

  test('a malformed stored settled record is never returned as verified payment proof', async () => {
    const t = await harness(); await review(t); const first = await claim(t);
    await t.run(ctx => ctx.db.patch(first.id, { state: 'settled', preimage: '22'.repeat(32), settledAt: NOW }));
    await expect(receipt(t)).rejects.toMatchObject({ data: { code: 'UNVERIFIED_PROOF' } });
  });
});
