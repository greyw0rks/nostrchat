import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import { bech32, utils } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import schema from '../convex/schema';
import { internal } from '../convex/_generated/api';
import { digestHex } from '../convex/lib';
import type { WalletInfo, WalletInvoice } from '../packages/nwc-gate/src/types';

const wallet = vi.hoisted(() => ({ created: vi.fn(), getInfo: vi.fn(), getBalance: vi.fn(), makeInvoice: vi.fn(), lookupInvoice: vi.fn(), payInvoice: vi.fn(), close: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
vi.mock('../packages/nwc-gate/src/nwc', async importOriginal => {
  const original = await importOriginal<typeof import('../packages/nwc-gate/src/nwc')>();
  return { ...original, NwcWallet: class {
    constructor(uri: string) { wallet.created(uri); }
    getInfo = wallet.getInfo; getBalance = wallet.getBalance; makeInvoice = wallet.makeInvoice;
    lookupInvoice = wallet.lookupInvoice; payInvoice = wallet.payInvoice; close = wallet.close;
  } };
});

// No network client is created. Keys, cookies, credentials, invoices and proofs are synthetic.
const modules = import.meta.glob('../convex/**/*.{ts,js}');
type T = TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 17, 12), ORIGIN = 'https://nostrchat.example';
const secret = (byte: number) => new Uint8Array(32).fill(byte);
const OWNER = getPublicKey(secret(1)), OTHER = getPublicKey(secret(2)), SERVICE = getPublicKey(secret(4));
const COOKIE = digestHex('synthetic-chat-http-cookie'), OTHER_COOKIE = digestHex('synthetic-chat-http-other-cookie');
const TOKEN = digestHex(COOKIE), OTHER_TOKEN = digestHex(OTHER_COOKIE);
const ENCRYPTION_KEY = '09'.repeat(32);
const URI = `nostr+walletconnect://${SERVICE}?relay=${encodeURIComponent('wss://relay.getalby.com')}&secret=${'07'.repeat(32)}`;
const FINGERPRINT = digestHex(`nwc:${SERVICE}:${getPublicKey(secret(7))}`), NEXT_FINGERPRINT = digestHex(`nwc:${SERVICE}:${getPublicKey(secret(8))}`);
const PREIMAGE = '11'.repeat(32), PAYMENT_HASH = digestHex(Buffer.from(PREIMAGE, 'hex'));
const NEXT_VERSION = digestHex('synthetic-chat-http-new-version');
const info = (fingerprint = FINGERPRINT, methods = ['get_info', 'get_balance', 'make_invoice', 'lookup_invoice', 'pay_invoice']): WalletInfo => ({ walletPubkey: SERVICE, connectionFingerprint: fingerprint, network: 'regtest', alias: 'Synthetic chat wallet', methods });

function seal(uri = URI, owner = OWNER, product = 'NostrChat'): string {
  const iv = Buffer.alloc(12, 10), cipher = createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  cipher.setAAD(Buffer.from(`${product} NWC v1:${owner}`));
  const data = Buffer.concat([cipher.update(uri, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString('base64')}.${data.toString('base64')}`;
}
function open(value: string, owner = OWNER, product = 'NostrChat'): string {
  const [, iv, encoded] = value.split('.'), data = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(`${product} NWC v1:${owner}`)); decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
}
const VERSION = digestHex(seal());
function words(input: number, width = 0): number[] {
  const result: number[] = []; do { result.unshift(input % 32); input = Math.floor(input / 32); } while (input);
  while (result.length < width) result.unshift(0); return result;
}
const tag = (code: number, value: number[]) => [code, Math.floor(value.length / 32), value.length % 32, ...value];
function invoice(amountSats = 100, expirySeconds = 600): WalletInvoice {
  const description = 'Synthetic chat HTTP payment';
  const prefix = `lnbcrt${amountSats * 10}n`, payee = secret(5);
  const data = [...words(NOW / 1000, 7), ...tag(1, bech32.toWords(Buffer.from(PAYMENT_HASH, 'hex'))), ...tag(13, bech32.toWords(new TextEncoder().encode(description))), ...tag(6, words(expirySeconds)), ...tag(19, bech32.toWords(secp256k1.getPublicKey(payee)))];
  const prefixBytes = new TextEncoder().encode(prefix), bytes = Uint8Array.from(utils.convertRadix2(data, 5, 8, true)), message = new Uint8Array(prefixBytes.length + bytes.length);
  message.set(prefixBytes); message.set(bytes, prefixBytes.length);
  const recovered = secp256k1.sign(sha256(message), payee, { prehash: false, format: 'recovered' }), signature = new Uint8Array(65);
  signature.set(recovered.subarray(1)); signature[64] = recovered[0]; payee.fill(0);
  return { paymentHash: PAYMENT_HASH, amountSats, description, expiresAt: NOW + expirySeconds * 1000, state: 'pending', bolt11: bech32.encode(prefix, [...data, ...bech32.toWords(signature)], 12000) };
}
const verifiedInvoice = (value = invoice()): WalletInvoice => ({ ...value, state: 'settled', preimage: PREIMAGE, settledAt: NOW + 1000 });
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(callback => { resolve = callback; });
  return { promise, resolve };
}
async function harness(connected = true): Promise<T> {
  const t = convexTest({ schema, modules, transactionLimits: true });
  await t.run(async ctx => {
    for (const [pubkey, tokenHash] of [[OWNER, TOKEN], [OTHER, OTHER_TOKEN]]) {
      await ctx.db.insert('users', { pubkey, createdAt: NOW });
      await ctx.db.insert('sessions', { pubkey, tokenHash, createdAt: NOW, expiresAt: NOW + 12 * 3600000 });
    }
    await ctx.db.insert('walletConnections', { pubkey: OWNER, sealedUri: seal(URI, OWNER, 'GreyFinance'), version: digestHex(seal(URI, OWNER, 'GreyFinance')), walletPubkey: SERVICE, connectionFingerprint: NEXT_FINGERPRINT, network: 'bitcoin', updatedAt: NOW });
    if (connected) await ctx.db.insert('chatWalletConnections', { pubkey: OWNER, sealedUri: seal(), version: VERSION, walletPubkey: SERVICE, connectionFingerprint: FINGERPRINT, network: 'regtest', updatedAt: NOW });
  });
  return t;
}
const action = (t: T, path: string, body: unknown = {}, method = 'POST', owner = OWNER) => t.action(internal.chatHttp.dispatch, { tokenHash: owner === OWNER ? TOKEN : OTHER_TOKEN, expectedPubkey: owner, path, body, method });
const http = (t: T, path: string, body: unknown = {}, method = 'POST', cookie = COOKIE, owner: string | null = OWNER, origin = ORIGIN) => t.fetch(path, { method, headers: { Origin: origin, Cookie: `sats_session=${cookie}`, 'Content-Type': 'application/json', ...(owner ? { 'X-Nostr-Pubkey': owner } : {}) }, ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body) } : {}) });
const rows = (t: T) => t.run(ctx => ctx.db.query('chatPayments').collect());
async function preview(t: T, value = invoice()) {
  const result = await action(t, '/api/chat/payments/preview', { bolt11: value.bolt11 });
  expect(result.status).toBe(200);
  const body = result.body as { reviewId: string; paymentHash: string; amountSats: number; reviewExpiresAt: number; walletReference: string };
  expect(body).toMatchObject({ paymentHash: PAYMENT_HASH, amountSats: value.amountSats, walletReference: FINGERPRINT });
  return body;
}
async function rotate(t: T, fingerprint = FINGERPRINT) {
  await t.run(async ctx => {
    const row = await ctx.db.query('chatWalletConnections').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique();
    await ctx.db.patch(row!._id, { version: NEXT_VERSION, connectionFingerprint: fingerprint });
  });
}
async function revoke(t: T, expire = false) {
  await t.run(async ctx => {
    const row = await ctx.db.query('sessions').withIndex('by_token', q => q.eq('tokenHash', TOKEN)).unique();
    if (expire) await ctx.db.patch(row!._id, { expiresAt: NOW }); else await ctx.db.delete(row!._id);
  });
}
const code = (result: { status: number; body: unknown }) => result.body as { code?: string; state?: string; preimage?: string; message?: string };

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubEnv('GREY_APP_ORIGIN', ORIGIN); vi.stubEnv('GREY_ALLOWED_ORIGINS', '');
  vi.stubEnv('GREY_WALLET_ENCRYPTION_KEY', ENCRYPTION_KEY); vi.stubEnv('GREY_NWC_RELAY_ALLOWLIST', 'relay.getalby.com');
  vi.stubEnv('GREY_REGTEST_RELAY_HOST', ''); vi.stubEnv('GREY_MAX_PAYMENT_SATS', '1000000');
  for (const mock of Object.values(wallet)) mock.mockReset();
  wallet.getInfo.mockResolvedValue(info()); wallet.getBalance.mockResolvedValue(2500); wallet.makeInvoice.mockResolvedValue(invoice());
  wallet.lookupInvoice.mockRejectedValue(new Error('Synthetic unavailable lookup')); wallet.payInvoice.mockResolvedValue({ paymentHash: PAYMENT_HASH, preimage: PREIMAGE });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('NostrChat HTTP session and credential boundary', () => {
  test('chat routes require the expected owner while the session probe can detect an existing different account', async () => {
    const t = await harness();
    const absent = await http(t, '/api/chat/account', {}, 'GET', COOKIE, null); expect(absent.status).toBe(409);
    const switched = await http(t, '/api/chat/account', {}, 'GET', OTHER_COOKIE, OWNER); expect(switched.status).toBe(409);
    const own = await http(t, '/api/chat/account', {}, 'GET'); expect(own.status).toBe(200); expect(own.headers.get('X-Nostr-Pubkey')).toBe(OWNER);
    const probe = await http(t, '/api/session', {}, 'GET', OTHER_COOKIE, OWNER); expect(probe.status).toBe(200); expect(probe.headers.get('X-Nostr-Pubkey')).toBeNull(); expect(await probe.json()).toMatchObject({ user: { pubkey: OTHER } });
    expect(wallet.created).not.toHaveBeenCalled();
  });

  test('NIP98 sign-in binds its expected header to the signed pubkey and can replace an existing other-account cookie', async () => {
    const t = await harness();
    const event = finalizeEvent({ kind: 27235, created_at: NOW / 1000, content: '', tags: [['u', ORIGIN + '/api/auth/nostr'], ['method', 'POST'], ['payload', digestHex('{}')]] }, secret(1));
    const signature = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
    const request = (expected: string) => t.fetch('/api/auth/nostr', { method: 'POST', headers: { Origin: ORIGIN, Cookie: `sats_session=${OTHER_COOKIE}`, 'Content-Type': 'application/json', Authorization: signature, 'X-Nostr-Pubkey': expected }, body: '{}' });
    const mismatch = await request(OTHER); expect(mismatch.status).toBe(409); expect((await mismatch.json()).code).toBe('IDENTITY_CHANGED');
    const signed = await request(OWNER); expect(signed.status).toBe(200); expect(await signed.json()).toMatchObject({ user: { pubkey: OWNER } });
    expect(signed.headers.get('set-cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    const replay = await request(OWNER); expect(replay.status).toBe(401); expect((await replay.json()).code).toBe('REPLAY_REJECTED');
  });

  test('a delayed old-account logout cannot revoke the current other-account session', async () => {
    const t = await harness();
    const result = await http(t, '/api/session/logout', {}, 'POST', OTHER_COOKIE, OWNER); expect(result.status).toBe(409);
    const probe = await http(t, '/api/session', {}, 'GET', OTHER_COOKIE, OTHER); expect(await probe.json()).toMatchObject({ user: { pubkey: OTHER } });
  });

  test('bound logout revokes its owner without a cookie-clearing response that could erase a later login', async () => {
    const t = await harness(); const result = await http(t, '/api/session/logout');
    expect(result.status).toBe(200); expect(result.headers.get('set-cookie')).toBeNull();
    const old = await http(t, '/api/session', {}, 'GET'); expect(await old.json()).toMatchObject({ user: null });
    const other = await http(t, '/api/session', {}, 'GET', OTHER_COOKIE, OTHER); expect(await other.json()).toMatchObject({ user: { pubkey: OTHER } });
  });

  test('wallet connection credentials are encrypted with chat and owner AAD and never replace company credentials', async () => {
    const t = await harness(false);
    const response = await http(t, '/api/chat/wallet/connect', { connectionUri: URI }); expect(response.status).toBe(200);
    const stored = await t.run(ctx => ctx.db.query('chatWalletConnections').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique());
    expect(stored).not.toBeNull(); expect(open(stored!.sealedUri)).toBe(URI); expect(stored!.sealedUri).not.toContain('07'.repeat(32));
    expect(() => open(stored!.sealedUri, OTHER)).toThrow(); expect(() => open(stored!.sealedUri, OWNER, 'GreyFinance')).toThrow();
    expect(await t.run(ctx => ctx.db.query('walletConnections').withIndex('by_pubkey', q => q.eq('pubkey', OWNER)).unique())).toMatchObject({ connectionFingerprint: NEXT_FINGERPRINT });
    const unsafe = await http(t, '/api/chat/account', { ciphertext: URI, expectedRevision: 0 }); expect(unsafe.status).toBe(422); expect((await unsafe.json()).code).toBe('CREDENTIAL_ROUTE');
    expect(await t.run(ctx => ctx.db.query('chatAccounts').collect())).toEqual([]);
  });
});

describe('NostrChat wallet waits preserve reviewed intent', () => {
  test('missing confirmation, invalid invoices and limits fail before any payment call', async () => {
    const t = await harness(); const reviewed = await preview(t);
    const unconfirmed = await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId }); expect(unconfirmed.status).toBe(422); expect(code(unconfirmed).code).toBe('INVALID_INPUT');
    const malformed = await action(t, '/api/chat/payments/preview', { bolt11: 'not-an-invoice'.repeat(5) }); expect(malformed.status).toBeGreaterThanOrEqual(400);
    vi.stubEnv('GREY_MAX_PAYMENT_SATS', '99'); const limit = await action(t, '/api/chat/payments/preview', { bolt11: invoice().bolt11 }); expect(limit.status).toBe(403); expect(code(limit).code).toBe('PAYMENT_LIMIT');
    expect(wallet.payInvoice).not.toHaveBeenCalled(); expect(await rows(t)).toEqual([]);
  });

  test('the invoice returned by the provider must also match the requested amount', async () => {
    const t = await harness();
    const result = await action(t, '/api/chat/wallet/invoices', { amountSats: 200, description: 'Requested 200 synthetic sats' });
    expect(result.status).toBe(502); expect(code(result).code).toBe('INVOICE_MISMATCH');
    expect(await t.run(ctx => ctx.db.query('chatWalletInvoices').collect())).toEqual([]);
  });

  test.each(['logout', 'expiry'])('a session %s during wallet preflight prevents the claim and send', async reason => {
    const t = await harness(); const reviewed = await preview(t), started = deferred<void>(), finish = deferred<WalletInfo>();
    wallet.getInfo.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const pending = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true });
    await started.promise; await revoke(t, reason === 'expiry'); finish.resolve(info());
    const result = await pending; expect(result.status).toBe(401); expect(wallet.payInvoice).not.toHaveBeenCalled(); expect(await rows(t)).toEqual([]);
  });

  test.each([['same source reconnected', FINGERPRINT], ['delegated source rotated', NEXT_FINGERPRINT]])('a wallet %s during preflight prevents a spend from stale review', async (_label, fingerprint) => {
    const t = await harness(); const reviewed = await preview(t), started = deferred<void>(), finish = deferred<WalletInfo>();
    wallet.getInfo.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const pending = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true });
    await started.promise; await rotate(t, fingerprint); finish.resolve(info());
    const result = await pending; expect(result.status).toBe(409); expect(code(result).code).toBe('WALLET_CHANGED');
    expect(wallet.payInvoice).not.toHaveBeenCalled(); expect(await rows(t)).toEqual([]);
  });

  test.each(['review', 'invoice'])('the %s deadline is checked again after the wallet wait', async deadline => {
    const t = await harness(); const reviewed = await preview(t, invoice(100, deadline === 'invoice' ? 30 : 600)), started = deferred<void>(), finish = deferred<WalletInfo>();
    wallet.getInfo.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const pending = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true });
    await started.promise; vi.mocked(Date.now).mockReturnValue(NOW + (deadline === 'invoice' ? 30000 : 90000)); finish.resolve(info());
    const result = await pending; expect(result.status).toBe(422); expect(code(result).code).toBe('REVIEW_EXPIRED');
    expect(wallet.payInvoice).not.toHaveBeenCalled(); expect(await rows(t)).toEqual([]);
  });

  test('a connection change while an invoice is being created prevents a stale invoice record', async () => {
    const t = await harness(), started = deferred<void>(), finish = deferred<WalletInvoice>();
    wallet.makeInvoice.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const pending = action(t, '/api/chat/wallet/invoices', { amountSats: 100, description: 'Synthetic chat invoice' });
    await started.promise; await rotate(t); finish.resolve(invoice());
    const result = await pending; expect(result.status).toBe(409); expect(code(result).code).toBe('WALLET_CHANGED');
    expect(await t.run(ctx => ctx.db.query('chatWalletInvoices').collect())).toEqual([]);
  });
});

describe('NostrChat HTTP payment idempotency and recovery', () => {
  test('two simultaneous confirmations make one provider send and one durable claim', async () => {
    const t = await harness(); const reviewed = await preview(t), preflights = deferred<void>(), started = deferred<void>(), finish = deferred<{ paymentHash: string; preimage: string }>();
    let entered = 0;
    wallet.getInfo.mockImplementation(async () => { if (++entered === 2) preflights.resolve(); await preflights.promise; return info(); });
    wallet.payInvoice.mockImplementation(() => { started.resolve(); return finish.promise; });
    const first = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }), second = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true });
    await started.promise; expect(wallet.payInvoice).toHaveBeenCalledTimes(1); expect(await rows(t)).toHaveLength(1);
    finish.resolve({ paymentHash: PAYMENT_HASH, preimage: PREIMAGE }); const results = await Promise.all([first, second]);
    expect(results.map(result => result.status)).toEqual([200, 200]); expect(results.map(result => code(result).state).sort()).toEqual(['settled', 'unknown']);
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1); expect(await rows(t)).toHaveLength(1);
  });

  test.each(['timeout', 'invalid proof'])('a provider %s records unknown, and another confirmation cannot send again', async failure => {
    const t = await harness(); const reviewed = await preview(t);
    if (failure === 'timeout') wallet.payInvoice.mockRejectedValueOnce(new Error('Synthetic wallet timeout'));
    else wallet.payInvoice.mockResolvedValueOnce({ paymentHash: PAYMENT_HASH, preimage: '22'.repeat(32) });
    const first = await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }); expect(first.status).toBe(200); expect(code(first).state).toBe('unknown');
    expect(await rows(t)).toMatchObject([{ state: 'unknown', walletFingerprint: FINGERPRINT, connectionVersion: VERSION }]);
    const duplicate = await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }); expect(duplicate.status).toBe(200); expect(code(duplicate).state).toBe('unknown');
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1); expect(wallet.lookupInvoice).not.toHaveBeenCalled(); expect(await rows(t)).toHaveLength(1);
  });

  test('status lookup can reconcile after expiry and same-source reconnection without a second send', async () => {
    const t = await harness(); const value = invoice(), reviewed = await preview(t, value);
    wallet.payInvoice.mockRejectedValueOnce(new Error('Synthetic lost payment response'));
    await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }); await rotate(t);
    vi.mocked(Date.now).mockReturnValue(value.expiresAt + 1000); wallet.lookupInvoice.mockResolvedValue(verifiedInvoice(value));
    const checked = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET'); expect(checked.status).toBe(200); expect(code(checked)).toMatchObject({ state: 'settled', preimage: PREIMAGE });
    expect(wallet.lookupInvoice).toHaveBeenCalledTimes(1); expect(wallet.payInvoice).toHaveBeenCalledTimes(1);
    await action(t, '/api/chat/wallet', {}, 'DELETE'); const lookups = wallet.lookupInvoice.mock.calls.length, creations = wallet.created.mock.calls.length;
    const durable = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET'); expect(durable.body).toEqual(checked.body); expect(wallet.lookupInvoice).toHaveBeenCalledTimes(lookups); expect(wallet.created).toHaveBeenCalledTimes(creations);
  });

  test('foreign owners and a replacement wallet cannot reconcile or resend the original attempt', async () => {
    const t = await harness(); const reviewed = await preview(t); wallet.payInvoice.mockRejectedValueOnce(new Error('Synthetic lost response'));
    await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true });
    const other = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET', OTHER); expect(other.status).toBe(200); expect(code(other).state).toBe('not_found');
    const foreignConfirm = await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }, 'POST', OTHER); expect(foreignConfirm.status).toBe(404);
    await rotate(t, NEXT_FINGERPRINT); const checked = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET'); expect(code(checked).state).toBe('unknown'); expect(code(checked).message).toContain('original wallet');
    expect(wallet.lookupInvoice).not.toHaveBeenCalled(); expect(wallet.payInvoice).toHaveBeenCalledTimes(1);
  });

  test.each(['proof', 'amount', 'invoice'])('a forged reconciliation %s cannot create a settled receipt', async mismatch => {
    const t = await harness(); const reviewed = await preview(t); wallet.payInvoice.mockRejectedValueOnce(new Error('Synthetic lost response'));
    await action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true });
    const altered = { ...verifiedInvoice(), ...(mismatch === 'proof' ? { preimage: '22'.repeat(32) } : mismatch === 'amount' ? { amountSats: 101 } : { bolt11: invoice(200).bolt11 }) };
    wallet.lookupInvoice.mockResolvedValue(altered);
    const checked = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET'); expect(checked.status).toBe(200); expect(code(checked).state).toBe('unknown');
    expect(await rows(t)).toMatchObject([{ state: 'unknown' }]); expect(wallet.payInvoice).toHaveBeenCalledTimes(1);
  });

  test('a late provider error preserves a proof already settled by concurrent status reconciliation', async () => {
    const t = await harness(); const reviewed = await preview(t), started = deferred<void>(), finish = deferred<{ paymentHash: string; preimage: string }>();
    wallet.payInvoice.mockImplementationOnce(async () => { started.resolve(); await finish.promise; throw new Error('Synthetic late timeout'); });
    const paying = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }); await started.promise;
    wallet.lookupInvoice.mockResolvedValue(verifiedInvoice()); const checked = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET'); expect(code(checked).state).toBe('settled');
    finish.resolve({ paymentHash: PAYMENT_HASH, preimage: PREIMAGE }); const late = await paying; expect(late.body).toEqual(checked.body);
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1); expect(await rows(t)).toMatchObject([{ state: 'settled', preimage: PREIMAGE }]);
  });

  test('a session revoked after the send receives no stale response while its verified settlement remains recoverable', async () => {
    const t = await harness(); const reviewed = await preview(t), started = deferred<void>(), finish = deferred<{ paymentHash: string; preimage: string }>();
    wallet.payInvoice.mockImplementationOnce(() => { started.resolve(); return finish.promise; });
    const paying = action(t, '/api/chat/payments', { reviewId: reviewed.reviewId, confirmed: true }); await started.promise;
    await revoke(t); finish.resolve({ paymentHash: PAYMENT_HASH, preimage: PREIMAGE });
    const late = await paying; expect(late.status).toBe(401); expect(await rows(t)).toMatchObject([{ pubkey: OWNER, state: 'settled', preimage: PREIMAGE }]);
    await t.run(ctx => ctx.db.insert('sessions', { pubkey: OWNER, tokenHash: TOKEN, createdAt: NOW + 1000, expiresAt: NOW + 12 * 3600000 }));
    const recovered = await action(t, '/api/chat/payments/' + PAYMENT_HASH, {}, 'GET'); expect(recovered.status).toBe(200); expect(code(recovered)).toMatchObject({ state: 'settled', preimage: PREIMAGE });
    expect(wallet.payInvoice).toHaveBeenCalledTimes(1); expect(wallet.lookupInvoice).not.toHaveBeenCalled();
  });

  test('a receiving invoice with missing proof stays pending, and its verified receipt survives disconnect', async () => {
    const t = await harness(); const value = invoice();
    const created = await action(t, '/api/chat/wallet/invoices', { amountSats: 100, description: value.description }); expect(created.status).toBe(201);
    wallet.lookupInvoice.mockResolvedValue({ ...value, state: 'settled' });
    const unverified = await action(t, '/api/chat/wallet/invoices/' + PAYMENT_HASH, {}, 'GET'); expect(unverified.status).toBe(409); expect(code(unverified).code).toBe('UNVERIFIED_PROOF');
    expect(await t.query(internal.chatModel.invoice, { tokenHash: TOKEN, expectedPubkey: OWNER, now: NOW, paymentHash: PAYMENT_HASH })).toMatchObject({ state: 'pending' });
    wallet.lookupInvoice.mockResolvedValue(verifiedInvoice(value)); const checked = await action(t, '/api/chat/wallet/invoices/' + PAYMENT_HASH, {}, 'GET'); expect(checked.status).toBe(200); expect(code(checked).state).toBe('settled');
    await action(t, '/api/chat/wallet', {}, 'DELETE'); const lookups = wallet.lookupInvoice.mock.calls.length;
    const stored = await action(t, '/api/chat/wallet/invoices/' + PAYMENT_HASH, {}, 'GET'); expect(stored.body).toEqual(checked.body); expect(wallet.lookupInvoice).toHaveBeenCalledTimes(lookups);
  });
});
