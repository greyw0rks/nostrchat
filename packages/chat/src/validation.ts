import { z } from 'zod';
import { verifyEvent, type Event } from 'nostr-tools';
import { GateError } from '../../nwc-gate/src/types';

export const CHAT_CACHE_BYTES = 2_000_000;
export const CHAT_CACHE_COUNT = 2000;
export const CHAT_OUTBOX_COUNT = 100;
export const CHAT_BODY_LIMIT = 96_000;
export const normalizeNetwork = (value: string) => ({ mainnet: 'bitcoin', testnet3: 'testnet', testnet4: 'testnet' } as Record<string, string>)[value] ?? value;
export const chatKey = z.string().regex(/^[a-f0-9]{64}$/);

export function chatCiphertext(value: unknown, maxLength = 88_000): string {
  if (typeof value !== 'string' || value.length < 132 || value.length > maxLength || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new GateError('INVALID_CIPHERTEXT', 'Save an encrypted NIP-44 payload, without plaintext or credentials.', 422);
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (bytes.length < 99 || bytes[0] !== 2) throw new GateError('INVALID_CIPHERTEXT', 'This encrypted payload does not use supported NIP-44 encryption.', 422);
  return value;
}

const eventSchema = z.object({
  id: chatKey, pubkey: chatKey, sig: z.string().regex(/^[a-f0-9]{128}$/), kind: z.literal(1059),
  created_at: z.number().int().nonnegative(), content: z.string().min(132).max(30_000),
  tags: z.array(z.array(z.string().max(512)).max(8)).max(24)
}).strict();

export function chatEnvelope(value: unknown, recipient: string, now: number): Event {
  const result = eventSchema.safeParse(value);
  if (!result.success) throw new GateError('INVALID_ENVELOPE', 'Only signed, encrypted Nostr private-message envelopes can be cached.', 422);
  const event = result.data;
  const recipients = event.tags.filter(tag => tag[0] === 'p');
  if (recipients.length !== 1 || recipients[0].length !== 2 || recipients[0][1] !== recipient) throw new GateError('WRONG_RECIPIENT', 'This encrypted envelope belongs to a different identity.', 403);
  chatCiphertext(event.content, 30_000);
  // Parse an independent object; never accept nostr-tools' cached verifiedSymbol from a caller.
  if (event.created_at > Math.floor(now / 1000) + 60 || !verifyEvent(JSON.parse(JSON.stringify(event)))) throw new GateError('INVALID_ENVELOPE', 'The envelope signature or timestamp is invalid.', 422);
  return event;
}

export function chatPage(cursor: unknown, limit: unknown) {
  const parsedLimit = limit === undefined || limit === '' ? 20 : Number(limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50 || cursor != null && (typeof cursor !== 'string' || cursor.length > 2048)) throw new GateError('INVALID_PAGE', 'Choose a page size between 1 and 50.', 422);
  return { cursor: typeof cursor === 'string' && cursor ? cursor : null, limit: parsedLimit };
}
