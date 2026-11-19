import { Router, type Request, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { NwcWallet, inspectConnectionUri } from '../packages/nwc-gate/src/nwc.ts';
import { GateError } from '../packages/nwc-gate/src/types.ts';
import { signedBolt11 } from '../packages/chat/src/invoice.ts';
import { CHAT_CACHE_BYTES, CHAT_CACHE_COUNT, CHAT_OUTBOX_COUNT, chatCiphertext, chatEnvelope, chatPage, normalizeNetwork } from '../packages/chat/src/validation.ts';
import type { AppContext, WalletAdapter, WalletInfo, WalletInvoice } from './context.ts';
import { seal, unseal } from './store.ts';
import { assertPaymentAmount } from './limits.ts';
import { isLocalHost } from './auth.ts';
import { readLabConfig } from './lnd.ts';

export function setupChatTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_accounts(pubkey TEXT PRIMARY KEY,ciphertext TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_history(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,pubkey TEXT NOT NULL,event_id TEXT NOT NULL,event_json TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(pubkey,event_id));
    CREATE INDEX IF NOT EXISTS chat_history_owner ON chat_history(pubkey,ordinal);
    CREATE TABLE IF NOT EXISTS chat_outbox(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,pubkey TEXT NOT NULL,id TEXT NOT NULL,ciphertext TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(pubkey,id));
    CREATE INDEX IF NOT EXISTS chat_outbox_owner ON chat_outbox(pubkey,ordinal);
    CREATE TABLE IF NOT EXISTS chat_wallet_connections(pubkey TEXT PRIMARY KEY,encrypted_uri TEXT NOT NULL,version TEXT NOT NULL,wallet_pubkey TEXT NOT NULL,wallet_fingerprint TEXT NOT NULL,network TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_wallet_invoices(payment_hash TEXT PRIMARY KEY,pubkey TEXT NOT NULL,invoice_json TEXT NOT NULL,wallet_fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_payment_reviews(review_id TEXT PRIMARY KEY,pubkey TEXT NOT NULL,bolt11 TEXT NOT NULL,payment_hash TEXT NOT NULL,amount_sats INTEGER NOT NULL,network TEXT NOT NULL,expires_at INTEGER NOT NULL,review_expires_at INTEGER NOT NULL,wallet_fingerprint TEXT NOT NULL,connection_version TEXT NOT NULL,wallet_pubkey TEXT NOT NULL,alias TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_payments(payment_hash TEXT PRIMARY KEY,pubkey TEXT NOT NULL,bolt11 TEXT NOT NULL,amount_sats INTEGER NOT NULL,state TEXT NOT NULL,review_id TEXT NOT NULL,attempt_id TEXT NOT NULL,wallet_fingerprint TEXT NOT NULL,connection_version TEXT NOT NULL,created_at INTEGER NOT NULL,preimage TEXT,settled_at INTEGER);
  `);
}
type Connection = { pubkey: string; encrypted_uri: string; version: string; wallet_pubkey: string; wallet_fingerprint: string; network: string };
type Payment = { pubkey: string; payment_hash: string; bolt11: string; amount_sats: number; state: string; review_id: string; attempt_id: string; wallet_fingerprint: string; connection_version: string; created_at: number; preimage: string | null; settled_at: number | null };
type Review = { pubkey: string; review_id: string; bolt11: string; payment_hash: string; amount_sats: number; network: string; expires_at: number; review_expires_at: number; wallet_fingerprint: string; connection_version: string; wallet_pubkey: string; alias: string | null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const proof = (paymentHash: string, preimage: unknown): preimage is string => typeof preimage === 'string' && /^[a-f0-9]{64}$/.test(preimage) && createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') === paymentHash;
function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function paymentShape(item: Payment) {
  if (item.state === 'settled') {
    if (!proof(item.payment_hash, item.preimage) || !Number.isSafeInteger(item.settled_at)) throw new GateError('UNVERIFIED_PROOF', 'The stored payment has no verifiable settlement proof.', 409);
    return { paymentHash: item.payment_hash, amountSats: item.amount_sats, state: 'settled' as const, preimage: item.preimage!, settledAt: item.settled_at! };
  }
  return { paymentHash: item.payment_hash, amountSats: item.amount_sats, state: 'unknown' as const, message: 'A payment attempt is recorded. Check its status; do not send the same invoice again.' };
}
function invoiceReceipt(invoice: WalletInvoice) {
  if (invoice.state === 'settled' && (!proof(invoice.paymentHash, invoice.preimage) || !Number.isSafeInteger(invoice.settledAt))) throw new GateError('UNVERIFIED_PROOF', 'The stored invoice has no verifiable settlement proof.', 409);
  return invoice;
}
function isPrivate(ip: string) {
  if (isIP(ip) === 6) { const first = Number.parseInt(ip.split(':')[0] || '0', 16); return ip === '::' || ip === '::1' || /^::ffff:/i.test(ip) || first >= 0xfc00 && first <= 0xfdff || first >= 0xfe80 && first <= 0xfebf || first >= 0xff00 || /^2001:db8:|^2002:/i.test(ip); }
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 2, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113;
}
async function allowedConnection(uri: string, demo: boolean) {
  const inspected = inspectConnectionUri(uri);
  const allowed = (process.env.SATS_NWC_RELAY_ALLOWLIST ?? 'relay.getalby.com,relay.nwc.lol,nostr.bitcoiner.social,relay.damus.io,relay.primal.net').split(',').map(value => value.trim()).filter(Boolean);
  for (const relay of inspected.relays) {
    const url = new URL(relay);
    const localPort = process.env.SATS_API_PORT || '4400';
    if (demo && ['localhost', '127.0.0.1'].includes(url.hostname) && ['4400', localPort].includes(url.port) && url.pathname === '/relay' && url.protocol === 'ws:') continue;
    if (url.protocol !== 'wss:' || url.port && url.port !== '443' || !allowed.includes(url.hostname)) throw new GateError('RELAY_RESTRICTED', 'This wallet relay is not permitted by the server configuration.', 403);
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(row => isPrivate(row.address))) throw new GateError('RELAY_RESTRICTED', 'Private network wallet relays are disabled.', 403);
  }
  return inspected;
}

export function createChatRouter(ctx: AppContext, options: { walletFactory?: (uri: string) => WalletAdapter; allowConnection?: (uri: string) => Promise<ReturnType<typeof inspectConnectionUri>> } = {}) {
  setupChatTables(ctx.db);
  const router = Router();
  const factory = options.walletFactory ?? (uri => new NwcWallet(uri));
  const allow = options.allowConnection ?? (uri => allowedConnection(uri, ctx.demoEnabled));
  const owner = (req: Request) => {
    const user = ctx.user(req);
    const expected = req.get('X-Nostr-Pubkey') || '';
    if (!/^[a-f0-9]{64}$/.test(expected) || user.pubkey !== expected || user.demo) throw new GateError('IDENTITY_CHANGED', 'Your signed-in identity changed. Reconnect the account you are using.', 409);
    return user.pubkey;
  };
  const send = (req: Request, res: Response, value: unknown, status = 200) => { res.setHeader('X-Nostr-Pubkey', owner(req)); res.status(status).json(value); };
  const connection = (pubkey: string) => ctx.db.prepare('SELECT * FROM chat_wallet_connections WHERE pubkey=?').get(pubkey) as Connection | undefined;
  const current = (req: Request, captured: Connection) => {
    const row = connection(owner(req));
    if (!row || row.pubkey !== captured.pubkey || row.version !== captured.version || row.wallet_fingerprint !== captured.wallet_fingerprint) throw new GateError('WALLET_CHANGED', 'Your wallet connection changed. Review this operation again.', 409);
  };
  const payment = (pubkey: string, paymentHash: string) => ctx.db.prepare('SELECT * FROM chat_payments WHERE pubkey=? AND payment_hash=?').get(pubkey, paymentHash) as Payment | undefined;
  const storedInvoice = (pubkey: string, paymentHash: string) => ctx.db.prepare('SELECT * FROM chat_wallet_invoices WHERE pubkey=? AND payment_hash=?').get(pubkey, paymentHash) as { invoice_json: string; wallet_fingerprint: string; created_at: number } | undefined;
  async function withWallet<T>(req: Request, operation: (wallet: WalletAdapter, row: Connection, info: WalletInfo) => Promise<T>, expected?: { version?: string; fingerprint?: string }) {
    const row = connection(owner(req));
    if (!row) throw new GateError('WALLET_REQUIRED', 'Connect your Lightning wallet first.', 409);
    if (expected?.version && row.version !== expected.version || expected?.fingerprint && row.wallet_fingerprint !== expected.fingerprint) throw new GateError('WALLET_CHANGED', 'Reconnect the original wallet, or review the payment using the new connection.', 409);
    let uri: string;
    try { const value = JSON.parse(unseal(row.encrypted_uri)); if (value.product !== 'NostrChat' || value.owner !== row.pubkey || typeof value.uri !== 'string') throw new Error(); uri = value.uri; }
    catch { throw new GateError('INVALID_CONNECTION', 'This encrypted chat wallet connection cannot be opened.', 422); }
    await allow(uri); current(req, row);
    const wallet = factory(uri);
    try {
      const info = await wallet.getInfo();
      if (info.connectionFingerprint !== row.wallet_fingerprint || info.walletPubkey !== row.wallet_pubkey || normalizeNetwork(info.network) !== row.network) throw new GateError('WALLET_CHANGED', 'Your wallet identity or network changed. Reconnect it before continuing.', 409);
      current(req, row);
      return await operation(wallet, row, info);
    } finally { wallet.close?.(); }
  }
  async function walletStatus(wallet: WalletAdapter, info: WalletInfo) {
    let balanceSats: number | undefined; let balanceUnavailable = false;
    if (info.methods.includes('get_balance')) { try { balanceSats = await wallet.getBalance(); } catch { balanceUnavailable = true; } }
    return { connected: true, kind: wallet.kind, capabilities: info.methods, network: normalizeNetwork(info.network), ...(info.alias ? { alias: info.alias.slice(0, 80) } : {}), practice: normalizeNetwork(info.network) === 'regtest', ...(balanceSats !== undefined ? { balanceSats } : {}), ...(balanceUnavailable ? { balanceUnavailable: true } : {}) };
  }
  async function connect(req: Request, uri: string) {
    const pubkey = owner(req); const inspected = await allow(uri); owner(req);
    const wallet = factory(uri);
    try {
      const info = await wallet.getInfo(); owner(req);
      if (!info.connectionFingerprint || !info.methods.includes('lookup_invoice') || !['bitcoin', 'testnet', 'signet', 'regtest', 'simnet'].includes(normalizeNetwork(info.network))) throw new GateError('LOOKUP_PERMISSION', 'Your wallet needs invoice lookup permission and a supported Bitcoin network.', 409);
      const encrypted = seal(JSON.stringify({ product: 'NostrChat', owner: pubkey, uri }));
      ctx.db.prepare('INSERT INTO chat_wallet_connections(pubkey,encrypted_uri,version,wallet_pubkey,wallet_fingerprint,network,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(pubkey) DO UPDATE SET encrypted_uri=excluded.encrypted_uri,version=excluded.version,wallet_pubkey=excluded.wallet_pubkey,wallet_fingerprint=excluded.wallet_fingerprint,network=excluded.network,updated_at=excluded.updated_at').run(pubkey, encrypted, hash(encrypted), inspected.walletPubkey, info.connectionFingerprint, normalizeNetwork(info.network), ctx.now());
      const captured = connection(pubkey)!;
      const result = await walletStatus(wallet, info); current(req, captured); return result;
    } finally { wallet.close?.(); }
  }
  function settle(item: Payment, preimage: string) {
    if (!proof(item.payment_hash, preimage)) throw new GateError('UNVERIFIED_PROOF', 'The wallet has not supplied verifiable settlement proof.', 409);
    ctx.db.prepare("UPDATE chat_payments SET state='settled',preimage=?,settled_at=? WHERE payment_hash=? AND attempt_id=? AND state!='settled'").run(preimage, ctx.now(), item.payment_hash, item.attempt_id);
    return paymentShape(payment(item.pubkey, item.payment_hash)!);
  }
  router.get('/config', (_req, res) => {
    res.json({ backend: 'local', relayUrl: process.env.SATS_CHAT_RELAY_URL || `ws://127.0.0.1:${process.env.SATS_API_PORT || 4400}/relay`, publicRelay: false, messageLimit: 4000, lightningLabReady: ctx.demoEnabled && Boolean(readLabConfig()) });
  });
  router.use(ctx.requireUser, (req, _res, next) => { try { owner(req); next(); } catch (error) { next(error); } });
  router.get('/account', (req, res) => {
    const pubkey = owner(req);
    const row = ctx.db.prepare('SELECT * FROM chat_accounts WHERE pubkey=?').get(pubkey) as { ciphertext: string; revision: number; updated_at: number } | undefined;
    send(req, res, { pubkey, ciphertext: row?.ciphertext ?? null, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null });
  });
  router.post('/account', (req, res) => {
    const pubkey = owner(req);
    const input = z.object({ ciphertext: z.string(), expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
    const ciphertext = chatCiphertext(input.ciphertext);
    const value = transaction(ctx.db, () => {
      const row = ctx.db.prepare('SELECT revision FROM chat_accounts WHERE pubkey=?').get(pubkey) as { revision: number } | undefined;
      if ((row?.revision ?? 0) !== input.expectedRevision) throw new GateError('REVISION_CONFLICT', 'Your account was updated in another tab. Refresh before saving.', 409);
      const revision = input.expectedRevision + 1; const updatedAt = ctx.now();
      ctx.db.prepare('INSERT INTO chat_accounts VALUES(?,?,?,?) ON CONFLICT(pubkey) DO UPDATE SET ciphertext=excluded.ciphertext,revision=excluded.revision,updated_at=excluded.updated_at').run(pubkey, ciphertext, revision, updatedAt);
      return { pubkey, ciphertext, revision, updatedAt };
    });
    send(req, res, value);
  });
  router.get('/history', (req, res) => {
    const pubkey = owner(req); const page = chatPage(req.query.cursor, req.query.limit);
    let before = Number.MAX_SAFE_INTEGER;
    if (page.cursor) {
      if (!/^h:[a-f0-9]{64}$/.test(page.cursor)) throw new GateError('INVALID_PAGE', 'The history cursor is invalid.', 422);
      const item = ctx.db.prepare('SELECT ordinal FROM chat_history WHERE pubkey=? AND event_id=?').get(pubkey, page.cursor.slice(2)) as { ordinal: number } | undefined;
      if (!item) throw new GateError('INVALID_PAGE', 'This history page is unavailable. Reload your history.', 422);
      before = item.ordinal;
    }
    const rows = ctx.db.prepare('SELECT event_id,event_json FROM chat_history WHERE pubkey=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?').all(pubkey, before, page.limit + 1) as { event_id: string; event_json: string }[];
    const slice = rows.slice(0, page.limit); const hasMore = rows.length > page.limit;
    send(req, res, { events: slice.map(row => JSON.parse(row.event_json)), cursor: hasMore ? `h:${slice.at(-1)!.event_id}` : null, hasMore });
  });
  router.post('/history', (req, res) => {
    const pubkey = owner(req); const input = z.object({ event: z.unknown() }).strict().parse(req.body);
    const event = chatEnvelope(input.event, pubkey, ctx.now()); const encoded = JSON.stringify(event); const bytes = Buffer.byteLength(encoded);
    const duplicate = transaction(ctx.db, () => {
      if (ctx.db.prepare('SELECT 1 FROM chat_history WHERE pubkey=? AND event_id=?').get(pubkey, event.id)) return true;
      const usage = ctx.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM chat_history WHERE pubkey=?').get(pubkey) as { count: number; bytes: number };
      if (usage.count >= CHAT_CACHE_COUNT || usage.bytes + bytes > CHAT_CACHE_BYTES) throw new GateError('CACHE_FULL', 'Your encrypted cloud cache is full. Clear the cache in Settings to save more envelopes.', 413);
      ctx.db.prepare('INSERT INTO chat_history(pubkey,event_id,event_json,bytes,created_at) VALUES(?,?,?,?,?)').run(pubkey, event.id, encoded, bytes, ctx.now()); return false;
    });
    send(req, res, { saved: true, duplicate });
  });
  router.delete('/history', (req, res) => { z.object({ confirmed: z.literal(true) }).strict().parse(req.body); const result = ctx.db.prepare('DELETE FROM chat_history WHERE pubkey=?').run(owner(req)); send(req, res, { cleared: true, count: Number(result.changes) }); });
  router.get('/outbox', (req, res) => {
    const pubkey = owner(req); const page = chatPage(req.query.cursor, req.query.limit); let after = 0;
    if (page.cursor) {
      if (!/^o:[a-f0-9]{64}$/.test(page.cursor)) throw new GateError('INVALID_PAGE', 'The outbox cursor is invalid.', 422);
      const item = ctx.db.prepare('SELECT ordinal FROM chat_outbox WHERE pubkey=? AND id=?').get(pubkey, page.cursor.slice(2)) as { ordinal: number } | undefined;
      if (!item) throw new GateError('INVALID_PAGE', 'This outbox page is unavailable. Reload the outbox.', 422);
      after = item.ordinal;
    }
    const rows = ctx.db.prepare('SELECT id,ciphertext,state,updated_at FROM chat_outbox WHERE pubkey=? AND ordinal>? ORDER BY ordinal ASC LIMIT ?').all(pubkey, after, page.limit + 1) as { id: string; ciphertext: string; state: string; updated_at: number }[];
    const slice = rows.slice(0, page.limit); const hasMore = rows.length > page.limit;
    send(req, res, { items: slice.map(row => ({ id: row.id, ciphertext: row.ciphertext, state: row.state, updatedAt: row.updated_at })), cursor: hasMore ? `o:${slice.at(-1)!.id}` : null, hasMore });
  });
  router.post('/outbox', (req, res) => {
    const pubkey = owner(req); const input = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), ciphertext: z.string(), state: z.enum(['queued', 'published']) }).strict().parse(req.body); const ciphertext = chatCiphertext(input.ciphertext);
    const value = transaction(ctx.db, () => {
      const previous = ctx.db.prepare('SELECT ciphertext,state,updated_at FROM chat_outbox WHERE pubkey=? AND id=?').get(pubkey, input.id) as { ciphertext: string; state: string; updated_at: number } | undefined;
      if (previous) {
        if (previous.ciphertext !== ciphertext) throw new GateError('OUTBOX_CONFLICT', 'A different encrypted message already uses this reference.', 409);
        const state = previous.state === 'published' || input.state === 'published' ? 'published' : 'queued'; const updatedAt = previous.state === state ? previous.updated_at : ctx.now();
        if (state !== previous.state) ctx.db.prepare('UPDATE chat_outbox SET state=?,updated_at=? WHERE pubkey=? AND id=?').run(state, updatedAt, pubkey, input.id);
        return { id: input.id, ciphertext, state, updatedAt };
      }
      const usage = ctx.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(ciphertext)),0) AS bytes FROM chat_outbox WHERE pubkey=?').get(pubkey) as { count: number; bytes: number };
      if (usage.count >= CHAT_OUTBOX_COUNT || usage.bytes + ciphertext.length > CHAT_CACHE_BYTES) throw new GateError('OUTBOX_FULL', 'Your encrypted outbox is full. Remove published items before adding another message.', 413);
      const updatedAt = ctx.now(); ctx.db.prepare('INSERT INTO chat_outbox(pubkey,id,ciphertext,state,updated_at) VALUES(?,?,?,?,?)').run(pubkey, input.id, ciphertext, input.state, updatedAt); return { ...input, ciphertext, updatedAt };
    });
    send(req, res, value);
  });
  router.delete('/outbox/:id', (req, res) => { z.object({ confirmed: z.literal(true) }).strict().parse(req.body); const id = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.id); ctx.db.prepare('DELETE FROM chat_outbox WHERE pubkey=? AND id=?').run(owner(req), id); send(req, res, { deleted: true }); });
  router.get('/wallet', async (req, res) => {
    const captured = connection(owner(req)); if (!captured) { send(req, res, { connected: false, capabilities: [] }); return; }
    try { send(req, res, await withWallet(req, async (wallet, row, info) => { const result = await walletStatus(wallet, info); current(req, row); return result; })); }
    catch { current(req, captured); send(req, res, { connected: true, capabilities: [], error: 'Your wallet is offline. Keep it online and check the connection permissions.' }); }
  });
  router.post('/wallet/connect', async (req, res) => { const { connectionUri } = z.object({ connectionUri: z.string().min(60).max(4096) }).strict().parse(req.body); send(req, res, await connect(req, connectionUri)); });
  router.post('/wallet/practice', async (req, res) => {
    if (!ctx.demoEnabled || !isLocalHost(req)) throw new GateError('DEMO_DISABLED', 'Practice wallets are available only in the local lab.', 403);
    const { wallet: name } = z.object({ wallet: z.enum(['alice', 'bob']) }).strict().parse(req.body);
    const source = readLabConfig()?.wallets.find(item => item.name === name);
    if (!source) throw new GateError('LAB_UNAVAILABLE', 'Start the local Lightning lab before connecting a practice wallet.', 503);
    send(req, res, await connect(req, source.connectionUri));
  });
  router.delete('/wallet', (req, res) => { ctx.db.prepare('DELETE FROM chat_wallet_connections WHERE pubkey=?').run(owner(req)); send(req, res, { connected: false }); });
  router.post('/wallet/invoices', async (req, res) => {
    const pubkey = owner(req); const input = z.object({ amountSats: z.number().int().min(1).max(1_000_000), description: z.string().max(240).default('NostrChat payment') }).strict().parse(req.body);
    const invoice = await withWallet(req, async (wallet, row) => {
      const item = await wallet.makeInvoice(input); current(req, row); const parsed = signedBolt11(item.bolt11);
      if (parsed.paymentHash !== item.paymentHash || parsed.amountSats !== input.amountSats || parsed.amountSats !== item.amountSats || parsed.expiresAt !== item.expiresAt || parsed.network !== row.network || item.state !== 'pending' || item.expiresAt <= ctx.now() || item.preimage || item.settledAt !== undefined) throw new GateError('INVOICE_MISMATCH', 'Your wallet returned different invoice details.', 502);
      const value = { ...item, bolt11: parsed.bolt11 };
      if (ctx.db.prepare('SELECT 1 FROM chat_wallet_invoices WHERE payment_hash=?').get(item.paymentHash)) throw new GateError('DUPLICATE_INVOICE', 'This payment request already exists.', 409);
      ctx.db.prepare('INSERT INTO chat_wallet_invoices VALUES(?,?,?,?,?)').run(item.paymentHash, pubkey, JSON.stringify(value), row.wallet_fingerprint, ctx.now()); return value;
    }); send(req, res, invoice, 201);
  });
  router.get('/wallet/invoices/:hash', async (req, res) => {
    const pubkey = owner(req); const paymentHash = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.hash); const row = storedInvoice(pubkey, paymentHash);
    if (!row) throw new GateError('INVOICE_NOT_FOUND', 'This account did not create that payment request.', 404);
    const original = JSON.parse(row.invoice_json) as WalletInvoice;
    if (original.state === 'settled') { send(req, res, invoiceReceipt(original)); return; }
    const result = await withWallet(req, async (wallet, captured) => {
      const verified = await wallet.lookupInvoice(paymentHash); owner(req);
      const canonical = JSON.parse(storedInvoice(pubkey, paymentHash)!.invoice_json) as WalletInvoice;
      if (canonical.state === 'settled') return invoiceReceipt(canonical);
      current(req, captured);
      if (verified.paymentHash !== paymentHash || verified.bolt11 !== original.bolt11 || verified.amountSats !== original.amountSats || verified.expiresAt !== original.expiresAt) throw new GateError('PROOF_MISMATCH', 'The wallet returned different invoice details.', 409);
      let value: WalletInvoice;
      if (verified.state === 'settled') {
        if (!proof(paymentHash, verified.preimage) || verified.settledAt !== undefined && (!Number.isSafeInteger(verified.settledAt) || verified.settledAt < row.created_at - 1000 || verified.settledAt > ctx.now() + 1000)) throw new GateError('UNVERIFIED_PROOF', 'The wallet has not supplied verifiable settlement proof.', 409);
        value = { ...original, state: 'settled', preimage: verified.preimage, settledAt: Math.min(verified.settledAt ?? ctx.now(), ctx.now()) };
      } else value = { ...original, state: original.expiresAt <= ctx.now() ? 'expired' : 'pending' };
      ctx.db.prepare('UPDATE chat_wallet_invoices SET invoice_json=? WHERE pubkey=? AND payment_hash=?').run(JSON.stringify(value), pubkey, paymentHash); return value;
    }, { fingerprint: row.wallet_fingerprint }); send(req, res, result);
  });
  router.post('/payments/preview', async (req, res) => {
    const pubkey = owner(req); const { bolt11 } = z.object({ bolt11: z.string().min(50).max(12_000) }).strict().parse(req.body); const invoice = signedBolt11(bolt11); assertPaymentAmount(invoice.amountSats);
    if (invoice.expiresAt <= ctx.now()) throw new GateError('INVOICE_EXPIRED', 'This invoice has expired. Ask for a new one.', 422);
    const review = await withWallet(req, async (_wallet, row, info) => {
      if (!info.methods.includes('pay_invoice') || !info.methods.includes('lookup_invoice')) throw new GateError('PAYMENT_PERMISSION', 'Your wallet needs capped payment and invoice lookup permissions.', 409);
      if (invoice.network !== row.network) throw new GateError('WRONG_NETWORK', 'The invoice and wallet use different Bitcoin networks.', 422);
      current(req, row); const reviewId = randomUUID(); const reviewExpiresAt = Math.min(invoice.expiresAt, ctx.now() + 90_000);
      ctx.db.prepare('DELETE FROM chat_payment_reviews WHERE review_expires_at<?').run(ctx.now() - 300_000);
      if ((ctx.db.prepare('SELECT COUNT(*) AS count FROM chat_payment_reviews WHERE pubkey=?').get(pubkey) as { count: number }).count >= 64) throw new GateError('REVIEW_LIMIT', 'Too many payment reviews are open. Wait a few minutes before reviewing another invoice.', 429);
      ctx.db.prepare('INSERT INTO chat_payment_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(reviewId, pubkey, invoice.bolt11, invoice.paymentHash, invoice.amountSats, invoice.network, invoice.expiresAt, reviewExpiresAt, row.wallet_fingerprint, row.version, row.wallet_pubkey, info.alias?.slice(0, 80) ?? null, ctx.now());
      return { reviewId, paymentHash: invoice.paymentHash, amountSats: invoice.amountSats, network: invoice.network, expiresAt: invoice.expiresAt, reviewExpiresAt, wallet: { kind: 'nwc', network: row.network, ...(info.alias ? { alias: info.alias.slice(0, 80) } : {}) }, walletReference: row.wallet_fingerprint };
    }); send(req, res, review);
  });
  router.post('/payments', async (req, res) => {
    const pubkey = owner(req); const { reviewId } = z.object({ reviewId: z.string().uuid(), confirmed: z.literal(true) }).strict().parse(req.body);
    const review = ctx.db.prepare('SELECT * FROM chat_payment_reviews WHERE review_id=? AND pubkey=?').get(reviewId, pubkey) as Review | undefined;
    if (!review) throw new GateError('REVIEW_NOT_FOUND', 'This payment review is unavailable. Review the invoice again.', 404);
    const previous = payment(pubkey, review.payment_hash); if (previous) { send(req, res, paymentShape(previous)); return; }
    if (review.expires_at <= ctx.now() || review.review_expires_at <= ctx.now()) throw new GateError('REVIEW_EXPIRED', 'Your payment review expired. Review the invoice again.', 422);
    assertPaymentAmount(review.amount_sats);
    const result = await withWallet(req, async (wallet, captured, info) => {
      if (!info.methods.includes('pay_invoice') || !info.methods.includes('lookup_invoice')) throw new GateError('PAYMENT_PERMISSION', 'Your wallet needs capped payment and invoice lookup permissions.', 409);
      const claimed = transaction(ctx.db, () => {
        current(req, captured);
        const existing = ctx.db.prepare('SELECT * FROM chat_payments WHERE payment_hash=?').get(review.payment_hash) as Payment | undefined;
        if (existing) { if (existing.pubkey !== pubkey) throw new GateError('PAYMENT_ALREADY_REQUESTED', 'This invoice already has a recorded payment attempt.', 409); return { existing }; }
        if (review.review_expires_at <= ctx.now() || review.expires_at <= ctx.now()) throw new GateError('REVIEW_EXPIRED', 'The review expired while checking your wallet.', 422);
        if (ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sf_expenses'").get() && ctx.db.prepare('SELECT 1 FROM sf_expenses WHERE payment_hash=? AND is_fixture=0').get(review.payment_hash)) throw new GateError('USE_APPROVAL_FLOW', 'This invoice belongs to a company expense. Use the independent approval workflow.', 409);
        if (ctx.db.prepare('SELECT 1 FROM wallet_payments WHERE payment_hash=?').get(review.payment_hash)) throw new GateError('PAYMENT_ALREADY_REQUESTED', 'This invoice already has a recorded payment attempt.', 409);
        const attemptId = randomUUID();
        ctx.db.prepare('INSERT INTO chat_payments(payment_hash,pubkey,bolt11,amount_sats,state,review_id,attempt_id,wallet_fingerprint,connection_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(review.payment_hash, pubkey, review.bolt11, review.amount_sats, 'paying', reviewId, attemptId, captured.wallet_fingerprint, captured.version, ctx.now());
        return { existing: undefined };
      });
      if (claimed.existing) return paymentShape(claimed.existing);
      const item = payment(pubkey, review.payment_hash)!;
      try { const paid = await wallet.payInvoice(item.bolt11); if (paid.paymentHash !== item.payment_hash) throw new Error(); return settle(item, paid.preimage); }
      catch { ctx.db.prepare("UPDATE chat_payments SET state='unknown' WHERE payment_hash=? AND attempt_id=? AND state='paying'").run(item.payment_hash, item.attempt_id); return paymentShape(payment(pubkey, item.payment_hash)!); }
    }, { version: review.connection_version, fingerprint: review.wallet_fingerprint }); send(req, res, result);
  });
  router.get('/payments/:hash', async (req, res) => {
    const pubkey = owner(req); const paymentHash = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.hash); const item = payment(pubkey, paymentHash);
    if (!item) { send(req, res, { paymentHash, state: 'not_found' }); return; }
    if (item.state === 'settled') { send(req, res, paymentShape(item)); return; }
    let result;
    try {
      result = await withWallet(req, async (wallet) => {
        const verified = await wallet.lookupInvoice(paymentHash).catch(() => null); owner(req);
        if (verified?.state === 'settled' && proof(paymentHash, verified.preimage) && verified.bolt11 === item.bolt11 && verified.amountSats === item.amount_sats) return settle(item, verified.preimage);
        return paymentShape(payment(pubkey, paymentHash)!);
      }, { fingerprint: item.wallet_fingerprint });
    } catch { owner(req); const receipt = paymentShape(payment(pubkey, paymentHash)!); result = receipt.state === 'settled' ? receipt : { ...receipt, message: 'The result is still uncertain. Reconnect the original wallet and check its transaction history; no repeat payment was sent.' }; }
    send(req, res, result);
  });
  return router;
}
