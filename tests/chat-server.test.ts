import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { encrypt, getConversationKey } from 'nostr-tools/nip44';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32, utils } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { signedBolt11 } from '../packages/chat/src/invoice.ts';
import { GateError } from '../packages/nwc-gate/src/types.ts';
import type { AppContext, WalletAdapter, WalletInfo, WalletInvoice } from '../server/context.ts';

// Import server support inside a disposable directory, without loading user credentials or data.
const support = mkdtempSync(join(tmpdir(), 'nostrchat-server-support-'));
const previousCwd = process.cwd(); const previousData = process.env.SATS_DATA_DIR;
process.env.SATS_DATA_DIR = join(support, 'data'); process.chdir(support);
let chat: typeof import('../server/chat.ts'); let authModule: typeof import('../server/auth.ts'); let store: typeof import('../server/store.ts');
try { chat = await import('../server/chat.ts'); authModule = await import('../server/auth.ts'); store = await import('../server/store.ts'); }
finally { process.chdir(previousCwd); if (previousData === undefined) delete process.env.SATS_DATA_DIR; else process.env.SATS_DATA_DIR = previousData; }
after(() => { store.db.close(); rmSync(support, { recursive: true, force: true }); });

const key = (byte: number) => new Uint8Array(32).fill(byte);
const A = getPublicKey(key(1)); const B = getPublicKey(key(2)); const SERVICE = getPublicKey(key(3));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const TOKEN_A = sha('synthetic-chat-session-A'); const TOKEN_B = sha('synthetic-chat-session-B');
const PREIMAGE = '17'.repeat(32); const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const FP_A = sha('synthetic-chat-wallet-A'); const FP_B = sha('synthetic-chat-wallet-B');
const URI = `nostr+walletconnect://${SERVICE}?relay=wss%3A%2F%2Fwallet-relay.example&secret=${'61'.repeat(32)}`;
function wordNumber(value: number, length?: number) { const words: number[] = []; do { words.unshift(value % 32); value = Math.floor(value / 32); } while (value); if (length) while (words.length < length) words.unshift(0); return words; }
function tagged(type: number, bytes: Uint8Array) { const words = bech32.toWords(bytes); return [type, Math.floor(words.length / 32), words.length % 32, ...words]; }
function invoice(timestamp: number, amount = 100): WalletInvoice {
  const prefix = `lnbcrt${amount * 10}n`; const secret = key(7);
  const data = [...wordNumber(Math.floor(timestamp / 1000), 7), ...tagged(1, Buffer.from(HASH, 'hex')), ...tagged(16, key(8)), ...tagged(19, secp256k1.getPublicKey(secret)), ...tagged(13, new TextEncoder().encode('Private design review')), 6, 0, 2, ...wordNumber(600, 2)];
  const bytes = Uint8Array.from([...new TextEncoder().encode(prefix), ...utils.convertRadix2(data, 5, 8, true)]);
  const signed = secp256k1.sign(sha256(bytes), secret, { prehash: false, format: 'recovered' });
  const signature = Uint8Array.from([...signed.subarray(1), signed[0]]);
  const bolt11 = bech32.encode(prefix, [...data, ...bech32.toWords(signature)], 12_000);
  const parsed = signedBolt11(bolt11);
  return { paymentHash: parsed.paymentHash, bolt11, amountSats: parsed.amountSats, description: 'Private design review', expiresAt: parsed.expiresAt, state: 'pending' };
}
function ciphertext(text: string) { return encrypt(text, getConversationKey(key(1), A)); }
function envelope(recipient = A) { return finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient]], content: encrypt('Synthetic encrypted cache envelope', getConversationKey(key(3), recipient)) }, key(3)); }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type FakeWallet = WalletAdapter & { info: WalletInfo; counts: Record<'info' | 'balance' | 'make' | 'lookup' | 'pay' | 'close', number>; onInfo?: () => Promise<void> | void; onPay?: () => Promise<{ paymentHash: string; preimage: string }>; lookupValue: WalletInvoice; makeValue: WalletInvoice };
function fakeWallet(item: WalletInvoice): FakeWallet {
  const value: FakeWallet = {
    kind: 'nwc', info: { network: 'regtest', walletPubkey: SERVICE, connectionFingerprint: FP_A, methods: ['get_info', 'get_balance', 'make_invoice', 'lookup_invoice', 'pay_invoice'], alias: 'Private regtest wallet' },
    counts: { info: 0, balance: 0, make: 0, lookup: 0, pay: 0, close: 0 }, lookupValue: item, makeValue: item,
    async getInfo() { value.counts.info++; const snapshot = { ...value.info, methods: [...value.info.methods] }; await value.onInfo?.(); return snapshot; },
    async getBalance() { value.counts.balance++; return 10_000; },
    async makeInvoice() { value.counts.make++; return { ...value.makeValue }; },
    async lookupInvoice() { value.counts.lookup++; return { ...value.lookupValue }; },
    async payInvoice() { value.counts.pay++; if (value.onPay) return value.onPay(); return { paymentHash: HASH, preimage: PREIMAGE }; },
    close() { value.counts.close++; }
  }; return value;
}
async function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,pubkey TEXT UNIQUE,demo INTEGER,created_at INTEGER); CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER); CREATE TABLE auth_replay(event_id TEXT PRIMARY KEY,expires_at INTEGER); CREATE TABLE wallet_payments(payment_hash TEXT PRIMARY KEY,user_id TEXT,state TEXT,preimage TEXT,created_at INTEGER,wallet_fingerprint TEXT); CREATE TABLE wallet_connections(user_id TEXT PRIMARY KEY,encrypted_uri TEXT,updated_at INTEGER);');
  for (const [pubkey, token] of [[A, TOKEN_A], [B, TOKEN_B]]) { db.prepare('INSERT INTO users VALUES(?,?,0,?)').run(pubkey, pubkey, Date.now()); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), pubkey, Date.now() + 3600000); }
  db.prepare('INSERT INTO wallet_connections VALUES(?,?,?)').run(A, 'Synthetic untouched company delegation', Date.now());
  let clock = Date.now(); const item = invoice(clock); const wallet = fakeWallet(item);
  const auth = authModule.createAuth(db, { demoEnabled: false });
  const ctx: AppContext = { db, now: () => clock, user: auth.user, requireUser: auth.requireUser, demoEnabled: false, wallet: () => null, walletForUser: async () => null };
  const app = express(); app.use(express.json({ limit: 96_000 }));
  app.use((req, _res, next) => { try { authModule.validateOrigin(req); next(); } catch (error) { next(error); } }); app.use(auth.load);
  app.get('/api/session', (req, res) => { let user = null; try { user = auth.user(req); } catch {} res.json({ user }); });
  app.post('/api/auth/nostr', (req, res) => res.json({ user: auth.authenticate(req, res) }));
  app.post('/api/session/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
  app.use('/api/chat', chat.createChatRouter(ctx, { walletFactory: () => wallet, allowConnection: async () => ({ walletPubkey: SERVICE, relays: ['wss://wallet-relay.example'] }) }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { const known = error instanceof GateError; res.status(known ? error.status : 422).json({ code: known ? error.code : 'INVALID_INPUT', message: known ? error.message : 'Invalid input' }); });
  const server = createServer(app); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local test port'); const origin = `http://127.0.0.1:${address.port}`; authModule.allowedOrigins.add(origin);
  const request = async (method: string, path: string, body?: unknown, pubkey: string | null = A, headers: Record<string, string> = {}) => {
    const token = pubkey === B ? TOKEN_B : TOKEN_A;
    const result = await fetch(origin + path, { method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(pubkey ? { Cookie: `sats_session=${token}`, 'X-Nostr-Pubkey': pubkey } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() as Record<string, any>, headers: result.headers };
  };
  const connect = () => request('POST', '/api/chat/wallet/connect', { connectionUri: URI });
  const review = async () => { const result = await request('POST', '/api/chat/payments/preview', { bolt11: item.bolt11 }); assert.equal(result.status, 200); return result.body; };
  const pay = (reviewId: string) => request('POST', '/api/chat/payments', { reviewId, confirmed: true });
  return { db, wallet, item, origin, request, connect, review, pay, setTime(value: number) { clock = value; }, time: () => clock, async close() { authModule.allowedOrigins.delete(origin); await new Promise<void>(done => server.close(() => done())); db.close(); } };
}
async function using(operation: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) { const h = await harness(); try { await operation(h); } finally { await h.close(); } }

test('chat profile uses encrypted compare-and-swap writes and current owner headers', () => using(async h => {
  const cipher = ciphertext('Private profile');
  assert.equal((await h.request('POST', '/api/chat/account', { ciphertext: 'plaintext', expectedRevision: 0 })).status, 422);
  assert.equal((await h.request('POST', '/api/chat/account', { ciphertext: cipher, expectedRevision: 0 }, A, { 'X-Nostr-Pubkey': B })).status, 409);
  const values = await Promise.all([h.request('POST', '/api/chat/account', { ciphertext: cipher, expectedRevision: 0 }), h.request('POST', '/api/chat/account', { ciphertext: cipher, expectedRevision: 0 })]);
  assert.deepEqual(values.map(v => v.status).sort(), [200, 409]);
  const saved = await h.request('GET', '/api/chat/account'); assert.equal(saved.body.revision, 1); assert.equal(saved.headers.get('X-Nostr-Pubkey'), A);
  assert.equal((await h.request('GET', '/api/chat/account', undefined, B)).body.ciphertext, null);
  assert.equal((await h.request('GET', '/api/chat/account', undefined, null)).status, 401);
}));
test('cache persists only signed envelopes addressed to the owner, and deduplicates exact envelopes', () => using(async h => {
  const event = envelope();
  assert.equal((await h.request('POST', '/api/chat/history', { event })).status, 200);
  assert.equal((await h.request('POST', '/api/chat/history', { event })).body.duplicate, true);
  assert.equal((await h.request('POST', '/api/chat/history', { event: { ...event, content: ciphertext('Altered ciphertext') } })).status, 422);
  assert.equal((await h.request('POST', '/api/chat/history', { event }, B)).status, 403);
  assert.equal((await h.request('GET', '/api/chat/history')).body.events.length, 1);
  assert.equal((await h.request('GET', '/api/chat/history', undefined, B)).body.events.length, 0);
  assert.equal((await h.request('DELETE', '/api/chat/history', { confirmed: false })).status, 422);
  assert.equal((await h.request('DELETE', '/api/chat/history', { confirmed: true })).body.count, 1);
}));
test('encrypted outbox is immutable, owner-scoped, and cannot move from published back to queued', () => using(async h => {
  const id = sha('synthetic-message'); const cipher = ciphertext('Original retry bundle');
  assert.equal((await h.request('POST', '/api/chat/outbox', { id, ciphertext: cipher, state: 'queued' })).status, 200);
  assert.equal((await h.request('POST', '/api/chat/outbox', { id, ciphertext: ciphertext('Different bundle'), state: 'queued' })).status, 409);
  await h.request('POST', '/api/chat/outbox', { id, ciphertext: cipher, state: 'published' });
  assert.equal((await h.request('POST', '/api/chat/outbox', { id, ciphertext: cipher, state: 'queued' })).body.state, 'published');
  assert.equal((await h.request('GET', '/api/chat/outbox', undefined, B)).body.items.length, 0);
  await h.request('DELETE', '/api/chat/outbox/' + id, { confirmed: true }, B);
  assert.equal((await h.request('GET', '/api/chat/outbox')).body.items.length, 1);
}));
test('chat wallet connection and disconnect preserve company delegation and hide all secrets', () => using(async h => {
  const connected = await h.connect(); assert.equal(connected.status, 200); assert.equal(connected.body.practice, true); assert.ok(!JSON.stringify(connected.body).includes(URI));
  const row = h.db.prepare('SELECT * FROM chat_wallet_connections').get() as any; assert.ok(!row.encrypted_uri.includes(URI));
  await h.request('DELETE', '/api/chat/wallet');
  assert.equal((await h.request('GET', '/api/chat/wallet')).body.connected, false);
  assert.equal((h.db.prepare('SELECT encrypted_uri FROM wallet_connections').get() as any).encrypted_uri, 'Synthetic untouched company delegation');
}));
test('provider amount changes cannot create a different invoice than the requested amount', () => using(async h => {
  await h.connect(); const result = await h.request('POST', '/api/chat/wallet/invoices', { amountSats: 200, description: 'Request' });
  assert.equal(result.status, 502); assert.equal(result.body.code, 'INVOICE_MISMATCH'); assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM chat_wallet_invoices').get()!.count, 0);
}));
test('receiving settlement requires a matching proof and survives wallet disconnect', () => using(async h => {
  await h.connect(); assert.equal((await h.request('POST', '/api/chat/wallet/invoices', { amountSats: 100, description: 'Request' })).status, 201);
  h.wallet.lookupValue = { ...h.item, state: 'settled', preimage: 'ff'.repeat(32) };
  assert.equal((await h.request('GET', '/api/chat/wallet/invoices/' + HASH)).status, 409);
  h.wallet.lookupValue = { ...h.item, state: 'settled', preimage: PREIMAGE, settledAt: h.time() };
  const verified = await h.request('GET', '/api/chat/wallet/invoices/' + HASH); assert.equal(verified.body.state, 'settled'); assert.equal(verified.body.preimage, PREIMAGE);
  await h.request('DELETE', '/api/chat/wallet'); const calls = h.wallet.counts.info;
  assert.equal((await h.request('GET', '/api/chat/wallet/invoices/' + HASH)).body.preimage, PREIMAGE); assert.equal(h.wallet.counts.info, calls); assert.equal(h.wallet.counts.pay, 0);
}));
test('review fixes amount, network, source and deadline; confirmation is mandatory', () => using(async h => {
  await h.connect(); const review = await h.review(); assert.equal(review.amountSats, 100); assert.equal(review.network, 'regtest'); assert.equal(review.walletReference, FP_A); assert.ok(review.reviewExpiresAt <= h.time() + 90_000);
  assert.equal((await h.request('POST', '/api/chat/payments', { reviewId: review.reviewId })).status, 422);
  assert.equal((await h.request('POST', '/api/chat/payments', { reviewId: review.reviewId, confirmed: true, amountSats: 1 })).status, 422); assert.equal(h.wallet.counts.pay, 0);
  const result = await h.pay(review.reviewId); assert.equal(result.body.state, 'settled'); assert.equal(result.body.preimage, PREIMAGE);
  await h.pay(review.reviewId); assert.equal(h.wallet.counts.pay, 1);
}));
test('wallet reconnect after review rejects the captured payment before any send', () => using(async h => {
  await h.connect(); const review = await h.review(); await h.connect();
  const result = await h.pay(review.reviewId); assert.equal(result.status, 409); assert.equal(result.body.code, 'WALLET_CHANGED'); assert.equal(h.wallet.counts.pay, 0); assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM chat_payments').get()!.count, 0);
}));
test('session revocation during wallet preflight prevents claim and execution', () => using(async h => {
  await h.connect(); const review = await h.review(); h.wallet.onInfo = () => { h.db.prepare('DELETE FROM sessions WHERE user_id=?').run(A); };
  const result = await h.pay(review.reviewId); assert.equal(result.status, 401); assert.equal(h.wallet.counts.pay, 0); assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM chat_payments').get()!.count, 0);
}));
test('review expiry while awaiting wallet information is rechecked atomically before sending', () => using(async h => {
  await h.connect(); const review = await h.review(); h.wallet.onInfo = () => { h.setTime(review.reviewExpiresAt + 1); };
  const result = await h.pay(review.reviewId); assert.equal(result.status, 422); assert.equal(result.body.code, 'REVIEW_EXPIRED'); assert.equal(h.wallet.counts.pay, 0);
}));
test('concurrent confirmations create one durable attempt and one wallet send', () => using(async h => {
  await h.connect(); const review = await h.review(); const ready = deferred(); let checks = 0;
  h.wallet.onInfo = async () => { if (++checks === 2) ready.resolve(); await ready.promise; };
  h.wallet.onPay = async () => { throw new Error('Synthetic transport timeout'); };
  const results = await Promise.all([h.pay(review.reviewId), h.pay(review.reviewId)]); assert.ok(results.every(result => result.status === 200 && result.body.state === 'unknown')); assert.equal(h.wallet.counts.pay, 1); assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM chat_payments').get()!.count, 1);
}));
test('unknown result survives expiry and reconciles through status without a repeated send', () => using(async h => {
  await h.connect(); const review = await h.review(); h.wallet.onPay = async () => { throw new Error('Synthetic timeout after sending'); };
  assert.equal((await h.pay(review.reviewId)).body.state, 'unknown'); h.setTime(h.item.expiresAt + 1000);
  assert.equal((await h.pay(review.reviewId)).body.state, 'unknown'); assert.equal(h.wallet.counts.pay, 1);
  h.wallet.lookupValue = { ...h.item, state: 'settled', preimage: PREIMAGE };
  const settled = await h.request('GET', '/api/chat/payments/' + HASH); assert.equal(settled.body.state, 'settled'); assert.equal(settled.body.preimage, PREIMAGE); assert.equal(h.wallet.counts.pay, 1);
  await h.request('DELETE', '/api/chat/wallet'); const calls = h.wallet.counts.lookup;
  assert.equal((await h.request('GET', '/api/chat/payments/' + HASH)).body.preimage, PREIMAGE); assert.equal(h.wallet.counts.lookup, calls);
}));
test('a foreign identity cannot confirm a review or learn the original payment proof', () => using(async h => {
  await h.connect(); const review = await h.review(); assert.equal((await h.request('POST', '/api/chat/payments', { reviewId: review.reviewId, confirmed: true }, B)).status, 404);
  await h.pay(review.reviewId); const result = await h.request('GET', '/api/chat/payments/' + HASH, undefined, B); assert.equal(result.body.state, 'not_found'); assert.equal(result.body.preimage, undefined); assert.equal(h.wallet.counts.pay, 1);
}));
test('company expense invoices cannot bypass independent approval through chat', () => using(async h => {
  await h.connect(); const review = await h.review(); h.db.exec('CREATE TABLE sf_expenses(payment_hash TEXT,is_fixture INTEGER)'); h.db.prepare('INSERT INTO sf_expenses VALUES(?,0)').run(HASH);
  const result = await h.pay(review.reviewId); assert.equal(result.status, 409); assert.equal(result.body.code, 'USE_APPROVAL_FLOW'); assert.equal(h.wallet.counts.pay, 0);
}));
test('late payment error cannot overwrite a proof saved by concurrent status reconciliation', () => using(async h => {
  await h.connect(); const review = await h.review(); const entered = deferred(); const finish = deferred();
  h.wallet.onPay = async () => { entered.resolve(); await finish.promise; throw new Error('Synthetic late failure'); };
  const original = h.pay(review.reviewId); await entered.promise;
  h.wallet.lookupValue = { ...h.item, state: 'settled', preimage: PREIMAGE };
  const reconciled = await h.request('GET', '/api/chat/payments/' + HASH); assert.equal(reconciled.body.state, 'settled'); finish.resolve(); const delayed = await original; assert.equal(delayed.body.state, 'settled'); assert.equal(delayed.body.preimage, PREIMAGE); assert.equal(h.wallet.counts.pay, 1);
}));
test('an old account cannot revoke a newer session, and a bound logout emits no stale cookie clear', () => using(async h => {
  const mismatch = await h.request('POST', '/api/session/logout', {}, B, { 'X-Nostr-Pubkey': A }); assert.equal(mismatch.status, 409); assert.ok(h.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(B));
  const done = await h.request('POST', '/api/session/logout', {}, A); assert.equal(done.status, 200); assert.equal(done.headers.get('set-cookie'), null); assert.ok(h.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(B)); assert.equal(h.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(A), undefined);
}));
test('session discovery supports switching accounts while signed authentication binds its requested owner', () => using(async h => {
  const probe = await h.request('GET', '/api/session', undefined, B, { 'X-Nostr-Pubkey': A }); assert.equal(probe.status, 200); assert.equal(probe.body.user.pubkey, B); assert.equal(probe.headers.get('X-Nostr-Pubkey'), null);
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', h.origin + '/api/auth/nostr'], ['method', 'POST'], ['payload', sha('{}')]] }, key(1));
  const Authorization = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
  assert.equal((await h.request('POST', '/api/auth/nostr', {}, null, { Authorization, 'X-Nostr-Pubkey': B })).status, 409);
  const accepted = await h.request('POST', '/api/auth/nostr', {}, null, { Authorization, 'X-Nostr-Pubkey': A }); assert.equal(accepted.status, 200); assert.equal(accepted.body.user.pubkey, A);
}));
