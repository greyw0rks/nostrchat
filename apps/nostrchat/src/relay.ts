import { matchFilters, type NostrEvent } from 'nostr-tools';
import { canonicalSignedEvent, ownedGiftEvent } from './protocol';

export type RelayState = 'connecting' | 'connected' | 'offline';
export type Filter = { ids?: string[]; kinds?: number[]; authors?: string[]; '#p'?: string[]; limit?: number; since?: number; until?: number };
export type SubscriptionCallbacks = { onEose?(): void; onClosed?(reason: string): void };
export type RelayOptions = {
  ackTimeoutMs?: number; recoveryTimeoutMs?: number; publishTimeoutMs?: number;
  connectTimeoutMs?: number; reconnectBaseMs?: number; reconnectMaxMs?: number; maxPublishAttempts?: number;
  onNotice?(message: string): void;
};
type Timer = ReturnType<typeof setTimeout>;
type Pending = {
  event: NostrEvent; promise: Promise<void>; resolve(): void; reject(error: Error): void;
  attempts: number; sentSocket?: WebSocket; deadline: Timer; ack?: Timer; recovery?: Timer; recoveryId?: string;
};
type Subscription = {
  filters: Filter[]; onEvent(event: NostrEvent): void | Promise<void>; callbacks: SubscriptionCallbacks;
  seen: Set<string>; queue: Array<{ event: NostrEvent; bytes: number }>; draining: boolean;
  closed: boolean; eose: boolean; eoseNotified: boolean;
};
const MAX_PENDING = 30;
const MAX_SUBSCRIPTIONS = 16;
const MAX_QUEUE_EVENTS = 500;
const MAX_QUEUE_BYTES = 2_000_000;
const HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const clamp = (value: number | undefined, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
const safeReason = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);

export class RelayPublishError extends Error {
  constructor(message: string, public readonly uncertain: boolean, public readonly eventId: string) { super(message); this.name = 'RelayPublishError'; }
}

function validFilters(filters: Filter[]): Filter[] {
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 4) throw new Error('Use one to four bounded relay filters.');
  return filters.map(filter => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('This relay filter is invalid.');
    const result: Filter = {};
    for (const key of ['ids', 'authors', '#p'] as const) {
      const values = filter[key];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length < 1 || values.length > 64 || values.some(value => typeof value !== 'string' || !HEX.test(value))) throw new Error('Relay filters need valid full public keys or event IDs.');
      result[key] = [...new Set(values)];
    }
    if (filter.kinds !== undefined) {
      if (!Array.isArray(filter.kinds) || filter.kinds.length < 1 || filter.kinds.length > 16 || filter.kinds.some(kind => !Number.isInteger(kind) || kind < 0 || kind > 65_535)) throw new Error('This relay kind filter is invalid.');
      result.kinds = [...new Set(filter.kinds)];
    }
    for (const key of ['since', 'until'] as const) {
      const value = filter[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000) throw new Error('This relay date filter is invalid.');
      result[key] = value;
    }
    if (result.since !== undefined && result.until !== undefined && result.since > result.until) throw new Error('The relay filter date range is invalid.');
    if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 500)) throw new Error('Relay history requests are limited to 500 events.');
    result.limit = filter.limit ?? 500;
    return result;
  });
}

export class ChatRelay {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private subscriptions = new Map<string, Subscription>();
  private stopped = false;
  private reconnectTimer?: Timer;
  private connectTimer?: Timer;
  private attempt = 0;
  private queuedBytes = 0;
  private readonly options: Required<Omit<RelayOptions, 'onNotice'>> & Pick<RelayOptions, 'onNotice'>;
  state: RelayState = 'offline';

  constructor(public readonly url: string, private readonly onState: (state: RelayState) => void, options: RelayOptions = {}) {
    this.options = {
      ackTimeoutMs: clamp(options.ackTimeoutMs, 10_000, 10, 30_000),
      recoveryTimeoutMs: clamp(options.recoveryTimeoutMs, 2_000, 10, 5_000),
      publishTimeoutMs: clamp(options.publishTimeoutMs, 45_000, 100, 90_000),
      connectTimeoutMs: clamp(options.connectTimeoutMs, 9_000, 100, 15_000),
      reconnectBaseMs: clamp(options.reconnectBaseMs, 1_000, 10, 5_000),
      reconnectMaxMs: clamp(options.reconnectMaxMs, 15_000, 10, 30_000),
      maxPublishAttempts: clamp(options.maxPublishAttempts, 3, 1, 5),
      onNotice: options.onNotice,
    };
  }

  connect(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.setState('connecting');
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); } catch { this.setState('offline'); this.scheduleReconnect(); return; }
    this.socket = socket;
    this.connectTimer = setTimeout(() => { if (this.socket === socket && socket.readyState !== WebSocket.OPEN) this.disconnected(socket); }, this.options.connectTimeoutMs);
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      clearTimeout(this.connectTimer); this.connectTimer = undefined; this.attempt = 0; this.setState('connected');
      for (const [id, subscription] of this.subscriptions) {
        subscription.closed = false; subscription.eose = false; subscription.eoseNotified = false;
        this.send(socket, ['REQ', id, ...subscription.filters]);
      }
      for (const item of this.pending.values()) this.recover(item, socket);
    };
    socket.onmessage = message => { if (this.socket === socket && !this.stopped) this.message(socket, message.data); };
    socket.onerror = () => { if (this.socket === socket) this.disconnected(socket); };
    socket.onclose = () => { if (this.socket === socket) this.disconnected(socket); };
  }

  private setState(state: RelayState): void {
    if (this.state === state) return;
    this.state = state; try { this.onState(state); } catch { /* observers do not own the connection */ }
  }
  private notice(message: string): void { try { this.options.onNotice?.(safeReason(message)); } catch { /* observer failure */ } }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const sample = crypto.getRandomValues(new Uint8Array(1))[0] / 255;
    const delay = Math.min(this.options.reconnectBaseMs * 2 ** Math.min(this.attempt++, 10), this.options.reconnectMaxMs) * (0.8 + sample * 0.4);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
  }
  private disconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null; clearTimeout(this.connectTimer); this.connectTimer = undefined;
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
    try { socket.close(); } catch { /* already gone */ }
    for (const item of this.pending.values()) {
      clearTimeout(item.ack); clearTimeout(item.recovery); item.ack = undefined; item.recovery = undefined; item.recoveryId = undefined;
    }
    this.setState('offline'); this.scheduleReconnect();
  }
  private send(socket: WebSocket, message: unknown[]): boolean {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 1_000_000) { this.notice('Relay connection is busy. History and pending messages will recover after reconnecting.'); this.disconnected(socket); return false; }
    try { socket.send(JSON.stringify(message)); return true; } catch { this.disconnected(socket); return false; }
  }
  private finish(item: Pending, error?: Error): void {
    if (this.pending.get(item.event.id) !== item) return;
    this.pending.delete(item.event.id);
    clearTimeout(item.deadline); clearTimeout(item.ack); clearTimeout(item.recovery);
    if (item.recoveryId && this.socket?.readyState === WebSocket.OPEN) this.send(this.socket, ['CLOSE', item.recoveryId]);
    item.recoveryId = undefined;
    if (error) item.reject(error); else item.resolve();
  }
  private publishAttempt(item: Pending, socket: WebSocket): void {
    if (this.pending.get(item.event.id) !== item || this.socket !== socket) return;
    this.closeRecovery(item, socket); clearTimeout(item.ack);
    if (item.attempts >= this.options.maxPublishAttempts) {
      this.finish(item, new RelayPublishError('The relay could not confirm this envelope. Check history or retry the same message.', true, item.event.id)); return;
    }
    item.attempts++; item.sentSocket = socket;
    item.ack = setTimeout(() => this.recover(item, socket), this.options.ackTimeoutMs);
    // The same signed envelope is reused; no new rumor or payment is created.
    this.send(socket, ['EVENT', item.event]);
  }
  private closeRecovery(item: Pending, socket?: WebSocket): void {
    clearTimeout(item.recovery); item.recovery = undefined;
    const id = item.recoveryId; item.recoveryId = undefined;
    if (id && socket && this.socket === socket && socket.readyState === WebSocket.OPEN) this.send(socket, ['CLOSE', id]);
  }
  private recover(item: Pending, socket: WebSocket): void {
    if (this.pending.get(item.event.id) !== item || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    clearTimeout(item.ack); item.ack = undefined; this.closeRecovery(item, socket);
    item.recoveryId = 'ack:' + item.event.id.slice(0, 60);
    item.recovery = setTimeout(() => {
      if (this.pending.get(item.event.id) === item && this.socket === socket) this.publishAttempt(item, socket);
    }, this.options.recoveryTimeoutMs);
    this.send(socket, ['REQ', item.recoveryId, { ids: [item.event.id], limit: 1 }]);
  }
  private recoveryFor(id: string): Pending | undefined {
    for (const item of this.pending.values()) if (item.recoveryId === id) return item;
    return undefined;
  }

  private message(socket: WebSocket, data: unknown): void {
    if (typeof data !== 'string' || data.length > 100_000 || encoder.encode(data).length > 100_000) return;
    let message: unknown;
    try { message = JSON.parse(data); } catch { return; }
    if (!Array.isArray(message) || message.length > 8) return;
    const id = message[1];
    if (message[0] === 'EVENT' && message.length === 3 && typeof id === 'string') {
      const subscription = this.subscriptions.get(id); const recovering = this.recoveryFor(id);
      if ((!subscription || subscription.closed) && !recovering) return;
      const event = canonicalSignedEvent(message[2]);
      if (!event) return;
      if (recovering) { if (event.id === recovering.event.id) this.finish(recovering); return; }
      if (!subscription || !matchFilters(subscription.filters, event)) return;
      // A verified event echoed by our own subscription also resolves a lost ACK.
      const publishing = this.pending.get(event.id); if (publishing) this.finish(publishing);
      if (subscription.seen.has(event.id)) return;
      const bytes = encoder.encode(JSON.stringify(event)).length;
      if (subscription.queue.length >= MAX_QUEUE_EVENTS || this.queuedBytes + bytes > MAX_QUEUE_BYTES) { this.notice('Relay history is arriving too quickly. Reconnect to recover remaining envelopes.'); return; }
      subscription.seen.add(event.id);
      if (subscription.seen.size > 1000) subscription.seen.delete(subscription.seen.values().next().value!);
      subscription.queue.push({ event, bytes }); this.queuedBytes += bytes; void this.drain(id, subscription); return;
    }
    if (message[0] === 'OK' && message.length === 4 && typeof id === 'string' && HEX.test(id) && typeof message[2] === 'boolean' && typeof message[3] === 'string') {
      const item = this.pending.get(id);
      if (!item || item.sentSocket !== socket) return;
      if (message[2]) this.finish(item);
      else this.finish(item, new RelayPublishError(safeReason(message[3]) || 'Relay did not accept your message.', item.attempts > 1, id));
      return;
    }
    if (message[0] === 'EOSE' && message.length === 2 && typeof id === 'string') {
      const recovering = this.recoveryFor(id);
      if (recovering) { this.publishAttempt(recovering, socket); return; }
      const subscription = this.subscriptions.get(id);
      if (subscription && !subscription.closed) { subscription.eose = true; void this.drain(id, subscription); }
      return;
    }
    if (message[0] === 'CLOSED' && message.length === 3 && typeof id === 'string' && typeof message[2] === 'string') {
      const recovering = this.recoveryFor(id);
      if (recovering) { this.publishAttempt(recovering, socket); return; }
      const subscription = this.subscriptions.get(id);
      if (subscription) {
        subscription.closed = true; this.clearQueue(subscription);
        const reason = safeReason(message[2]) || 'Relay closed this subscription.';
        try { subscription.callbacks.onClosed?.(reason); } catch { /* observer failure */ }
        this.notice(reason);
      }
      return;
    }
    if (message[0] === 'NOTICE' && message.length === 2 && typeof id === 'string') this.notice(id);
    if (message[0] === 'AUTH') this.notice('This relay requires authentication. Choose a relay that accepts private gift wraps.');
  }
  private clearQueue(subscription: Subscription): void {
    for (const item of subscription.queue) this.queuedBytes -= item.bytes;
    subscription.queue = [];
  }
  private async drain(id: string, subscription: Subscription): Promise<void> {
    if (subscription.draining) return;
    subscription.draining = true;
    try {
      while (this.subscriptions.get(id) === subscription && !subscription.closed && subscription.queue.length) {
        const item = subscription.queue.shift()!; this.queuedBytes -= item.bytes;
        try { await subscription.onEvent(item.event); } catch { this.notice('An encrypted envelope could not be processed.'); }
      }
      if (this.subscriptions.get(id) === subscription && !subscription.closed && subscription.eose && !subscription.eoseNotified) {
        subscription.eoseNotified = true; try { subscription.callbacks.onEose?.(); } catch { /* observer failure */ }
      }
    } finally { subscription.draining = false; }
  }

  subscribe(id: string, filters: Filter[], onEvent: (event: NostrEvent) => void | Promise<void>, callbacks: SubscriptionCallbacks = {}): () => void {
    if (this.stopped) throw new Error('This relay connection is closed.');
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,64}$/.test(id) || id.startsWith('ack:') || typeof onEvent !== 'function') throw new Error('This relay subscription is invalid.');
    if (!this.subscriptions.has(id) && this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error('Too many active relay subscriptions.');
    const normalized = validFilters(filters); const previous = this.subscriptions.get(id); if (previous) this.clearQueue(previous);
    const subscription: Subscription = { filters: normalized, onEvent, callbacks, seen: new Set(), queue: [], draining: false, closed: false, eose: false, eoseNotified: false };
    this.subscriptions.set(id, subscription);
    if (this.socket?.readyState === WebSocket.OPEN) this.send(this.socket, ['REQ', id, ...normalized]);
    return () => {
      // An old cleanup must not delete a newer subscription with the same ID.
      if (this.subscriptions.get(id) !== subscription) return;
      this.subscriptions.delete(id); this.clearQueue(subscription);
      if (this.socket?.readyState === WebSocket.OPEN) this.send(this.socket, ['CLOSE', id]);
    };
  }

  publish(event: NostrEvent): Promise<void> {
    const canonical = ownedGiftEvent(event);
    if (!canonical) return Promise.reject(new Error('Publish a valid encrypted gift wrap with a fresh signature.'));
    const active = this.pending.get(canonical.id); if (active) return active.promise;
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Your relay is offline. Reconnect before sending.'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Please wait for your previous messages to finish.'));
    let resolve!: () => void; let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const item: Pending = { event: canonical, promise, resolve, reject, attempts: 0, deadline: setTimeout(() => {
      this.finish(item, new RelayPublishError('The relay could not confirm this envelope before the connection timed out. You can safely retry the same message.', true, canonical.id));
    }, this.options.publishTimeoutMs) };
    this.pending.set(canonical.id, item); this.publishAttempt(item, this.socket); return promise;
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.reconnectTimer); clearTimeout(this.connectTimer);
    this.reconnectTimer = undefined; this.connectTimer = undefined;
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; try { socket.close(); } catch { /* already closed */ } }
    for (const subscription of this.subscriptions.values()) this.clearQueue(subscription);
    this.subscriptions.clear();
    for (const item of [...this.pending.values()]) this.finish(item, new RelayPublishError('Connection closed.', item.attempts > 0, item.event.id));
    this.setState('offline');
  }
}
