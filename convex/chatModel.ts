import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import { z } from 'zod';
import { userFor } from './model';
import { expectedHash, fail, proofMatches } from './lib';
import { GateError, type WalletInvoice } from '../packages/nwc-gate/src/types';
import { signedBolt11 } from '../packages/chat/src/invoice';
import { CHAT_CACHE_BYTES, CHAT_CACHE_COUNT, CHAT_OUTBOX_COUNT, chatCiphertext, chatEnvelope, chatPage, normalizeNetwork } from '../packages/chat/src/validation';

type ReadCtx = QueryCtx | MutationCtx;
const authArgs = { tokenHash: v.string(), expectedPubkey: v.string(), now: v.number() };
type Auth = { tokenHash: string; expectedPubkey: string; now: number };
function checked<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof GateError) fail(error.status, error.code, error.message);
    throw error;
  }
}
function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) fail(422, 'INVALID_INPUT', 'Check the submitted fields and try again.');
  return result.data;
}
export async function chatUser(ctx: ReadCtx, args: Auth) {
  const user = await userFor(ctx, args.tokenHash, args.now);
  if (!/^[a-f0-9]{64}$/.test(args.expectedPubkey) || user.pubkey !== args.expectedPubkey) fail(409, 'IDENTITY_CHANGED', 'Your signed-in identity changed. Reconnect the account you are using.');
  return user;
}
async function connectionFor(ctx: ReadCtx, pubkey: string) {
  return ctx.db.query('chatWalletConnections').withIndex('by_pubkey', q => q.eq('pubkey', pubkey)).unique();
}
async function assertConnection(ctx: ReadCtx, pubkey: string, version: string, fingerprint: string) {
  const connection = await connectionFor(ctx, pubkey);
  if (!connection || connection.version !== version || connection.connectionFingerprint !== fingerprint) fail(409, 'WALLET_CHANGED', 'Your wallet connection changed. Review the payment or invoice again.');
  return connection;
}
async function usageFor(ctx: MutationCtx, pubkey: string) {
  let row = await ctx.db.query('chatUsage').withIndex('by_pubkey', q => q.eq('pubkey', pubkey)).unique();
  if (!row) {
    const id = await ctx.db.insert('chatUsage', { pubkey, historyBytes: 0, historyCount: 0, outboxBytes: 0, outboxCount: 0 });
    row = await ctx.db.get(id);
  }
  return row!;
}
const invoiceValue = v.object({ paymentHash: v.string(), bolt11: v.string(), amountSats: v.number(), description: v.string(), expiresAt: v.number(), state: v.union(v.literal('pending'), v.literal('settled'), v.literal('expired')), preimage: v.optional(v.string()), settledAt: v.optional(v.number()) });
function invoiceShape(item: Doc<'chatWalletInvoices'>): WalletInvoice {
  if (item.state === 'settled' && (!item.preimage || !proofMatches(item.paymentHash, item.preimage) || !Number.isSafeInteger(item.settledAt))) fail(409, 'UNVERIFIED_PROOF', 'The stored invoice has no verifiable settlement proof.');
  return { paymentHash: item.paymentHash, bolt11: item.bolt11, amountSats: item.amountSats, description: item.description, expiresAt: item.expiresAt, state: item.state, ...(item.preimage ? { preimage: item.preimage } : {}), ...(item.settledAt !== undefined ? { settledAt: item.settledAt } : {}) };
}
export function paymentShape(item: Doc<'chatPayments'>) {
  if (item.state === 'settled') {
    if (!item.preimage || !proofMatches(item.paymentHash, item.preimage) || !Number.isSafeInteger(item.settledAt)) fail(409, 'UNVERIFIED_PROOF', 'The stored payment has no verifiable settlement proof.');
    return { paymentHash: item.paymentHash, amountSats: item.amountSats, state: 'settled' as const, preimage: item.preimage, settledAt: item.settledAt! };
  }
  return { paymentHash: item.paymentHash, amountSats: item.amountSats, state: 'unknown' as const, message: 'A payment attempt is recorded. Check its status; do not send the same invoice again.' };
}
function reviewShape(item: Doc<'chatPaymentReviews'>) {
  return { reviewId: item.reviewId, paymentHash: item.paymentHash, amountSats: item.amountSats, network: item.network, expiresAt: item.expiresAt, reviewExpiresAt: item.reviewExpiresAt, wallet: { kind: 'nwc', network: item.network, ...(item.alias ? { alias: item.alias } : {}) }, walletReference: item.walletFingerprint };
}

export const account = internalQuery({ args: authArgs, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const row = await ctx.db.query('chatAccounts').withIndex('by_pubkey', q => q.eq('pubkey', user.pubkey)).unique();
  return { pubkey: user.pubkey, ciphertext: row?.ciphertext ?? null, revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null };
} });
export const saveAccount = internalMutation({ args: { ...authArgs, input: v.any() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const input = parse(z.object({ ciphertext: z.string(), expectedRevision: z.number().int().nonnegative() }).strict(), args.input);
  const ciphertext = checked(() => chatCiphertext(input.ciphertext));
  const row = await ctx.db.query('chatAccounts').withIndex('by_pubkey', q => q.eq('pubkey', user.pubkey)).unique();
  if ((row?.revision ?? 0) !== input.expectedRevision) fail(409, 'REVISION_CONFLICT', 'Your account was updated in another tab. Refresh before saving.');
  const data = { pubkey: user.pubkey, ciphertext, revision: input.expectedRevision + 1, updatedAt: args.now };
  if (row) await ctx.db.replace(row._id, data); else await ctx.db.insert('chatAccounts', data);
  return data;
} });
export const history = internalQuery({ args: { ...authArgs, cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const page = checked(() => chatPage(args.cursor, args.limit));
  const result = await ctx.db.query('chatHistory').withIndex('by_user_time', q => q.eq('pubkey', user.pubkey)).order('desc').paginate({ cursor: page.cursor, numItems: page.limit });
  return { events: result.page.map(row => row.event), cursor: result.isDone ? null : result.continueCursor, hasMore: !result.isDone };
} });
export const saveHistory = internalMutation({ args: { ...authArgs, input: v.any() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const input = parse(z.object({ event: z.unknown() }).strict(), args.input);
  const event = checked(() => chatEnvelope(input.event, user.pubkey, args.now));
  const previous = await ctx.db.query('chatHistory').withIndex('by_user_event', q => q.eq('pubkey', user.pubkey).eq('eventId', event.id)).unique();
  if (previous) return { saved: true, duplicate: true };
  const usage = await usageFor(ctx, user.pubkey);
  const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
  if (usage.historyCount >= CHAT_CACHE_COUNT || usage.historyBytes + bytes > CHAT_CACHE_BYTES) fail(413, 'CACHE_FULL', 'Your encrypted cloud cache is full. Clear the cache in Settings to save more envelopes.');
  await ctx.db.insert('chatHistory', { pubkey: user.pubkey, eventId: event.id, event, bytes, createdAt: args.now });
  await ctx.db.patch(usage._id, { historyCount: usage.historyCount + 1, historyBytes: usage.historyBytes + bytes });
  return { saved: true, duplicate: false };
} });
export const clearHistory = internalMutation({ args: { ...authArgs, input: v.any() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  parse(z.object({ confirmed: z.literal(true) }).strict(), args.input);
  const rows = await ctx.db.query('chatHistory').withIndex('by_user_time', q => q.eq('pubkey', user.pubkey)).collect();
  for (const row of rows) await ctx.db.delete(row._id);
  const usage = await usageFor(ctx, user.pubkey);
  await ctx.db.patch(usage._id, { historyCount: 0, historyBytes: 0 });
  return { cleared: true, count: rows.length };
} });
export const outbox = internalQuery({ args: { ...authArgs, cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const page = checked(() => chatPage(args.cursor, args.limit));
  const result = await ctx.db.query('chatOutbox').withIndex('by_user_time', q => q.eq('pubkey', user.pubkey)).order('asc').paginate({ cursor: page.cursor, numItems: page.limit });
  return { items: result.page.map(row => ({ id: row.id, ciphertext: row.ciphertext, state: row.state, updatedAt: row.updatedAt })), cursor: result.isDone ? null : result.continueCursor, hasMore: !result.isDone };
} });
export const saveOutbox = internalMutation({ args: { ...authArgs, input: v.any() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const input = parse(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), ciphertext: z.string(), state: z.enum(['queued', 'published']) }).strict(), args.input);
  const ciphertext = checked(() => chatCiphertext(input.ciphertext));
  const previous = await ctx.db.query('chatOutbox').withIndex('by_user_id', q => q.eq('pubkey', user.pubkey).eq('id', input.id)).unique();
  if (previous) {
    if (previous.ciphertext !== ciphertext) fail(409, 'OUTBOX_CONFLICT', 'A different encrypted message already uses this outbox reference.');
    if (previous.state !== 'published' && input.state === 'published') await ctx.db.patch(previous._id, { state: 'published', updatedAt: args.now });
    return { id: previous.id, ciphertext, state: previous.state === 'published' || input.state === 'published' ? 'published' : 'queued', updatedAt: previous.state === input.state || previous.state === 'published' ? previous.updatedAt : args.now };
  }
  const usage = await usageFor(ctx, user.pubkey);
  if (usage.outboxCount >= CHAT_OUTBOX_COUNT || usage.outboxBytes + ciphertext.length > CHAT_CACHE_BYTES) fail(413, 'OUTBOX_FULL', 'Your encrypted outbox is full. Remove published items before adding another message.');
  await ctx.db.insert('chatOutbox', { pubkey: user.pubkey, ...input, ciphertext, createdAt: args.now, updatedAt: args.now });
  await ctx.db.patch(usage._id, { outboxCount: usage.outboxCount + 1, outboxBytes: usage.outboxBytes + ciphertext.length });
  return { ...input, ciphertext, updatedAt: args.now };
} });
export const deleteOutbox = internalMutation({ args: { ...authArgs, id: v.string(), input: v.any() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args); expectedHash(args.id);
  parse(z.object({ confirmed: z.literal(true) }).strict(), args.input);
  const row = await ctx.db.query('chatOutbox').withIndex('by_user_id', q => q.eq('pubkey', user.pubkey).eq('id', args.id)).unique();
  if (row) {
    await ctx.db.delete(row._id);
    const usage = await usageFor(ctx, user.pubkey);
    await ctx.db.patch(usage._id, { outboxCount: Math.max(0, usage.outboxCount - 1), outboxBytes: Math.max(0, usage.outboxBytes - row.ciphertext.length) });
  }
  return { deleted: true };
} });

export const walletContext = internalQuery({ args: authArgs, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  return { pubkey: user.pubkey, connection: await connectionFor(ctx, user.pubkey) };
} });
export const assertWallet = internalQuery({ args: { ...authArgs, connectionVersion: v.string(), walletFingerprint: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  await assertConnection(ctx, user.pubkey, args.connectionVersion, args.walletFingerprint);
  return { current: true };
} });
export const saveConnection = internalMutation({ args: { ...authArgs, sealedUri: v.string(), version: v.string(), walletPubkey: v.string(), connectionFingerprint: v.string(), network: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  expectedHash(args.version); expectedHash(args.walletPubkey); expectedHash(args.connectionFingerprint);
  if (args.sealedUri.length < 50 || args.sealedUri.length > 9000 || !['bitcoin', 'testnet', 'signet', 'regtest', 'simnet'].includes(normalizeNetwork(args.network))) fail(422, 'INVALID_CONNECTION', 'The encrypted wallet connection or network is invalid.');
  const previous = await connectionFor(ctx, user.pubkey);
  const data = { pubkey: user.pubkey, sealedUri: args.sealedUri, version: args.version, walletPubkey: args.walletPubkey, connectionFingerprint: args.connectionFingerprint, network: normalizeNetwork(args.network), updatedAt: args.now };
  if (previous) await ctx.db.replace(previous._id, data); else await ctx.db.insert('chatWalletConnections', data);
  return { saved: true };
} });
export const disconnect = internalMutation({ args: authArgs, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const connection = await connectionFor(ctx, user.pubkey);
  if (connection) await ctx.db.delete(connection._id);
  return { connected: false };
} });
export const recordInvoice = internalMutation({ args: { ...authArgs, invoice: invoiceValue, walletFingerprint: v.string(), connectionVersion: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const connection = await assertConnection(ctx, user.pubkey, args.connectionVersion, args.walletFingerprint);
  const parsed = checked(() => signedBolt11(args.invoice.bolt11));
  if (parsed.paymentHash !== args.invoice.paymentHash || parsed.amountSats !== args.invoice.amountSats || parsed.expiresAt !== args.invoice.expiresAt || parsed.network !== connection.network || args.invoice.state !== 'pending' || args.invoice.expiresAt <= args.now || args.invoice.preimage || args.invoice.settledAt !== undefined) fail(502, 'INVOICE_MISMATCH', 'The receiving wallet returned an unexpected invoice.');
  const previous = await ctx.db.query('chatWalletInvoices').withIndex('by_hash', q => q.eq('paymentHash', parsed.paymentHash)).unique();
  if (previous) fail(409, 'DUPLICATE_INVOICE', 'This invoice already exists. Create another payment request.');
  const data = { pubkey: user.pubkey, paymentHash: parsed.paymentHash, bolt11: parsed.bolt11, amountSats: parsed.amountSats, description: args.invoice.description.slice(0, 240), state: 'pending' as const, expiresAt: parsed.expiresAt, createdAt: args.now, walletFingerprint: args.walletFingerprint };
  await ctx.db.insert('chatWalletInvoices', data);
  return { ...args.invoice, bolt11: parsed.bolt11 };
} });
export const invoice = internalQuery({ args: { ...authArgs, paymentHash: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args); expectedHash(args.paymentHash);
  return ctx.db.query('chatWalletInvoices').withIndex('by_user_hash', q => q.eq('pubkey', user.pubkey).eq('paymentHash', args.paymentHash)).unique();
} });
export const invoiceReceipt = internalQuery({ args: { ...authArgs, paymentHash: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args); expectedHash(args.paymentHash);
  const item = await ctx.db.query('chatWalletInvoices').withIndex('by_user_hash', q => q.eq('pubkey', user.pubkey).eq('paymentHash', args.paymentHash)).unique();
  if (!item) fail(404, 'INVOICE_NOT_FOUND', 'This account did not create that payment request.');
  return invoiceShape(item);
} });
export const verifyInvoice = internalMutation({ args: { ...authArgs, verified: invoiceValue, walletFingerprint: v.string(), connectionVersion: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const item = await ctx.db.query('chatWalletInvoices').withIndex('by_user_hash', q => q.eq('pubkey', user.pubkey).eq('paymentHash', args.verified.paymentHash)).unique();
  if (!item) fail(404, 'INVOICE_NOT_FOUND', 'This account did not create that payment request.');
  if (item.state === 'settled') return invoiceShape(item);
  await assertConnection(ctx, user.pubkey, args.connectionVersion, args.walletFingerprint);
  if (item.walletFingerprint !== args.walletFingerprint || item.bolt11 !== args.verified.bolt11 || item.amountSats !== args.verified.amountSats || item.expiresAt !== args.verified.expiresAt) fail(409, 'PROOF_MISMATCH', 'The wallet returned different invoice details.');
  const verified = args.verified;
  if (verified.state === 'settled') {
    if (!verified.preimage || !proofMatches(item.paymentHash, verified.preimage) || verified.settledAt !== undefined && (!Number.isSafeInteger(verified.settledAt) || verified.settledAt < item.createdAt - 1000 || verified.settledAt > args.now + 1000)) fail(409, 'UNVERIFIED_PROOF', 'The wallet has not supplied verifiable settlement proof.');
    const settledAt = Math.min(verified.settledAt ?? args.now, args.now);
    await ctx.db.patch(item._id, { state: 'settled', preimage: verified.preimage, settledAt });
    return invoiceShape({ ...item, state: 'settled', preimage: verified.preimage, settledAt });
  }
  const state = item.expiresAt <= args.now ? 'expired' as const : 'pending' as const;
  if (item.state !== state) await ctx.db.patch(item._id, { state });
  return invoiceShape({ ...item, state });
} });

export const createReview = internalMutation({ args: { ...authArgs, reviewId: v.string(), bolt11: v.string(), walletFingerprint: v.string(), connectionVersion: v.string(), alias: v.optional(v.string()) }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const connection = await assertConnection(ctx, user.pubkey, args.connectionVersion, args.walletFingerprint);
  const invoice = checked(() => signedBolt11(args.bolt11));
  if (invoice.expiresAt <= args.now) fail(422, 'INVOICE_EXPIRED', 'This invoice has expired. Ask for a new one.');
  if (invoice.network !== connection.network) fail(422, 'WRONG_NETWORK', 'The invoice and wallet use different Bitcoin networks.');
  if (!/^[a-f0-9-]{36}$/.test(args.reviewId)) fail(422, 'INVALID_REVIEW', 'This payment review reference is invalid.');
  if (await ctx.db.query('chatPaymentReviews').withIndex('by_review', q => q.eq('reviewId', args.reviewId)).unique()) fail(409, 'DUPLICATE_REVIEW', 'This review reference already belongs to another immutable payment review.');
  const recent = await ctx.db.query('chatPaymentReviews').withIndex('by_user_time', q => q.eq('pubkey', user.pubkey)).take(65);
  let retained = 0;
  for (const item of recent) {
    if (item.reviewExpiresAt < args.now - 300_000) await ctx.db.delete(item._id);
    else retained++;
  }
  if (retained >= 64) fail(429, 'REVIEW_LIMIT', 'Too many payment reviews are open. Wait a few minutes before reviewing another invoice.');
  const data = { pubkey: user.pubkey, reviewId: args.reviewId, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: invoice.amountSats, network: invoice.network, expiresAt: invoice.expiresAt, reviewExpiresAt: Math.min(invoice.expiresAt, args.now + 90_000), walletFingerprint: args.walletFingerprint, connectionVersion: args.connectionVersion, walletPubkey: connection.walletPubkey, ...(args.alias ? { alias: args.alias.slice(0, 80) } : {}), createdAt: args.now };
  const id = await ctx.db.insert('chatPaymentReviews', data);
  return reviewShape({ ...data, _id: id, _creationTime: args.now });
} });
export const review = internalQuery({ args: { ...authArgs, reviewId: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const item = await ctx.db.query('chatPaymentReviews').withIndex('by_review', q => q.eq('reviewId', args.reviewId)).unique();
  if (!item || item.pubkey !== user.pubkey) fail(404, 'REVIEW_NOT_FOUND', 'This payment review is unavailable. Review the invoice again.');
  return item;
} });
export const payment = internalQuery({ args: { ...authArgs, paymentHash: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args); expectedHash(args.paymentHash);
  return ctx.db.query('chatPayments').withIndex('by_user_hash', q => q.eq('pubkey', user.pubkey).eq('paymentHash', args.paymentHash)).unique();
} });
export const paymentReceipt = internalQuery({ args: { ...authArgs, paymentHash: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args); expectedHash(args.paymentHash);
  const item = await ctx.db.query('chatPayments').withIndex('by_user_hash', q => q.eq('pubkey', user.pubkey).eq('paymentHash', args.paymentHash)).unique();
  return item ? paymentShape(item) : { paymentHash: args.paymentHash, state: 'not_found' as const };
} });
export const claimPayment = internalMutation({ args: { ...authArgs, reviewId: v.string(), attemptId: v.string(), walletFingerprint: v.string(), connectionVersion: v.string() }, handler: async (ctx, args) => {
  const user = await chatUser(ctx, args);
  const review = await ctx.db.query('chatPaymentReviews').withIndex('by_review', q => q.eq('reviewId', args.reviewId)).unique();
  if (!review || review.pubkey !== user.pubkey) fail(404, 'REVIEW_NOT_FOUND', 'This payment review is unavailable. Review the invoice again.');
  const previous = await ctx.db.query('chatPayments').withIndex('by_hash', q => q.eq('paymentHash', review.paymentHash)).unique();
  if (previous) {
    if (previous.pubkey !== user.pubkey) fail(409, 'PAYMENT_ALREADY_REQUESTED', 'This invoice already has a recorded payment attempt.');
    return { id: previous._id, existing: paymentShape(previous) };
  }
  if (review.reviewExpiresAt <= args.now || review.expiresAt <= args.now) fail(422, 'REVIEW_EXPIRED', 'Your payment review has expired. Review the invoice again.');
  const connection = await assertConnection(ctx, user.pubkey, args.connectionVersion, args.walletFingerprint);
  if (review.connectionVersion !== connection.version || review.walletFingerprint !== connection.connectionFingerprint || review.walletPubkey !== connection.walletPubkey || review.network !== connection.network) fail(409, 'WALLET_CHANGED', 'Your wallet changed after the payment review. Review the invoice again.');
  const invoice = checked(() => signedBolt11(review.bolt11));
  if (invoice.paymentHash !== review.paymentHash || invoice.amountSats !== review.amountSats || invoice.expiresAt !== review.expiresAt) fail(422, 'INVALID_REVIEW', 'The invoice no longer matches this review.');
  if (await ctx.db.query('expenses').withIndex('by_hash', q => q.eq('paymentHash', review.paymentHash)).unique()) fail(409, 'USE_APPROVAL_FLOW', 'This invoice belongs to a company expense. Use the independent approval workflow.');
  if (await ctx.db.query('walletPayments').withIndex('by_hash', q => q.eq('paymentHash', review.paymentHash)).unique()) fail(409, 'PAYMENT_ALREADY_REQUESTED', 'This invoice already has a recorded payment attempt.');
  const id = await ctx.db.insert('chatPayments', { pubkey: user.pubkey, paymentHash: review.paymentHash, bolt11: review.bolt11, amountSats: review.amountSats, state: 'paying', reviewId: review.reviewId, attemptId: args.attemptId, walletFingerprint: connection.connectionFingerprint, connectionVersion: connection.version, createdAt: args.now });
  return { id, existing: null };
} });
export const markPaymentUnknown = internalMutation({ args: { id: v.id('chatPayments'), attemptId: v.string() }, handler: async (ctx, args) => {
  const item = await ctx.db.get(args.id);
  if (!item || item.attemptId !== args.attemptId) fail(409, 'ATTEMPT_MISMATCH', 'This payment attempt could not be identified.');
  if (item.state === 'paying') await ctx.db.patch(item._id, { state: 'unknown' });
  return paymentShape(item.state === 'paying' ? { ...item, state: 'unknown' } : item);
} });
export const settlePayment = internalMutation({ args: { id: v.id('chatPayments'), attemptId: v.string(), paymentHash: v.string(), preimage: v.string(), walletFingerprint: v.string(), now: v.number() }, handler: async (ctx, args) => {
  const item = await ctx.db.get(args.id);
  if (!item || item.attemptId !== args.attemptId || item.paymentHash !== args.paymentHash || item.walletFingerprint !== args.walletFingerprint || !proofMatches(item.paymentHash, args.preimage)) fail(409, 'UNVERIFIED_PROOF', 'The wallet has not supplied verifiable settlement proof for this payment.');
  if (item.state === 'settled') return paymentShape(item);
  const settledAt = args.now;
  await ctx.db.patch(item._id, { state: 'settled', preimage: args.preimage, settledAt });
  return paymentShape({ ...item, state: 'settled', preimage: args.preimage, settledAt });
} });

export const cleanupReviews = internalMutation({ args: {}, handler: async ctx => {
  const expired = await ctx.db.query('chatPaymentReviews').withIndex('by_expiry', q => q.lt('reviewExpiresAt', Date.now() - 300_000)).take(128);
  for (const item of expired) await ctx.db.delete(item._id);
  // Financial attempts, including unresolved ones, are deliberately retained.
  return { removed: expired.length };
} });
