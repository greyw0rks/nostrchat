"use node";

import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import { z } from 'zod';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebSocket as NodeWebSocket } from 'ws';
import { NwcWallet, inspectConnectionUri } from '../packages/nwc-gate/src/nwc';
import { GateError, type WalletInfo } from '../packages/nwc-gate/src/types';
import { signedBolt11 } from '../packages/chat/src/invoice';
import { chatPage, normalizeNetwork } from '../packages/chat/src/validation';
import { cleanError, digestHex, fail, proofMatches, type HttpResult, type Json } from './lib';

if (!globalThis.WebSocket) (globalThis as unknown as { WebSocket: typeof NodeWebSocket }).WebSocket = NodeWebSocket;
type Args = { tokenHash: string; expectedPubkey: string; method: string; path: string; body: unknown; query?: Record<string, string> };
const response = (body: unknown, status = 200): HttpResult => ({ status, body: JSON.parse(JSON.stringify(body)) as Json });
const auth = (args: Args) => ({ tokenHash: args.tokenHash, expectedPubkey: args.expectedPubkey, now: Date.now() });
function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) fail(422, 'INVALID_INPUT', 'Check the submitted fields and try again.');
  return result.data;
}
function paymentLimit(amount: number) {
  const limit = Number(process.env.GREY_MAX_PAYMENT_SATS ?? 1_000_000);
  if (!Number.isSafeInteger(limit) || limit <= 0) fail(503, 'SERVER_CONFIGURATION', 'The payment limit is not configured correctly.');
  if (amount > limit) fail(403, 'PAYMENT_LIMIT', 'This invoice exceeds the configured per-payment limit.');
}
function openConnection(value: string, owner: string) {
  const key = process.env.GREY_WALLET_ENCRYPTION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(key)) fail(503, 'SERVER_CONFIGURATION', 'Wallet connections are not configured on this server.');
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error();
    const iv = Buffer.from(parts[1], 'base64'); const data = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || data.length < 17) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    decipher.setAAD(Buffer.from(`NostrChat NWC v1:${owner}`));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
  } catch { fail(422, 'INVALID_CONNECTION', 'This encrypted chat wallet connection cannot be opened.'); }
}
function privateAddress(ip: string) {
  if (isIP(ip) === 6) {
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    return ip === '::' || ip === '::1' || /^::ffff:/i.test(ip) || first >= 0xfc00 && first <= 0xfdff || first >= 0xfe80 && first <= 0xfebf || first >= 0xff00 || /^2001:db8:|^2002:/i.test(ip);
  }
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 2, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113;
}
async function allowedConnection(uri: string) {
  const inspected = inspectConnectionUri(uri);
  const allowed = (process.env.GREY_NWC_RELAY_ALLOWLIST ?? 'relay.getalby.com,relay.nwc.lol,nostr.bitcoiner.social,relay.damus.io,relay.primal.net').split(',').map(value => value.trim()).filter(Boolean);
  if (process.env.GREY_REGTEST_RELAY_HOST) allowed.push(process.env.GREY_REGTEST_RELAY_HOST);
  for (const relay of inspected.relays) {
    const url = new URL(relay);
    if (url.protocol !== 'wss:' || url.port && url.port !== '443' || !allowed.includes(url.hostname)) fail(403, 'RELAY_RESTRICTED', 'This wallet relay is not permitted by the server configuration.');
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(row => privateAddress(row.address))) fail(403, 'RELAY_RESTRICTED', 'Private network wallet relays are disabled.');
  }
  return inspected;
}
async function assertOwner(ctx: ActionCtx, args: Args) {
  const user = await ctx.runQuery(internal.model.session, { tokenHash: args.tokenHash, now: Date.now() });
  if (!user) fail(401, 'AUTH_REQUIRED', 'Your session has expired. Reconnect your Nostr identity.');
  if (!/^[a-f0-9]{64}$/.test(args.expectedPubkey) || user.pubkey !== args.expectedPubkey) fail(409, 'IDENTITY_CHANGED', 'Your signed-in identity changed. Reconnect the account you are using.');
}
function matchesConnection(info: WalletInfo, connection: Doc<'chatWalletConnections'>) {
  if (normalizeNetwork(info.network) !== connection.network || info.connectionFingerprint !== connection.connectionFingerprint || info.walletPubkey !== connection.walletPubkey) fail(409, 'WALLET_CHANGED', 'Your wallet identity or network changed. Reconnect and review the operation.');
}
async function status(wallet: NwcWallet, info: WalletInfo) {
  let balanceSats: number | undefined;
  let balanceUnavailable = false;
  if (info.methods.includes('get_balance')) {
    try { balanceSats = await wallet.getBalance(); } catch { balanceUnavailable = true; }
  }
  return { connected: true, kind: 'nwc', network: normalizeNetwork(info.network), capabilities: info.methods, ...(info.alias ? { alias: info.alias.slice(0, 80) } : {}), practice: normalizeNetwork(info.network) === 'regtest', ...(balanceSats !== undefined ? { balanceSats } : {}), ...(balanceUnavailable ? { balanceUnavailable: true } : {}) };
}
async function withWallet<T>(ctx: ActionCtx, args: Args, operation: (wallet: NwcWallet, connection: Doc<'chatWalletConnections'>, info: WalletInfo) => Promise<T>, expected?: { version?: string; fingerprint?: string }) {
  const context = await ctx.runQuery(internal.chatModel.walletContext, auth(args));
  const connection = context.connection;
  if (!connection) fail(409, 'WALLET_REQUIRED', 'Connect your Lightning wallet first.');
  if (expected?.version && connection.version !== expected.version || expected?.fingerprint && connection.connectionFingerprint !== expected.fingerprint) fail(409, 'WALLET_CHANGED', 'Reconnect the original wallet, or review the payment using your new connection.');
  const uri = openConnection(connection.sealedUri, context.pubkey);
  await allowedConnection(uri);
  await ctx.runQuery(internal.chatModel.assertWallet, { ...auth(args), connectionVersion: connection.version, walletFingerprint: connection.connectionFingerprint });
  const wallet = new NwcWallet(uri);
  try {
    const info = await wallet.getInfo(); matchesConnection(info, connection);
    await ctx.runQuery(internal.chatModel.assertWallet, { ...auth(args), connectionVersion: connection.version, walletFingerprint: connection.connectionFingerprint });
    return await operation(wallet, connection, info);
  } finally { wallet.close(); }
}

async function route(ctx: ActionCtx, args: Args): Promise<HttpResult> {
  const parts = args.path.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'chat' || parts.some(part => part.includes('%'))) fail(404, 'NOT_FOUND', 'Chat endpoint not found.');
  const method = args.method;
  if (parts[2] === 'account' && parts.length === 3) {
    if (method === 'GET') return response(await ctx.runQuery(internal.chatModel.account, auth(args)));
    if (method === 'POST') return response(await ctx.runMutation(internal.chatModel.saveAccount, { ...auth(args), input: args.body }));
  }
  if (parts[2] === 'history' && parts.length === 3) {
    if (method === 'GET') return response(await ctx.runQuery(internal.chatModel.history, { ...auth(args), ...chatPage(args.query?.cursor, args.query?.limit) }));
    if (method === 'POST') return response(await ctx.runMutation(internal.chatModel.saveHistory, { ...auth(args), input: args.body }));
    if (method === 'DELETE') return response(await ctx.runMutation(internal.chatModel.clearHistory, { ...auth(args), input: args.body }));
  }
  if (parts[2] === 'outbox') {
    if (parts.length === 3 && method === 'GET') return response(await ctx.runQuery(internal.chatModel.outbox, { ...auth(args), ...chatPage(args.query?.cursor, args.query?.limit) }));
    if (parts.length === 3 && method === 'POST') return response(await ctx.runMutation(internal.chatModel.saveOutbox, { ...auth(args), input: args.body }));
    if (parts.length === 4 && method === 'DELETE') return response(await ctx.runMutation(internal.chatModel.deleteOutbox, { ...auth(args), id: parts[3], input: args.body }));
  }
  if (parts[2] === 'wallet') {
    if (parts.length === 3 && method === 'GET') {
      const context = await ctx.runQuery(internal.chatModel.walletContext, auth(args));
      if (!context.connection) return response({ connected: false, capabilities: [] });
      try {
        return response(await withWallet(ctx, args, async (wallet, connection, info) => {
          const result = await status(wallet, info);
          await ctx.runQuery(internal.chatModel.assertWallet, { ...auth(args), connectionVersion: connection.version, walletFingerprint: connection.connectionFingerprint });
          return result;
        }));
      } catch (error) {
        await assertOwner(ctx, args);
        const current = await ctx.runQuery(internal.chatModel.walletContext, auth(args));
        if (!current.connection || current.connection.version !== context.connection.version) fail(409, 'WALLET_CHANGED', 'Your wallet changed during the status check. Refresh to see the current connection.');
        return response({ connected: true, capabilities: [], error: 'Your wallet is offline. Keep it online and check its connection permissions.' });
      }
    }
    if (parts[3] === 'connect' && parts.length === 4 && method === 'POST') {
      const input = parse(z.object({ sealedUri: z.string().min(50).max(9000) }).strict(), args.body);
      const uri = openConnection(input.sealedUri, args.expectedPubkey);
      const inspected = await allowedConnection(uri);
      const wallet = new NwcWallet(uri);
      try {
        const info = await wallet.getInfo();
        if (!info.connectionFingerprint || !info.methods.includes('lookup_invoice')) fail(409, 'LOOKUP_PERMISSION', 'Create a wallet connection with invoice lookup permission so payment results can be verified.');
        await ctx.runMutation(internal.chatModel.saveConnection, { ...auth(args), sealedUri: input.sealedUri, version: digestHex(input.sealedUri), walletPubkey: inspected.walletPubkey, connectionFingerprint: info.connectionFingerprint, network: info.network });
        const result = await status(wallet, info);
        await ctx.runQuery(internal.chatModel.assertWallet, { ...auth(args), connectionVersion: digestHex(input.sealedUri), walletFingerprint: info.connectionFingerprint });
        return response(result);
      } finally { wallet.close(); }
    }
    if (parts.length === 3 && method === 'DELETE') return response(await ctx.runMutation(internal.chatModel.disconnect, auth(args)));
    if (parts[3] === 'invoices' && parts.length === 4 && method === 'POST') {
      const input = parse(z.object({ amountSats: z.number().int().min(1).max(1_000_000), description: z.string().max(240).default('NostrChat payment') }).strict(), args.body);
      return response(await withWallet(ctx, args, async (wallet, connection) => {
        const invoice = await wallet.makeInvoice(input);
        if (invoice.amountSats !== input.amountSats) fail(502, 'INVOICE_MISMATCH', 'The receiving wallet returned a different amount than requested.');
        return ctx.runMutation(internal.chatModel.recordInvoice, { ...auth(args), invoice, walletFingerprint: connection.connectionFingerprint, connectionVersion: connection.version });
      }), 201);
    }
    if (parts[3] === 'invoices' && parts.length === 5 && method === 'GET') {
      const paymentHash = parse(z.string().regex(/^[a-f0-9]{64}$/), parts[4]);
      const stored = await ctx.runQuery(internal.chatModel.invoice, { ...auth(args), paymentHash });
      if (!stored) fail(404, 'INVOICE_NOT_FOUND', 'This account did not create that payment request.');
      if (stored.state === 'settled') return response(await ctx.runQuery(internal.chatModel.invoiceReceipt, { ...auth(args), paymentHash }));
      return response(await withWallet(ctx, args, async (wallet, connection) => {
        const verified = await wallet.lookupInvoice(paymentHash);
        return ctx.runMutation(internal.chatModel.verifyInvoice, { ...auth(args), verified, walletFingerprint: connection.connectionFingerprint, connectionVersion: connection.version });
      }, { fingerprint: stored.walletFingerprint }));
    }
  }
  if (parts[2] === 'payments') {
    if (parts[3] === 'preview' && parts.length === 4 && method === 'POST') {
      const input = parse(z.object({ bolt11: z.string().min(50).max(12_000) }).strict(), args.body);
      const invoice = signedBolt11(input.bolt11); paymentLimit(invoice.amountSats);
      if (invoice.expiresAt <= Date.now()) fail(422, 'INVOICE_EXPIRED', 'This invoice has expired. Ask for a new one.');
      return response(await withWallet(ctx, args, async (_wallet, connection, info) => {
        if (!info.methods.includes('pay_invoice') || !info.methods.includes('lookup_invoice')) fail(409, 'PAYMENT_PERMISSION', 'Your wallet needs capped payment and invoice lookup permissions.');
        return ctx.runMutation(internal.chatModel.createReview, { ...auth(args), reviewId: randomUUID(), bolt11: invoice.bolt11, walletFingerprint: connection.connectionFingerprint, connectionVersion: connection.version, ...(info.alias ? { alias: info.alias } : {}) });
      }));
    }
    if (parts.length === 3 && method === 'POST') {
      const input = parse(z.object({ reviewId: z.string().uuid(), confirmed: z.literal(true) }).strict(), args.body);
      const review = await ctx.runQuery(internal.chatModel.review, { ...auth(args), reviewId: input.reviewId });
      const previous = await ctx.runQuery(internal.chatModel.payment, { ...auth(args), paymentHash: review.paymentHash });
      if (previous) return response(await ctx.runQuery(internal.chatModel.paymentReceipt, { ...auth(args), paymentHash: review.paymentHash }));
      if (review.reviewExpiresAt <= Date.now() || review.expiresAt <= Date.now()) fail(422, 'REVIEW_EXPIRED', 'The review has expired. Review the invoice again.');
      paymentLimit(review.amountSats);
      return withWallet(ctx, args, async (wallet, connection, info) => {
        if (!info.methods.includes('pay_invoice') || !info.methods.includes('lookup_invoice')) fail(409, 'PAYMENT_PERMISSION', 'Your wallet needs capped payment and invoice lookup permissions.');
        const attemptId = randomUUID();
        const claim = await ctx.runMutation(internal.chatModel.claimPayment, { ...auth(args), reviewId: review.reviewId, attemptId, walletFingerprint: connection.connectionFingerprint, connectionVersion: connection.version });
        if (claim.existing) return response(claim.existing);
        try {
          const paid = await wallet.payInvoice(review.bolt11);
          return response(await ctx.runMutation(internal.chatModel.settlePayment, { id: claim.id, attemptId, paymentHash: paid.paymentHash, preimage: paid.preimage, walletFingerprint: connection.connectionFingerprint, now: Date.now() }));
        } catch {
          return response(await ctx.runMutation(internal.chatModel.markPaymentUnknown, { id: claim.id, attemptId }));
        }
      }, { version: review.connectionVersion, fingerprint: review.walletFingerprint });
    }
    if (parts.length === 4 && method === 'GET') {
      const paymentHash = parse(z.string().regex(/^[a-f0-9]{64}$/), parts[3]);
      const item = await ctx.runQuery(internal.chatModel.payment, { ...auth(args), paymentHash });
      if (!item || item.state === 'settled') return response(await ctx.runQuery(internal.chatModel.paymentReceipt, { ...auth(args), paymentHash }));
      try {
        return await withWallet(ctx, args, async (wallet, connection) => {
          const verified = await wallet.lookupInvoice(paymentHash).catch(() => null);
          if (verified?.state === 'settled' && verified.preimage && proofMatches(paymentHash, verified.preimage) && verified.bolt11 === item.bolt11 && verified.amountSats === item.amountSats) {
            return response(await ctx.runMutation(internal.chatModel.settlePayment, { id: item._id, attemptId: item.attemptId, paymentHash, preimage: verified.preimage, walletFingerprint: connection.connectionFingerprint, now: Date.now() }));
          }
          return response(await ctx.runQuery(internal.chatModel.paymentReceipt, { ...auth(args), paymentHash }));
        }, { fingerprint: item.walletFingerprint });
      } catch {
        await assertOwner(ctx, args);
        const receipt = await ctx.runQuery(internal.chatModel.paymentReceipt, { ...auth(args), paymentHash });
        return response(receipt.state === 'settled' ? receipt : { ...receipt, message: 'The result is still uncertain. Reconnect the original wallet and check its transaction history; no repeat payment was sent.' });
      }
    }
  }
  fail(404, 'NOT_FOUND', 'Chat endpoint not found.');
}

export const dispatch = internalAction({
  args: { tokenHash: v.string(), expectedPubkey: v.string(), method: v.string(), path: v.string(), body: v.any(), query: v.optional(v.record(v.string(), v.string())) },
  handler: async (ctx, args): Promise<HttpResult> => {
    try {
      await assertOwner(ctx, args);
      const result = await route(ctx, args);
      await assertOwner(ctx, args);
      return result;
    } catch (error) {
      if (error instanceof GateError) return response({ code: error.code, error: error.message, message: error.message }, error.status);
      return cleanError(error);
    }
  }
});
