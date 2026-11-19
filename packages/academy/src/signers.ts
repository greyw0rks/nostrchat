export type AuthEvent = { kind: number; created_at: number; tags: string[][]; content: string };
export type Signer = { signEvent(event: AuthEvent): Promise<unknown> };
export type IdentitySigner = Signer & {
  getPublicKey(): Promise<string>;
  nip44: { encrypt(pubkey: string, plaintext: string): Promise<string>; decrypt(pubkey: string, ciphertext: string): Promise<string> };
};
export type NostrProviderStatus = { connect: boolean; nip07: boolean };
export const CONNECT_INSTALL_URL = 'https://connect-wallet-vert.vercel.app/#install';

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try { return Reflect.get(value, key); } catch { return undefined; }
}

function validatedSigner(value: unknown): Signer | null {
  const signEvent = readProperty(value, 'signEvent');
  if (typeof signEvent !== 'function') return null;
  return { signEvent: event => Promise.resolve(Reflect.apply(signEvent, value, [event])) };
}

function availableSigners() {
  const target = typeof window === 'undefined' ? undefined : window;
  const provider = readProperty(target, 'connectWallet');
  const identity = readProperty(provider, 'nostr');
  const connect = readProperty(provider, 'name') === 'Connect' ? validatedSigner(identity) : null;
  const otherIdentity = readProperty(target, 'nostr');
  const nip07 = connect && otherIdentity === identity ? null : validatedSigner(otherIdentity);
  return { connect, nip07 };
}

export function nostrProviderStatus(): NostrProviderStatus {
  const providers = availableSigners();
  return { connect: Boolean(providers.connect), nip07: Boolean(providers.nip07) };
}

export function watchNostrProviders(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const events = ['connect:available', 'nostr:ready', 'webln:ready', 'focus', 'pageshow'];
  for (const event of events) window.addEventListener(event, onChange);
  const onVisible = () => { if (document.visibilityState !== 'hidden') onChange(); };
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') onChange(); }, 1000);
  return () => {
    window.clearInterval(timer);
    for (const event of events) window.removeEventListener(event, onChange);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

export function waitForSigner(signal?: AbortSignal): Promise<Signer> {
  if (signal?.aborted) return Promise.reject(new DOMException('Sign-in was cancelled.', 'AbortError'));
  const select = () => { const providers = availableSigners(); return providers.connect ?? providers.nip07; };
  const ready = select();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    let settled = false;
    let unwatch = () => {};
    const finish = (signer?: Signer, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unwatch();
      signal?.removeEventListener('abort', onAbort);
      if (signer) resolve(signer); else reject(error);
    };
    const onAbort = () => finish(undefined, new DOMException('Sign-in was cancelled.', 'AbortError'));
    const check = () => { const signer = select(); if (signer) finish(signer); };
    const timeout = window.setTimeout(() => finish(undefined, new Error('Enable a Nostr signer for this website, then retry. In Connect, unlock your wallet and choose Connections → Enable for current website.')), 1500);
    unwatch = watchNostrProviders(check);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort(); else check();
  });
}

/** Select a complete NIP-07 identity provider, including Connect's late injection. */
export function waitForIdentitySigner(signal?: AbortSignal): Promise<IdentitySigner> {
  const adapt = (value: unknown): IdentitySigner | null => {
    const signer = validatedSigner(value);
    const getPublicKey = readProperty(value, 'getPublicKey');
    const nip44 = readProperty(value, 'nip44');
    const encrypt = readProperty(nip44, 'encrypt');
    const decrypt = readProperty(nip44, 'decrypt');
    if (!signer || typeof getPublicKey !== 'function' || typeof encrypt !== 'function' || typeof decrypt !== 'function') return null;
    return {
      ...signer,
      getPublicKey: () => Promise.resolve(Reflect.apply(getPublicKey, value, [])),
      nip44: {
        encrypt: (pubkey, plaintext) => Promise.resolve(Reflect.apply(encrypt, nip44, [pubkey, plaintext])),
        decrypt: (pubkey, ciphertext) => Promise.resolve(Reflect.apply(decrypt, nip44, [pubkey, ciphertext]))
      }
    };
  };
  const select = () => {
    if (typeof window === 'undefined') return null;
    const connect = readProperty(window, 'connectWallet');
    return (readProperty(connect, 'name') === 'Connect' ? adapt(readProperty(connect, 'nostr')) : null) ?? adapt(readProperty(window, 'nostr'));
  };
  if (signal?.aborted) return Promise.reject(new DOMException('Sign-in was cancelled.', 'AbortError'));
  const ready = select();
  if (ready) return Promise.resolve(ready);
  if (typeof window === 'undefined') return Promise.reject(new Error('A browser Nostr signer is required.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let unwatch = () => {};
    const finish = (signer?: IdentitySigner, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unwatch();
      signal?.removeEventListener('abort', onAbort);
      if (signer) resolve(signer); else reject(error);
    };
    const onAbort = () => finish(undefined, new DOMException('Sign-in was cancelled.', 'AbortError'));
    const check = () => { const signer = select(); if (signer) finish(signer); };
    const timeout = window.setTimeout(() => finish(undefined, new Error('Enable a Nostr signer with NIP-44 private messaging for this website, then retry. In Connect, unlock your wallet and enable the current website.')), 1500);
    unwatch = watchNostrProviders(check);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort(); else check();
  });
}
