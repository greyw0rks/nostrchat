import type { InvoicePayload } from "./protocol";

export type WalletState = {
  connected: boolean;
  kind?: string;
  capabilities?: string[];
  balanceSats?: number;
  error?: string;
};
export type VerifiedInvoice = {
  paymentHash: string;
  bolt11: string;
  amountSats: number;
  description: string;
  expiresAt: number;
  state: "pending" | "settled" | "expired";
  preimage?: string;
  settledAt?: number;
};
export type InvoiceStatus = {
  state: "settled" | "pending" | "expired";
  source: "wallet" | "proof";
  settledAt?: number;
  preimage?: string;
};
export type AccountRequest = <T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
) => Promise<T>;
export type PaymentReview = {
  owner: string;
  peer: string | null;
  invoiceId: string | null;
  invoice: InvoicePayload;
  attempted: boolean;
  attemptedAt?: number;
  preimage?: string;
};
