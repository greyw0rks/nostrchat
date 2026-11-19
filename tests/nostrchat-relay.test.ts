import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, type NostrEvent } from 'nostr-tools';
import { createGiftWraps, createPracticeIdentity, destroyIdentity, type Identity } from '../apps/nostrchat/src/protocol.ts';
import { ChatRelay, RelayPublishError, type Filter, type RelayOptions } from '../apps/nostrchat/src/relay.ts';
import { outerEnvelope } from './nostrchat-fixtures.ts';

class ControlledWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances: ControlledWebSocket[] = [];
  readyState = ControlledWebSocket.CONNECTING; bufferedAmount = 0; sent: unknown[][] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  throwSend = false; onSend?: (frame: unknown[]) => void;
  constructor(public readonly url: string) { ControlledWebSocket.instances.push(this); }
  open(): void { this.readyState = ControlledWebSocket.OPEN; this.onopen?.(new Event('open')); }
  send(data: string): void {
    if (this.throwSend) throw new Error('Synthetic transport failure');
    if (this.readyState !== ControlledWebSocket.OPEN) throw new Error('Synthetic closed transport');
    const frame = JSON.parse(data) as unknown[]; this.sent.push(frame); this.onSend?.(frame);
  }
  receive(frame: unknown[]): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  disconnect(): void { this.readyState = ControlledWebSocket.CLOSED; this.onclose?.(new Event('close')); }
  close(): void { this.disconnect(); }
}
function install(t: TestContext): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'); ControlledWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', { value: ControlledWebSocket, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'WebSocket', previous); else Reflect.deleteProperty(globalThis, 'WebSocket'); });
}
function account(t: TestContext, name: string): Identity { const identity = createPracticeIdentity(name); t.after(() => destroyIdentity(identity)); return identity; }
function connected(t: TestContext, options: RelayOptions = {}) {
  install(t); const states: string[] = [];
  const relay = new ChatRelay('ws://127.0.0.1/local-fixture', state => states.push(state), { ackTimeoutMs: 20, recoveryTimeoutMs: 20, publishTimeoutMs: 1000, reconnectBaseMs: 10, reconnectMaxMs: 10, ...options });
  t.after(() => relay.close()); relay.connect(); const socket = ControlledWebSocket.instances[0]; socket.open(); return { relay, socket, states };
}
async function tick(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
async function eventually(check: () => boolean): Promise<void> {
  const end = Date.now() + 1500;
  while (!check()) { if (Date.now() > end) throw new Error('Local relay fixture timed out'); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
}
const outgoing = (socket: ControlledWebSocket, type: string) => socket.sent.filter(frame => frame[0] === type);
async function gift(t: TestContext): Promise<{ event: NostrEvent; senderCopy: NostrEvent; bob: Identity }> {
  const alice = account(t, 'Disposable Alice'); const bob = account(t, 'Disposable Bob');
  const wraps = await createGiftWraps(alice, bob.pubkey, { type: 'text', text: 'Local relay regression message' });
  return { event: wraps.events[0], senderCopy: wraps.events[1], bob };
}

test('relay EVENT delivery checks filter kind, author, recipient and time and deduplicates valid envelopes', async t => {
  const { event, senderCopy, bob } = await gift(t); const { relay, socket } = connected(t); const received: string[] = [];
  const filters: Filter[] = [{ kinds: [1059], authors: [event.pubkey], '#p': [bob.pubkey], since: event.created_at, until: event.created_at + 1, limit: 20 }];
  relay.subscribe('inbox', filters, value => { received.push(value.id); });
  filters[0]['#p']![0] = senderCopy.tags[0][1];
  socket.receive(['EVENT', 'inbox', senderCopy]);
  socket.receive(['EVENT', 'inbox', { ...event, content: 'forged' }]);
  socket.receive(['EVENT', 'not-subscribed', event]);
  socket.receive(['EVENT', 'inbox', await outerEnvelope(bob)]);
  const secret = generateSecretKey();
  try { socket.receive(['EVENT', 'inbox', finalizeEvent({ kind: 1, tags: [['p', bob.pubkey]], created_at: event.created_at, content: 'public' }, secret)]); } finally { secret.fill(0); }
  socket.receive(['EVENT', 'inbox', event]); socket.receive(['EVENT', 'inbox', event]);
  await tick(); assert.deepEqual(received, [event.id]);
  assert.equal((outgoing(socket, 'REQ')[0][2] as Filter)['#p']![0], bob.pubkey);
  const after: string[] = []; relay.subscribe('after', [{ kinds: [1059], '#p': [bob.pubkey], since: event.created_at + 1 }], value => { after.push(value.id); });
  socket.receive(['EVENT', 'after', event]); await tick(); assert.deepEqual(after, []);
});

test('EOSE waits for async envelope processing and CLOSED prevents further delivery until reconnect', async t => {
  const { event, bob } = await gift(t); const second = await outerEnvelope(bob); const { relay, socket } = connected(t);
  const order: string[] = []; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  relay.subscribe('inbox', [{ kinds: [1059], '#p': [bob.pubkey] }], async value => { order.push(value.id); if (value.id === event.id) await barrier; }, { onEose: () => { order.push('EOSE'); }, onClosed: reason => { order.push(reason); } });
  socket.receive(['EVENT', 'inbox', event]); socket.receive(['EVENT', 'inbox', second]); socket.receive(['EOSE', 'inbox']); socket.receive(['EOSE', 'inbox']);
  await tick(); assert.deepEqual(order, [event.id]);
  release(); await tick(); assert.deepEqual(order, [event.id, second.id, 'EOSE']);
  socket.receive(['CLOSED', 'inbox', 'restricted: local fixture']); socket.receive(['EVENT', 'inbox', await outerEnvelope(bob)]); await tick();
  assert.equal(order.at(-1), 'restricted: local fixture'); assert.equal(order.length, 4);
});

test('replacing a subscription is safe from an old unsubscribe and malformed control frames are inert', async t => {
  const { event, bob } = await gift(t); const notices: string[] = []; const { relay, socket } = connected(t, { onNotice: notice => { notices.push(notice); } });
  const received: string[] = [];
  const previous = relay.subscribe('same', [{ kinds: [1059], '#p': [bob.pubkey] }], () => {});
  relay.subscribe('same', [{ kinds: [1059], '#p': [bob.pubkey] }], value => { received.push(value.id); });
  previous(); socket.receive(['EVENT', 'same', event]); socket.receive(['EOSE', 'same', 'extra']); socket.receive(['CLOSED', 'same', true]);
  socket.receive(['NOTICE', 'A useful local notice']); socket.onmessage?.({ data: '{broken' }); socket.onmessage?.({ data: { arbitrary: 'object' } });
  await tick(); assert.deepEqual(received, [event.id]); assert.deepEqual(notices, ['A useful local notice']);
  assert.throws(() => relay.subscribe('invalid-filter', [{ limit: 501 }], () => {}), /500/);
  for (let i = 0; i < 15; i++) relay.subscribe('bounded-' + i, [{ kinds: [1059] }], () => {});
  assert.throws(() => relay.subscribe('too-many', [{ kinds: [1059] }], () => {}), /Too many/);
  assert.throws(() => relay.subscribe('ack:reserved', [{ kinds: [1059] }], () => {}), /invalid/);
});

test('publish deduplicates simultaneous same-envelope attempts and accepts only complete boolean ACKs', async t => {
  const { event } = await gift(t); const { relay, socket } = connected(t);
  const first = relay.publish(event); const second = relay.publish(structuredClone(event)); void first.catch(() => undefined);
  assert.equal(first, second); assert.equal(outgoing(socket, 'EVENT').length, 1);
  let settled = false; void first.then(() => { settled = true; }, () => { settled = true; });
  socket.receive(['OK', event.id, 'true', 'bad type']); socket.receive(['OK', event.id, true]); socket.receive(['OK', 'not-the-id', true, '']);
  await tick(); assert.equal(settled, false);
  socket.receive(['OK', event.id, true, 'stored']); await first;
  assert.equal(settled, true);
});

test('a lost ACK is recovered by retrieving the same signed envelope without a resend', async t => {
  const { event } = await gift(t); const { relay, socket } = connected(t);
  socket.onSend = frame => {
    if (frame[0] === 'REQ' && String(frame[1]).startsWith('ack:')) { socket.receive(['EVENT', frame[1], event]); socket.receive(['EOSE', frame[1]]); }
  };
  await relay.publish(event);
  assert.equal(outgoing(socket, 'EVENT').length, 1);
  const recovery = outgoing(socket, 'REQ').find(frame => String(frame[1]).startsWith('ack:'));
  assert.deepEqual((recovery![2] as Filter).ids, [event.id]);
  assert.equal(outgoing(socket, 'CLOSE').some(frame => frame[1] === recovery![1]), true);
});

test('an absent recovery event retries the exact signed envelope and preserves its event ID', async t => {
  const { event } = await gift(t); const { relay, socket } = connected(t);
  socket.onSend = frame => {
    if (frame[0] === 'REQ' && String(frame[1]).startsWith('ack:')) socket.receive(['EOSE', frame[1]]);
    if (frame[0] === 'EVENT' && outgoing(socket, 'EVENT').length === 2) socket.receive(['OK', event.id, true, 'duplicate: stored']);
  };
  await relay.publish(event);
  assert.equal(outgoing(socket, 'EVENT').length, 2);
  assert.deepEqual(outgoing(socket, 'EVENT').map(frame => frame[1]), [event, event]);
});

test('reconnect restores subscriptions and an old socket cannot fail or acknowledge new recovery work', async t => {
  const { event, bob } = await gift(t); const { relay, socket, states } = connected(t);
  relay.subscribe('inbox', [{ kinds: [1059], '#p': [bob.pubkey] }], () => {});
  const oldClose = socket.onclose!; const oldMessage = socket.onmessage!;
  const pending = relay.publish(event); void pending.catch(() => undefined); socket.disconnect();
  await eventually(() => ControlledWebSocket.instances.length === 2);
  const next = ControlledWebSocket.instances[1];
  next.onSend = frame => { if (frame[0] === 'REQ' && String(frame[1]).startsWith('ack:')) next.receive(['EOSE', frame[1]]); };
  next.open(); oldClose(new Event('close')); oldMessage({ data: JSON.stringify(['OK', event.id, false, 'stale rejection']) });
  assert.equal(relay.state, 'connected'); assert.equal(outgoing(next, 'REQ').some(frame => frame[1] === 'inbox'), true);
  assert.deepEqual(outgoing(next, 'EVENT').map(frame => frame[1]), [event]);
  next.receive(['OK', event.id, true, 'stored after reconnect']); await pending;
  assert.deepEqual(states.slice(-2), ['connecting', 'connected']);
});

test('a synchronous transport send failure recovers without leaking pending entries or minting a new event', async t => {
  const { event } = await gift(t); const { relay, socket } = connected(t); socket.throwSend = true;
  const pending = relay.publish(event); void pending.catch(() => undefined);
  await eventually(() => ControlledWebSocket.instances.length === 2);
  const next = ControlledWebSocket.instances[1];
  next.onSend = frame => {
    if (frame[0] === 'REQ') next.receive(['EOSE', frame[1]]);
    if (frame[0] === 'EVENT') next.receive(['OK', event.id, true, 'stored']);
  };
  next.open(); await pending; assert.deepEqual(outgoing(next, 'EVENT').map(frame => frame[1]), [event]);
  const again = relay.publish(event); await again;
  assert.equal(outgoing(next, 'EVENT').length, 2);
});

test('repeated missing ACKs have bounded same-event retries and an uncertain outcome can be retried again', async t => {
  const { event } = await gift(t); const { relay, socket } = connected(t, { maxPublishAttempts: 3 });
  socket.onSend = frame => { if (frame[0] === 'REQ') socket.receive(['EOSE', frame[1]]); };
  await assert.rejects(relay.publish(event), error => error instanceof RelayPublishError && error.uncertain && error.eventId === event.id);
  const frames = outgoing(socket, 'EVENT'); assert.equal(frames.length, 3); assert.ok(frames.every(frame => (frame[1] as NostrEvent).id === event.id));
  socket.onSend = frame => { if (frame[0] === 'EVENT') socket.receive(['OK', event.id, true, 'stored on explicit retry']); };
  await relay.publish(event);
});

test('private-message publishing refuses signed plaintext and bounds the concurrent pending queue', async t => {
  const owner = account(t, 'Disposable queue owner'); const envelopes: NostrEvent[] = [];
  for (let i = 0; i < 31; i++) envelopes.push(await outerEnvelope(owner));
  const { relay, socket } = connected(t, { ackTimeoutMs: 1000, publishTimeoutMs: 1500 });
  const pending = envelopes.slice(0, 30).map(event => { const result = relay.publish(event); void result.catch(() => undefined); return result; });
  await assert.rejects(relay.publish(envelopes[30]), /previous messages/);
  const secret = generateSecretKey();
  try { await assert.rejects(relay.publish(finalizeEvent({ kind: 1, tags: [], created_at: Math.floor(Date.now() / 1000), content: 'Never publish plaintext from chat' }, secret)), /encrypted gift wrap/); } finally { secret.fill(0); }
  assert.equal(outgoing(socket, 'EVENT').length, 30);
  relay.close(); const outcomes = await Promise.allSettled(pending); assert.ok(outcomes.every(result => result.status === 'rejected'));
});

test('async receive backlogs stay bounded by bytes and do not run concurrent decrypt callbacks', async t => {
  const owner = account(t, 'Disposable backlog owner'); const events: NostrEvent[] = [];
  for (let i = 0; i < 40; i++) events.push(await outerEnvelope(owner, 'x'.repeat(50_000)));
  const notices: string[] = []; const { relay, socket } = connected(t, { onNotice: notice => { notices.push(notice); } });
  let active = 0; let maxActive = 0; let received = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  relay.subscribe('inbox', [{ kinds: [1059], '#p': [owner.pubkey] }], async () => {
    active++; maxActive = Math.max(active, maxActive); received++; if (received === 1) await barrier; active--;
  });
  for (const event of events) socket.receive(['EVENT', 'inbox', event]);
  await tick(); assert.equal(received, 1); assert.ok(notices.some(notice => notice.includes('too quickly')));
  release(); await tick(); assert.equal(maxActive, 1); assert.ok(received > 1 && received < events.length);
});

test('closing is terminal, rejects pending work and ignores every captured old socket callback', async t => {
  const { event } = await gift(t); const { relay, socket } = connected(t);
  const oldOpen = socket.onopen!; const oldMessage = socket.onmessage!; const oldClose = socket.onclose!;
  const pending = relay.publish(event); void pending.catch(() => undefined); relay.close();
  await assert.rejects(pending, /Connection closed/);
  oldOpen(new Event('open')); oldMessage({ data: JSON.stringify(['OK', event.id, true, 'stale']) }); oldClose(new Event('close')); relay.connect(); await tick();
  assert.equal(relay.state, 'offline'); assert.equal(ControlledWebSocket.instances.length, 1);
});
