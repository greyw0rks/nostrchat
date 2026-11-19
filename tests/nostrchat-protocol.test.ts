import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getEventHash, type EventTemplate, type NostrEvent } from 'nostr-tools';
import type { WindowNostr } from 'nostr-tools/nip07';
import { bech32 } from '@scure/base';
import { ApiError, api, authenticateWallet, createAvailableIdentity, createEncryptedBackup, createExtensionIdentity, createGiftWraps, createPracticeIdentity, destroyIdentity, freshSignatureIsValid, inspectEncryptedBackup, inspectInvoice, invoiceScopeKey, matchingReceiptInvoices, mergeMessage, parsePayload, unwrapGift, unlockEncryptedBackup, type ChatMessage, type Identity, type Rumor } from '../apps/nostrchat/src/protocol.ts';
import { hostileEnvelope, invoiceFixture, invoiceTag } from './nostrchat-fixtures.ts';

function disposable(t: TestContext, name: string): Identity { const identity = createPracticeIdentity(name); t.after(() => destroyIdentity(identity)); return identity; }
function provider(identity: Identity, changes: Partial<WindowNostr> = {}): WindowNostr {
  return { getPublicKey: async () => identity.pubkey, signEvent: async event => await identity.sign(event) as Awaited<ReturnType<WindowNostr['signEvent']>>, nip44: { encrypt: identity.encrypt, decrypt: identity.decrypt }, ...changes };
}
function replaceGlobal(t: TestContext, name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
}
const signedTemplate = (): EventTemplate => ({ kind: 13, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'Requested sealed content' });

test('an extension mutating its argument cannot substitute a signed request', async t => {
  const local = disposable(t, 'Disposable signer');
  const identity = await createExtensionIdentity(provider(local, { signEvent: async event => {
    event.content = 'Substituted text'; event.tags.push(['injected', 'tag']);
    return await local.sign(event) as Awaited<ReturnType<WindowNostr['signEvent']>>;
  } }));
  const requested = signedTemplate(); const copy = structuredClone(requested);
  await assert.rejects(identity.sign(requested), /different event or account/);
  assert.deepEqual(requested, copy);
});

test('verification ignores signature caches and never invokes untrusted toJSON or accessors', () => {
  const secret = generateSecretKey();
  try {
    const signed = finalizeEvent({ kind: 1, content: 'authentic', created_at: Math.floor(Date.now() / 1000), tags: [] }, secret);
    let calls = 0;
    const forged = { ...signed, content: 'forged', toJSON: () => { calls++; return signed; } };
    assert.equal(freshSignatureIsValid(forged), false); assert.equal(calls, 0);
    const accessor = { ...signed };
    Object.defineProperty(accessor, 'content', { get: () => { calls++; return 'authentic'; } });
    assert.equal(freshSignatureIsValid(accessor), false); assert.equal(calls, 0);
    for (const event of [null, [], { ...signed, kind: 0.5 }, { ...signed, created_at: -1 }, { ...signed, tags: [['p', 7]] }, { ...signed, sig: 'f'.repeat(129) }]) assert.equal(freshSignatureIsValid(event), false);
  } finally { secret.fill(0); }
});

test('valid signed gift wrappers reject duplicate recipients and unsafe outer or seal dates', async t => {
  for (const options of [
    { outerTags: (owner: string) => [['p', owner], ['p', owner]] },
    { outerDate: -1 },
    { outerDate: Math.floor(Date.now() / 1000) + 3600 },
    { sealDate: -1 },
    { sealDate: Math.floor(Date.now() / 1000) + 3600 },
    { sealTags: [['p', 'unexpected']] },
  ]) {
    const fixture = await hostileEnvelope(() => {}, options); t.after(fixture.destroy);
    await assert.rejects(unwrapGift(fixture.bob, fixture.event), /invalid|validation/);
  }
});

test('signed rumor fields, malformed tags, unsafe dates, and overlong content cannot cross the seal boundary', async t => {
  for (const change of [
    (rumor: Rumor) => { rumor.created_at = -1; rumor.id = getEventHash(rumor); },
    (rumor: Rumor) => { rumor.created_at = 8_640_000_000_001; rumor.id = getEventHash(rumor); },
    (rumor: Rumor) => { rumor.tags = [null as unknown as string[]]; },
    (rumor: Rumor) => { rumor.tags = [['p', rumor.pubkey]]; rumor.id = getEventHash(rumor); },
    (rumor: Rumor) => { rumor.content = 'x'.repeat(18_001); rumor.id = getEventHash(rumor); },
  ]) {
    const fixture = await hostileEnvelope(change); t.after(fixture.destroy);
    await assert.rejects(unwrapGift(fixture.bob, fixture.event), /validation|not addressed/);
  }
  const signed = await hostileEnvelope(() => {}, { signedRumor: true }); t.after(signed.destroy);
  await assert.rejects(unwrapGift(signed.bob, signed.event), /author or content/);
});

test('blank and malformed known payloads never become invoices or receipts', () => {
  for (const content of [' ', '{"type":"text","text":""}', '{"type":"invoice"}', '{"type":"receipt","paymentHash":"paid","preimage":"paid"}']) assert.throws(() => parsePayload(content));
  assert.deepEqual(parsePayload('{"type":"paid","paid":true}'), { type: 'text', text: '{"type":"paid","paid":true}' });
});

test('literal structured JSON sent as text stays text on recipient and sender copies', async t => {
  const alice = disposable(t, 'Disposable Alice'); const bob = disposable(t, 'Disposable Bob');
  for (const text of ['{"type":"receipt","paymentHash":"not-a-proof"}', '{"type":"invoice"}', '{"type":"text","text":"a nested literal"}']) {
    const wrapped = await createGiftWraps(alice, bob.pubkey, { type: 'text', text });
    assert.deepEqual((await unwrapGift(bob, wrapped.events[0])).payload, { type: 'text', text });
    assert.deepEqual((await unwrapGift(alice, wrapped.events[1])).payload, { type: 'text', text });
  }
});

test('a destroyed local key cannot sign, encrypt, or decrypt', async t => {
  const local = disposable(t, 'Disposable local key'); const ciphertext = await local.encrypt(local.pubkey, 'local test data');
  destroyIdentity(local);
  assert.equal(local.secret!.every(byte => byte === 0), true);
  await assert.rejects(local.sign(signedTemplate()), /locked/);
  await assert.rejects(local.encrypt(local.pubkey, 'new text'), /locked/);
  await assert.rejects(local.decrypt(local.pubkey, ciphertext), /locked/);
});

test('signer capability probes reject stubs and an account switch prevents a new operation', async t => {
  const local = disposable(t, 'Disposable provider'); const next = disposable(t, 'Disposable next provider');
  await assert.rejects(createExtensionIdentity(provider(local, { nip44: { encrypt: async () => 'unsupported', decrypt: async () => 'unsupported' } })), /could not complete NIP-44/);
  await assert.rejects(createExtensionIdentity({ ...provider(local), nip44: { encrypt: local.encrypt } } as WindowNostr), /needs NIP-44/);
  let active = local.pubkey; let signs = 0;
  const identity = await createExtensionIdentity(provider(local, { getPublicKey: async () => active, signEvent: async event => { signs++; return await local.sign(event) as Awaited<ReturnType<WindowNostr['signEvent']>>; } }));
  active = next.pubkey;
  await assert.rejects(identity.sign(signedTemplate()), /changed accounts/); assert.equal(signs, 0);
});

test('an identity creation guard expires independently from later operation guards', async t => {
  const local = disposable(t, 'Disposable provider'); const creation = new AbortController();
  const identity = await createExtensionIdentity(provider(local), { signal: creation.signal });
  creation.abort();
  assert.equal(freshSignatureIsValid(await identity.sign(signedTemplate())), true);
  await assert.rejects(identity.sign(signedTemplate(), { signal: creation.signal }), { name: 'AbortError' });
  destroyIdentity(identity); await assert.rejects(identity.sign(signedTemplate()), { name: 'AbortError' });
});

test('an old signer completion is cancelled before a gift wrap is returned', async t => {
  const alice = disposable(t, 'Disposable Alice'); const bob = disposable(t, 'Disposable Bob');
  let release!: (value: string) => void; let encryptionStarted!: () => void;
  const started = new Promise<void>(resolve => { encryptionStarted = resolve; });
  const pending = new Promise<string>(resolve => { release = resolve; });
  const controller = new AbortController();
  const identity: Identity = { ...alice, encrypt: async () => { encryptionStarted(); return pending; } };
  const operation = createGiftWraps(identity, bob.pubkey, { type: 'text', text: 'cancelled message' }, undefined, { signal: controller.signal, expectedPubkey: alice.pubkey });
  await started; controller.abort(); await assert.rejects(operation, { name: 'AbortError' });
  release(await alice.encrypt(bob.pubkey, 'late encrypted data'));
});

test('Connect is preferred when compatible and late compatible signer injection is observed', async t => {
  const connect = disposable(t, 'Disposable Connect'); const fallback = disposable(t, 'Disposable NIP-07');
  const target = Object.assign(new EventTarget(), { connectWallet: { name: 'Connect', nostr: provider(connect) }, nostr: provider(fallback), setTimeout, clearTimeout, setInterval, clearInterval });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  replaceGlobal(t, 'window', target); replaceGlobal(t, 'document', document);
  const identity = await createAvailableIdentity(); assert.equal(identity.pubkey, connect.pubkey); destroyIdentity(identity);
  target.connectWallet.nostr = { signEvent: provider(connect).signEvent } as WindowNostr;
  const other = await createAvailableIdentity(); assert.equal(other.pubkey, fallback.pubkey); destroyIdentity(other);
  Reflect.deleteProperty(target, 'nostr'); Reflect.deleteProperty(target, 'connectWallet');
  const pending = createAvailableIdentity();
  Object.assign(target, { nostr: provider(fallback) }); target.dispatchEvent(new Event('nostr:ready'));
  const late = await pending; assert.equal(late.pubkey, fallback.pubkey); destroyIdentity(late);
});

test('NIP-49 exports round trip while excessive work factors and malformed backups fail before derivation', async t => {
  const identity = disposable(t, 'Disposable backup account'); const wrong = disposable(t, 'Disposable wrong account');
  const password = 'Disposable fixture passphrase';
  const encrypted = await createEncryptedBackup(identity, password);
  assert.equal(inspectEncryptedBackup(encrypted).logN, 16);
  const restored = await unlockEncryptedBackup(encrypted, password, identity.pubkey); t.after(() => destroyIdentity(restored)); assert.equal(restored.pubkey, identity.pubkey);
  await assert.rejects(unlockEncryptedBackup(encrypted, password, wrong.pubkey), /requested account/);
  await assert.rejects(unlockEncryptedBackup(encrypted, 'wrong disposable passphrase'), /Could not unlock/);
  for (const [version, logN, ksb, length] of [[2, 31, 2, 91], [2, 17, 2, 91], [2, 13, 2, 91], [1, 16, 2, 91], [2, 16, 3, 91], [2, 16, 2, 90]]) {
    const bytes = new Uint8Array(length); bytes[0] = version; bytes[1] = logN; bytes[42] = ksb;
    const malformed = bech32.encode('ncryptsec', bech32.toWords(bytes), 400);
    await assert.rejects(unlockEncryptedBackup(malformed, password), /supported work factor/);
  }
  const badChecksum = encrypted.slice(0, -1) + (encrypted.endsWith('q') ? 'p' : 'q');
  assert.throws(() => inspectEncryptedBackup(badChecksum), /supported work factor/);
  await assert.rejects(createEncryptedBackup(identity, 'short'), /passphrase/);
  await assert.rejects(unlockEncryptedBackup(encrypted, 'p'.repeat(1025)), /passphrase/);
});

test('invoice facts expose decoder limits and bind both plain and hashed descriptions', () => {
  const plain = invoiceFixture(); const hashed = invoiceFixture({ descriptionHash: true });
  assert.equal(inspectInvoice(plain.invoice.bolt11).signatureVerified, false);
  assert.equal(inspectInvoice(plain.invoice.bolt11).network, 'regtest');
  assert.deepEqual(parsePayload(JSON.stringify(plain.invoice)), plain.invoice);
  assert.deepEqual(parsePayload(JSON.stringify(hashed.invoice)), hashed.invoice);
  assert.throws(() => parsePayload(JSON.stringify({ ...plain.invoice, description: 'a substituted service claim' })), /do not match/);
  assert.throws(() => parsePayload(JSON.stringify({ ...hashed.invoice, description: 'a substituted hashed description' })), /do not match/);
  for (const options of [{ amountPrefix: '1p' }, { expiry: Number.MAX_SAFE_INTEGER }, { timestamp: Math.floor(Date.now() / 1000) + 3600 }, { expiry: 0 }]) assert.throws(() => inspectInvoice(invoiceFixture(options).invoice.bolt11), /whole-sat/);
  const repeated = invoiceFixture({ extraTags: invoiceTag(1, bech32.toWords(new Uint8Array(32))) });
  assert.throws(() => inspectInvoice(repeated.invoice.bolt11), /whole-sat/);
});

test('an opaque invoice description preserves the exact encoded hash without asserting a purpose', async t => {
  const fixture = invoiceFixture({ descriptionHash: true, description: 'LNURL metadata fixture' });
  const hash = inspectInvoice(fixture.invoice.bolt11).descriptionHash!;
  const opaque = { ...fixture.invoice, description: '', descriptionHash: hash };
  assert.deepEqual(parsePayload(JSON.stringify(opaque)), opaque);
  assert.throws(() => parsePayload(JSON.stringify({ ...opaque, descriptionHash: '00'.repeat(32) })), /do not match/);
  assert.throws(() => parsePayload(JSON.stringify({ ...opaque, descriptionHash: undefined })), /do not match/);
  assert.throws(() => parsePayload(JSON.stringify({ ...opaque, description: 'An invented purpose' })), /do not match/);
  const plain = invoiceFixture();
  assert.throws(() => parsePayload(JSON.stringify({ ...plain.invoice, descriptionHash: hash })), /do not match/);
  const alice = disposable(t, 'Disposable invoice author'); const bob = disposable(t, 'Disposable recipient');
  const wrapped = await createGiftWraps(alice, bob.pubkey, opaque);
  const message = await unwrapGift(bob, wrapped.events[0]);
  assert.deepEqual(message.payload, opaque);
  assert.throws(() => invoiceScopeKey(bob.pubkey, alice.pubkey, { ...message, payload: { ...opaque, descriptionHash: '00'.repeat(32) } }), /do not match/);
  assert.notEqual(invoiceScopeKey(bob.pubkey, alice.pubkey, message), invoiceScopeKey(bob.pubkey, alice.pubkey, { ...message, payload: fixture.invoice }));
});

test('receipt proof is bound to invoice ID, conversation, direction, and fixed invoice facts', async t => {
  const alice = disposable(t, 'Disposable Alice'); const bob = disposable(t, 'Disposable Bob'); const eve = disposable(t, 'Disposable Eve');
  const fixture = invoiceFixture();
  const first = await createGiftWraps(alice, bob.pubkey, fixture.invoice);
  const second = await createGiftWraps(alice, bob.pubkey, fixture.invoice);
  const unrelated = await createGiftWraps(alice, eve.pubkey, fixture.invoice);
  const one = await unwrapGift(alice, first.events[1]); const two = await unwrapGift(alice, second.events[1]); const other = await unwrapGift(alice, unrelated.events[1]);
  assert.notEqual(invoiceScopeKey(alice.pubkey, bob.pubkey, one), invoiceScopeKey(alice.pubkey, bob.pubkey, two));
  assert.throws(() => invoiceScopeKey(alice.pubkey, eve.pubkey, one), /does not belong/);
  const receipts = await createGiftWraps(bob, alice.pubkey, { type: 'receipt', paymentHash: fixture.invoice.paymentHash, preimage: fixture.preimage, invoiceId: one.id });
  const receipt = await unwrapGift(alice, receipts.events[0]);
  assert.deepEqual((await matchingReceiptInvoices(alice.pubkey, receipt, [one, two, other])).map(message => message.id), [one.id]);
  assert.deepEqual(await matchingReceiptInvoices(alice.pubkey, { ...receipt, payload: { ...receipt.payload as Extract<typeof receipt.payload, { type: 'receipt' }>, invoiceId: other.id } }, [one, two, other]), []);
  const legacy: ChatMessage = { ...receipt, payload: { type: 'receipt', paymentHash: fixture.invoice.paymentHash, preimage: fixture.preimage } };
  assert.deepEqual(await matchingReceiptInvoices(alice.pubkey, legacy, [one, two]), []);
  assert.deepEqual((await matchingReceiptInvoices(alice.pubkey, legacy, [one])).map(message => message.id), [one.id]);
  assert.deepEqual(await matchingReceiptInvoices(alice.pubkey, { ...receipt, sender: alice.pubkey, recipient: bob.pubkey }, [one]), []);
  assert.deepEqual(await matchingReceiptInvoices(alice.pubkey, { ...receipt, payload: { type: 'receipt', paymentHash: fixture.invoice.paymentHash, preimage: '00'.repeat(32), invoiceId: one.id } }, [one]), []);
});

test('published message state is monotone and conflicting duplicate facts cannot replace a message', async t => {
  const alice = disposable(t, 'Disposable Alice'); const bob = disposable(t, 'Disposable Bob');
  const wraps = await createGiftWraps(alice, bob.pubkey, { type: 'text', text: 'published once' }); const published = await unwrapGift(alice, wraps.events[1]);
  const result = mergeMessage([published], { ...published, state: 'failed', error: 'A stale acknowledgement failed.' });
  assert.equal(result[0].state, 'published'); assert.equal(result[0].error, undefined);
  assert.equal(mergeMessage(result, { ...published, recipient: disposable(t, 'Disposable Eve').pubkey })[0].recipient, bob.pubkey);
  assert.deepEqual(mergeMessage(result, { ...published, payload: { type: 'text', text: 'conflicting text' } })[0].payload, published.payload);
});

test('HTTP requests send the captured owner, expose status errors, and redact both delegated URI forms', async t => {
  const owner = disposable(t, 'Disposable HTTP owner'); const calls: RequestInit[] = [];
  replaceGlobal(t, 'fetch', async (_path: string, options: RequestInit) => { calls.push(options); return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'X-Nostr-Pubkey': owner.pubkey } }); });
  assert.deepEqual(await api('/api/chat/account', undefined, 'GET', { expectedPubkey: owner.pubkey }), { ok: true });
  assert.equal((calls[0].headers as Record<string, string>)['X-Nostr-Pubkey'], owner.pubkey);
  assert.equal(calls[0].cache, 'no-store');
  Object.assign(globalThis, { fetch: async () => new Response(JSON.stringify({ error: { code: 'STALE_REVISION', message: 'Conflict nostrwalletconnect://synthetic?secret=fixture nostr+walletconnect://synthetic?secret=fixture' } }), { status: 409 }) });
  await assert.rejects(api('/api/chat/account'), error => error instanceof ApiError && error.status === 409 && error.code === 'STALE_REVISION' && !error.message.includes('secret=fixture') && !error.message.includes('walletconnect'));
});

test('cancelled HTTP and old signer auth completions cannot issue or return a new-account operation', async t => {
  const owner = disposable(t, 'Disposable HTTP owner'); const controller = new AbortController();
  let current = true; let release!: (value: Response) => void;
  replaceGlobal(t, 'fetch', () => new Promise<Response>(resolve => { release = resolve; }));
  const pending = api('/api/chat/account', undefined, 'GET', { signal: controller.signal, expectedPubkey: owner.pubkey, isCurrent: () => current });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); release(new Response('{"ok":true}'));
  const requests: string[] = []; let releaseSignature!: (value: NostrEvent) => void; let signingStarted!: () => void;
  const started = new Promise<void>(resolve => { signingStarted = resolve; }); let requested!: EventTemplate;
  const identity: Identity = { ...owner, sign: event => { requested = structuredClone(event); signingStarted(); return new Promise(resolve => { releaseSignature = resolve; }); } };
  Object.assign(globalThis, { fetch: async (path: string) => { requests.push(path); return new Response(JSON.stringify({ user: null })); } });
  replaceGlobal(t, 'window', { location: { origin: 'https://local.invalid' } });
  const auth = authenticateWallet(identity, { expectedPubkey: owner.pubkey, isCurrent: () => current });
  await started; current = false; releaseSignature(await owner.sign(requested));
  await assert.rejects(auth, { name: 'AbortError' }); assert.deepEqual(requests, ['/api/session']);
});

test('parallel wallet authentication for one owner is deduplicated into one NIP-98 request', async t => {
  const owner = disposable(t, 'Disposable auth owner'); let sessions = 0; let posts = 0; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  replaceGlobal(t, 'window', { location: { origin: 'https://local.invalid' } });
  replaceGlobal(t, 'fetch', async (path: string, options: RequestInit) => {
    assert.equal((options.headers as Record<string, string>)['X-Nostr-Pubkey'], owner.pubkey);
    if (path === '/api/session') { sessions++; await barrier; return new Response('{"user":null}'); }
    posts++; return new Response(JSON.stringify({ user: { pubkey: owner.pubkey } }));
  });
  const guard = { expectedPubkey: owner.pubkey }; const one = authenticateWallet(owner, guard); const two = authenticateWallet(owner, guard);
  release(); await Promise.all([one, two]); assert.equal(sessions, 1); assert.equal(posts, 1);
});

test('a current auth caller recovers when the shared request belongs to a cancelled view', async t => {
  const owner = disposable(t, 'Disposable remounted auth owner');
  const oldView = new AbortController();
  let sessions = 0; let posts = 0; let release!: (value: Response) => void; let started!: () => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  replaceGlobal(t, 'window', { location: { origin: 'https://local.invalid' } });
  replaceGlobal(t, 'fetch', async (path: string, options: RequestInit) => {
    assert.equal((options.headers as Record<string, string>)['X-Nostr-Pubkey'], owner.pubkey);
    if (path === '/api/session') {
      sessions++;
      if (sessions === 1) { started(); return pending; }
      return new Response('{"user":null}');
    }
    assert.equal(path, '/api/auth/nostr'); posts++;
    return new Response(JSON.stringify({ user: { pubkey: owner.pubkey } }));
  });
  const abandoned = authenticateWallet(owner, { signal: oldView.signal, expectedPubkey: owner.pubkey });
  const cancelled = assert.rejects(abandoned, { name: 'AbortError' });
  await began;
  const current = authenticateWallet(owner, { expectedPubkey: owner.pubkey, isCurrent: () => true });
  oldView.abort(); release(new Response('{"user":null}'));
  await cancelled;
  await current;
  assert.equal(sessions, 2); assert.equal(posts, 1);
});


test('sequential same-second NIP-98 authentication has unique signed event IDs for replay protection', async t => {
  const owner = disposable(t, 'Disposable repeated auth owner'); const eventIds = new Set<string>();
  const fixed = Date.now(); t.mock.method(Date, 'now', () => fixed);
  replaceGlobal(t, 'window', { location: { origin: 'https://local.invalid' } });
  replaceGlobal(t, 'fetch', async (path: string, options: RequestInit) => {
    if (path === '/api/session') return new Response('{"user":null}');
    const authorization = (options.headers as Record<string, string>).Authorization;
    const event = JSON.parse(Buffer.from(authorization.replace(/^Nostr /, ''), 'base64').toString('utf8')) as NostrEvent;
    assert.equal(event.kind, 27235); assert.equal(freshSignatureIsValid(event), true);
    assert.equal(event.tags.filter(tag => tag[0] === 'u').length, 1); assert.equal(event.tags.find(tag => tag[0] === 'u')![1], 'https://local.invalid/api/auth/nostr');
    assert.equal(event.tags.filter(tag => tag[0] === 'method').length, 1); assert.equal(event.tags.find(tag => tag[0] === 'method')![1], 'POST');
    assert.equal(event.tags.filter(tag => tag[0] === 'payload').length, 1);
    if (eventIds.has(event.id)) return new Response('{"error":"replayed"}', { status: 401 });
    eventIds.add(event.id); return new Response(JSON.stringify({ user: { pubkey: owner.pubkey } }));
  });
  await authenticateWallet(owner); await authenticateWallet(owner);
  assert.equal(eventIds.size, 2);
});
