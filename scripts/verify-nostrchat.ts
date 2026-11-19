import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type NostrEvent } from 'nostr-tools';
import { nostrAuthorization } from '../packages/nwc-gate/src/auth.ts';
import { signedBolt11 } from '../packages/chat/src/invoice.ts';
import { createPracticeIdentity, createGiftWraps, unwrapGift, matchingReceiptInvoices, paymentProofMatches, type Identity, type ChatMessage, type ChatPayload } from '../apps/nostrchat/src/protocol.ts';
import { ChatRelay } from '../apps/nostrchat/src/relay.ts';
import type { WalletInvoice } from '../server/context.ts';

const base = (process.argv[2] || 'http://127.0.0.1:4424').replace(/\/$/, '');
const origin = (process.argv[3] || (new URL(base).protocol === 'https:' ? base : 'http://127.0.0.1:4405')).replace(/\/$/, '');
const evidenceFile = process.argv[4] || 'docs/evidence/nostrchat-regtest.json';
const hosted = new URL(base).protocol === 'https:';
const labDir = resolve(process.env.SATS_VERIFY_LAB_DIR || '.data/chat-preview');
const config = await (await fetch(`${base}/api/chat/config`)).json() as { backend: string; relayUrl: string | null };
const relayUrl = process.env.SATS_CHAT_VERIFY_RELAY_URL || config.relayUrl;
assert(relayUrl && ['ws:', 'wss:'].includes(new URL(relayUrl).protocol), 'Use an isolated private relay for this verification.');
// This verifier deliberately refuses to publish test messages onto a public relay.
assert(['127.0.0.1', 'localhost'].includes(new URL(relayUrl).hostname), 'Message acceptance is restricted to the private loopback relay.');
const checks: string[] = [];
type Actor = { identity: Identity; cookie: string; relay: ChatRelay; received: Map<string, ChatMessage>; envelopes: Map<string, NostrEvent>; outbox: string[] };
const actors: Actor[] = [];
const sourceFiles = ['apps/nostrchat/src/App.tsx', 'apps/nostrchat/src/protocol.ts', 'apps/nostrchat/src/relay.ts', 'apps/nostrchat/src/storage.ts', 'server/chat.ts', 'server/auth.ts', 'convex/chatModel.ts', 'convex/chatHttp.ts', 'convex/http.ts', 'packages/chat/src/invoice.ts', 'packages/chat/src/validation.ts', 'packages/nwc-gate/src/nwc.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
async function request<T = Record<string, any>>(actor: Actor, path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
  const result = await fetch(base + path, { method, headers: { Origin: origin, Cookie: actor.cookie, 'X-Nostr-Pubkey': actor.identity.pubkey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  const value = await result.json(); assert.equal(result.status, expected, `${method} ${path}: ${String(value.code || 'unexpected response')}`); return value as T;
}
async function actor(name: string): Promise<Actor> {
  const identity = createPracticeIdentity(name);
  const authorization = await nostrAuthorization(`${origin}/api/auth/nostr`, 'POST', {}, event => identity.sign(event));
  const init = { method: 'POST', headers: { Origin: origin, Authorization: authorization, 'X-Nostr-Pubkey': identity.pubkey, 'Content-Type': 'application/json' }, body: '{}' };
  const response = await fetch(`${base}/api/auth/nostr`, init); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie') || ''; assert(/httponly/i.test(cookie)); if (hosted) assert(/secure/i.test(cookie));
  assert.equal((await fetch(`${base}/api/auth/nostr`, init)).status, 401);
  let ready!: () => void;
  const connected = new Promise<void>(done => { ready = done; });
  const relay = new ChatRelay(relayUrl!, state => { if (state === 'connected') ready(); });
  const value: Actor = { identity, cookie: cookie.split(';')[0], relay, received: new Map(), envelopes: new Map(), outbox: [] }; actors.push(value);
  relay.subscribe(`builder-${actors.length}`, [{ kinds: [1059], '#p': [identity.pubkey], limit: 100 }], async event => { value.envelopes.set(event.id, event); const message = await unwrapGift(identity, event); value.received.set(message.id, message); });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { relay.connect(); await Promise.race([connected, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Private relay did not connect')), 15000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
  return value;
}
async function observed(actor: Actor, id: string) {
  for (let i = 0; i < 150; i++) { const message = actor.received.get(id); if (message) return message; await new Promise<void>(done => setTimeout(done, 100)); }
  throw new Error('The private relay did not deliver the expected signed message.');
}
async function send(sender: Actor, receiver: Actor, payload: ChatPayload) {
  const bundle = await createGiftWraps(sender.identity, receiver.identity.pubkey, payload);
  const cipher = await sender.identity.encrypt(sender.identity.pubkey, JSON.stringify({ version: 1, owner: sender.identity.pubkey, peer: receiver.identity.pubkey, id: bundle.rumor.id, events: bundle.events }));
  await request(sender, '/api/chat/outbox', 'POST', { id: bundle.rumor.id, ciphertext: cipher, state: 'queued' }); sender.outbox.push(bundle.rumor.id);
  for (const event of bundle.events) await sender.relay.publish(event);
  const message = await observed(receiver, bundle.rumor.id); assert.equal(message.sender, sender.identity.pubkey); assert.equal(message.recipient, receiver.identity.pubkey);
  await observed(sender, bundle.rumor.id);
  await request(sender, '/api/chat/history', 'POST', { event: bundle.events[1] });
  await request(receiver, '/api/chat/history', 'POST', { event: bundle.events[0] });
  await request(sender, '/api/chat/outbox', 'POST', { id: bundle.rumor.id, ciphertext: cipher, state: 'published' });
  return { ...bundle, message };
}

try {
  const alice = await actor('Builder Alice'); const bob = await actor('Builder Bob'); const outsider = await actor('Builder outsider'); checks.push('Genuine NIP-98 authentication and replay denial for three generated identities', 'Actual signed Nostr subscriptions on an isolated private relay');
  const cipher = await alice.identity.encrypt(alice.identity.pubkey, JSON.stringify({ version: 1, owner: alice.identity.pubkey, name: 'Builder Alice', contacts: [], relayUrl }));
  const saved = await request(alice, '/api/chat/account', 'POST', { ciphertext: cipher, expectedRevision: 0 }); assert.equal(saved.revision, 1);
  await request(alice, '/api/chat/account', 'POST', { ciphertext: cipher, expectedRevision: 0 }, 409);
  assert.equal((await request(outsider, '/api/chat/account')).ciphertext, null); checks.push('Self-encrypted profile persistence and revision conflict', 'Cross-account profile isolation');
  if (!hosted) {
    await request(alice, '/api/chat/wallet/practice', 'POST', { wallet: 'alice' }); await request(bob, '/api/chat/wallet/practice', 'POST', { wallet: 'bob' });
  } else {
    const lab = JSON.parse(readFileSync(resolve(labDir, 'wallet-lab.json'), 'utf8'));
    const relay = JSON.parse(readFileSync(resolve(labDir, 'relay-public.json'), 'utf8'));
    assert.equal(lab.network, 'regtest'); assert.equal(relay.network, 'regtest');
    for (const [identity, name] of [[alice, 'alice'], [bob, 'bob']] as const) {
      const wallet = lab.wallets.find((row: { name: string }) => row.name === name); assert(wallet);
      const uri = new URL(wallet.connectionUri); uri.searchParams.set('relay', relay.url);
      await request(identity, '/api/chat/wallet/connect', 'POST', { connectionUri: uri.href });
    }
  }
  for (const identity of [alice, bob]) assert.equal((await request(identity, '/api/chat/wallet')).network, 'regtest'); checks.push('Two actual independently connected LND regtest wallets; no monetary value');
  const hello = await send(alice, bob, { type: 'text', text: 'Builder-controlled private design review.' }); assert.equal(hello.message.payload.type, 'text');
  await assert.rejects(() => unwrapGift(outsider.identity, hello.events[0])); checks.push('NIP-17 / NIP-44 / NIP-59 private-message delivery and self copy', 'Foreign identity cannot decrypt the envelope');
  await request(outsider, '/api/chat/history', 'POST', { event: hello.events[0] }, 403); assert.equal((await request(bob, '/api/chat/history', 'POST', { event: hello.events[0] })).duplicate, true); checks.push('Owner-only encrypted cloud history and exact-envelope deduplication');
  const invoice = await request<WalletInvoice>(alice, '/api/chat/wallet/invoices', 'POST', { amountSats: 100, description: 'Builder NostrChat regtest design review' }, 201);
  const facts = signedBolt11(invoice.bolt11); assert.equal(facts.network, 'regtest'); assert.equal(facts.amountSats, 100);
  const shared = await send(alice, bob, { type: 'invoice', bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: invoice.amountSats, description: invoice.description, expiresAt: invoice.expiresAt }); checks.push('Actual fixed-amount signed BOLT11 invoice from the receiving wallet', 'Invoice delivered as an encrypted conversation message');
  const pending = await request(alice, '/api/chat/wallet/invoices/' + invoice.paymentHash); assert.equal(pending.state, 'pending'); assert.equal(pending.preimage, undefined); checks.push('Pending remains unpaid until wallet proof is available');
  const review = await request(bob, '/api/chat/payments/preview', 'POST', { bolt11: invoice.bolt11 }); assert.equal(review.amountSats, 100); assert.equal(review.network, 'regtest'); assert(review.walletReference);
  await request(bob, '/api/chat/payments', 'POST', { reviewId: review.reviewId }, 422); await request(outsider, '/api/chat/payments', 'POST', { reviewId: review.reviewId, confirmed: true }, 404); checks.push('Immutable wallet, amount, network and expiry review', 'Missing confirmation and foreign review rejected');
  const paid = await request(bob, '/api/chat/payments', 'POST', { reviewId: review.reviewId, confirmed: true }); assert.equal(paid.state, 'settled'); assert(await paymentProofMatches(invoice.paymentHash, paid.preimage));
  const receivingProof = await request(alice, '/api/chat/wallet/invoices/' + invoice.paymentHash); assert.equal(receivingProof.state, 'settled'); assert(await paymentProofMatches(invoice.paymentHash, receivingProof.preimage)); checks.push('Actual 100-sat Lightning settlement through private LND', 'Payment preimage independently verified by payer and receiver');
  const receipt = await send(bob, alice, { type: 'receipt', paymentHash: invoice.paymentHash, preimage: paid.preimage, invoiceId: shared.rumor.id });
  const original = alice.received.get(shared.rumor.id)!; assert.equal((await matchingReceiptInvoices(alice.identity.pubkey, receipt.message, [original])).length, 1); checks.push('Verified receipt encrypted back into its original conversation');
  assert.equal((await request(bob, '/api/chat/payments', 'POST', { reviewId: review.reviewId, confirmed: true })).preimage, paid.preimage); checks.push('Repeat confirmation returns the recorded receipt');
  assert.equal((await request(outsider, '/api/chat/payments/' + invoice.paymentHash)).state, 'not_found'); checks.push('Foreign accounts cannot read the settlement proof');
  for (const identity of [alice, bob]) await request(identity, '/api/chat/wallet', 'DELETE');
  assert.equal((await request(bob, '/api/chat/payments/' + invoice.paymentHash)).preimage, paid.preimage); assert.equal((await request(alice, '/api/chat/wallet/invoices/' + invoice.paymentHash)).preimage, paid.preimage); checks.push('Verified sending and receiving receipts survive wallet disconnect');
  const evidence = { checkedAt: new Date().toISOString(), origin: base, backend: config.backend, network: 'regtest', monetaryValue: false, classification: 'Builder-controlled generated identities and two real private LND wallets. This is integration proof, not independent adoption or mainnet settlement.', relay: 'Private loopback Nostr relay; no public message publication', transaction: { paymentHash: invoice.paymentHash, amountSats: 100, preimage: paid.preimage, settledAt: paid.settledAt, invoiceRumorId: shared.rumor.id, receiptRumorId: receipt.rumor.id, payerAndReceiverVerified: true }, checks, sourceHashes };
  mkdirSync(resolve(evidenceFile, '..'), { recursive: true }); writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`NostrChat passed ${checks.length} end-to-end checks with an actual 100-sat private-regtest payment. No real-value coins or public messages were used.`);
} finally {
  for (const value of actors) {
    for (const id of value.outbox) { try { await request(value, '/api/chat/outbox/' + id, 'DELETE', { confirmed: true }); } catch {} }
    try { await request(value, '/api/chat/history', 'DELETE', { confirmed: true }); } catch {}
    try { await request(value, '/api/chat/wallet', 'DELETE'); } catch {}
    try { await request(value, '/api/session/logout', 'POST', {}); } catch {}
    value.relay.close(); value.identity.destroy?.(); value.identity.secret?.fill(0);
  }
}
