import { defineTable } from 'convex/server';
import { v } from 'convex/values';

const invoiceState = v.union(v.literal('pending'), v.literal('settled'), v.literal('expired'));

// Chat never reuses company treasury or Academy credentials, receipts, or preferences.
export const chatTables = {
  chatAccounts: defineTable({ pubkey: v.string(), ciphertext: v.string(), revision: v.number(), updatedAt: v.number() }).index('by_pubkey', ['pubkey']),
  chatUsage: defineTable({ pubkey: v.string(), historyBytes: v.number(), historyCount: v.number(), outboxBytes: v.number(), outboxCount: v.number() }).index('by_pubkey', ['pubkey']),
  chatHistory: defineTable({ pubkey: v.string(), eventId: v.string(), event: v.any(), bytes: v.number(), createdAt: v.number() }).index('by_user_event', ['pubkey', 'eventId']).index('by_user_time', ['pubkey', 'createdAt']),
  chatOutbox: defineTable({ pubkey: v.string(), id: v.string(), ciphertext: v.string(), state: v.union(v.literal('queued'), v.literal('published')), createdAt: v.number(), updatedAt: v.number() }).index('by_user_id', ['pubkey', 'id']).index('by_user_time', ['pubkey', 'createdAt']),
  chatWalletConnections: defineTable({ pubkey: v.string(), sealedUri: v.string(), version: v.string(), walletPubkey: v.string(), connectionFingerprint: v.string(), network: v.string(), updatedAt: v.number() }).index('by_pubkey', ['pubkey']),
  chatWalletInvoices: defineTable({ pubkey: v.string(), paymentHash: v.string(), bolt11: v.string(), amountSats: v.number(), description: v.string(), state: invoiceState, expiresAt: v.number(), createdAt: v.number(), walletFingerprint: v.string(), preimage: v.optional(v.string()), settledAt: v.optional(v.number()) }).index('by_hash', ['paymentHash']).index('by_user_hash', ['pubkey', 'paymentHash']),
  chatPaymentReviews: defineTable({ pubkey: v.string(), reviewId: v.string(), bolt11: v.string(), paymentHash: v.string(), amountSats: v.number(), network: v.string(), expiresAt: v.number(), reviewExpiresAt: v.number(), walletFingerprint: v.string(), connectionVersion: v.string(), walletPubkey: v.string(), alias: v.optional(v.string()), createdAt: v.number() }).index('by_review', ['reviewId']).index('by_user_time', ['pubkey', 'createdAt']).index('by_expiry', ['reviewExpiresAt']),
  chatPayments: defineTable({ pubkey: v.string(), paymentHash: v.string(), bolt11: v.string(), amountSats: v.number(), state: v.union(v.literal('paying'), v.literal('unknown'), v.literal('settled')), reviewId: v.string(), attemptId: v.string(), walletFingerprint: v.string(), connectionVersion: v.string(), createdAt: v.number(), preimage: v.optional(v.string()), settledAt: v.optional(v.number()) }).index('by_hash', ['paymentHash']).index('by_user_hash', ['pubkey', 'paymentHash'])
};
