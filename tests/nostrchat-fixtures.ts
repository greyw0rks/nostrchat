import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { finalizeEvent, getEventHash, type EventTemplate, type NostrEvent } from 'nostr-tools';
import { createPracticeIdentity, destroyIdentity, type Identity, type InvoicePayload, type Rumor } from '../apps/nostrchat/src/protocol.ts';

const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export function integerWords(input: number, length = 0): number[] {
  const words: number[] = [];
  do { words.unshift(input % 32); input = Math.floor(input / 32); } while (input);
  while (words.length < length) words.unshift(0);
  return words;
}
export const invoiceTag = (code: number, words: number[]) => [code, Math.floor(words.length / 32), words.length % 32, ...words];

// These checksum-valid decoder fixtures have synthetic, unusable signatures.
// Their preimages are disposable local test bytes; no fixture leaves this process.
export function invoiceFixture(options: { description?: string; amountSats?: number; timestamp?: number; expiry?: number; preimage?: string; descriptionHash?: boolean; extraTags?: number[]; amountPrefix?: string } = {}): { invoice: InvoicePayload; preimage: string } {
  const description = options.description ?? 'Local protocol test invoice';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const preimage = options.preimage ?? toHex(bytes); bytes.fill(0);
  const proof = Uint8Array.from(preimage.match(/.{2}/g)!.map(part => parseInt(part, 16)));
  const paymentHash = toHex(sha256(proof)); proof.fill(0);
  const amountSats = options.amountSats ?? 10; const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000); const expiry = options.expiry ?? 600;
  const descriptionBytes = new TextEncoder().encode(description);
  const descriptionTag = options.descriptionHash ? invoiceTag(23, bech32.toWords(sha256(descriptionBytes))) : invoiceTag(13, bech32.toWords(descriptionBytes));
  const words = [...integerWords(timestamp, 7), ...invoiceTag(1, bech32.toWords(Uint8Array.from(paymentHash.match(/.{2}/g)!.map(part => parseInt(part, 16))))), ...descriptionTag, ...invoiceTag(6, integerWords(expiry)), ...(options.extraTags ?? []), ...bech32.toWords(new Uint8Array(65))];
  const bolt11 = bech32.encode('lnbcrt' + (options.amountPrefix ?? String(amountSats * 10) + 'n'), words, 12_000);
  return { invoice: { type: 'invoice', bolt11, paymentHash, amountSats, description, expiresAt: (timestamp + expiry) * 1000 }, preimage };
}

export async function outerEnvelope(owner: Identity, plaintext = '{}', tags?: string[][], date = Math.floor(Date.now() / 1000)): Promise<NostrEvent> {
  const ephemeral = createPracticeIdentity('Disposable envelope key');
  try { return finalizeEvent({ kind: 1059, created_at: date, tags: tags ?? [['p', owner.pubkey]], content: await ephemeral.encrypt(owner.pubkey, plaintext) }, ephemeral.secret!); } finally { destroyIdentity(ephemeral); }
}

export async function hostileEnvelope(change: (rumor: Rumor) => void, options: { sealDate?: number; sealTags?: string[][]; outerTags?: (owner: string) => string[][]; outerDate?: number; signedRumor?: boolean } = {}) {
  const alice = createPracticeIdentity('Disposable Alice'); const bob = createPracticeIdentity('Disposable Bob');
  const rumor: Rumor = { kind: 14, pubkey: alice.pubkey, tags: [['p', bob.pubkey]], content: 'Local private test text', created_at: Math.floor(Date.now() / 1000), id: '' };
  rumor.id = getEventHash(rumor); change(rumor);
  const value = options.signedRumor ? { ...rumor, sig: '00'.repeat(64) } : rumor;
  const template: EventTemplate = { kind: 13, created_at: options.sealDate ?? Math.floor(Date.now() / 1000), tags: options.sealTags ?? [], content: await alice.encrypt(bob.pubkey, JSON.stringify(value)) };
  const seal = finalizeEvent(template, alice.secret!);
  const event = await outerEnvelope(bob, JSON.stringify(seal), options.outerTags?.(bob.pubkey), options.outerDate);
  return { event, alice, bob, destroy: () => { destroyIdentity(alice); destroyIdentity(bob); } };
}
