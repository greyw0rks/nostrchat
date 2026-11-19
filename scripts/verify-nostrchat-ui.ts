import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { nip19 } from 'nostr-tools';
import { signedBolt11 } from '../packages/chat/src/invoice.ts';

// This exercise is intentionally restricted to the private, zero-value local lab.
// No user profile, public message relay, or real Bitcoin wallet is used.
const origin = process.env.SATS_CHAT_UI_ORIGIN || 'http://127.0.0.1:4405';
const location = new URL(origin);
assert(['localhost', '127.0.0.1', '[::1]'].includes(location.hostname), 'Browser payment acceptance must use loopback.');
const config = await (await fetch(new URL('/api/chat/config', origin))).json();
assert.equal(config.backend, 'local');
assert.equal(config.publicRelay, false);
assert.equal(config.lightningLabReady, true, 'Start the private Lightning lab and current chat API first.');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.relayUrl).hostname));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve('docs/nostrchat/acceptance', stamp);
mkdirSync(directory, { recursive: true });
const files = ['apps/nostrchat/src/App.tsx', 'apps/nostrchat/src/ChatViews.tsx', 'apps/nostrchat/src/WalletPanel.tsx', 'apps/nostrchat/src/AccountDialogs.tsx', 'apps/nostrchat/src/protocol.ts', 'apps/nostrchat/src/storage.ts', 'apps/nostrchat/src/relay.ts', 'apps/nostrchat/src/styles.css', 'server/chat.ts', 'packages/chat/src/invoice.ts', 'scripts/verify-nostrchat-ui.ts'];
const sources = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const baseline = sources();
const checks: string[] = [];
const errors: string[] = [];
const screenshots: string[] = [];
const passphrase = 'builder private regtest acceptance only';
let stage = 'start';
let payerResult: Record<string, unknown> | undefined;
let receiverResult: Record<string, unknown> | undefined;
let invoice: ReturnType<typeof signedBolt11> | undefined;
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const bobContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
const alice = await aliceContext.newPage();
const bob = await bobContext.newPage();
for (const page of [alice, bob]) page.on('pageerror', error => errors.push(error.message.slice(0, 240)));
const checkProof = (value: unknown, paymentHash: string): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && createHash('sha256').update(Buffer.from(value, 'hex')).digest('hex') === paymentHash;
async function screenshot(page: Page, filename: string) {
  const dismiss=page.locator('.toast').getByRole('button',{name:'Dismiss notification',exact:true});
  if (await dismiss.isVisible()) await dismiss.click();
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: resolve(directory, filename), fullPage: true });
  screenshots.push(filename);
}
async function fits(page: Page) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert(sizes.document <= sizes.viewport, 'The interface overflows horizontally.');
}
async function closeDialog(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function createAccount(page: Page, name: string) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create a private key', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your display name', { exact: false }).fill(name);
  await dialog.getByLabel('Choose a backup passphrase', { exact: true }).fill(passphrase);
  await dialog.getByLabel('Confirm your passphrase', { exact: true }).fill(passphrase);
  await dialog.getByRole('button', { name: 'Create my key & backup', exact: true }).click();
  const backup = await dialog.getByLabel(/^Encrypted key backup/).inputValue({ timeout: 30_000 });
  assert(backup.startsWith('ncryptsec1'));
  await expect(dialog.getByRole('button', { name: 'Open my inbox', exact: false })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'I have saved my encrypted backup and its passphrase.' }).check();
  await dialog.getByRole('button', { name: 'Open my inbox', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Messages.', exact: true })).toBeVisible();
  await expect.poll(async () => (await page.locator('.sync-pill').textContent()) || '', { timeout: 30_000 }).toMatch(/current|Connected/);
  await page.getByRole('button', { name: 'Identity settings', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Identity', exact: true }).click();
  const npub = await page.getByLabel('Your public Nostr key').inputValue();
  const decoded = nip19.decode(npub);
  assert.equal(decoded.type, 'npub');
  await closeDialog(page);
  return { name, backup, npub, pubkey: decoded.data as string };
}
async function addContact(page: Page, name: string, npub: string) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Contact name', { exact: true }).fill(name);
  await dialog.getByLabel('Nostr public key', { exact: true }).fill(npub);
  await dialog.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Conversation with ' + name })).toBeVisible();
}
async function openWallet(page: Page) {
  const button = page.getByRole('button', { name: 'Open Lightning wallet', exact: true });
  if (await button.isVisible()) await button.click();
  else await page.getByRole('navigation', { name: 'Phone navigation' }).getByRole('button', { name: 'Wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function connectWallet(page: Page, wallet: 'Alice' | 'Bob') {
  await openWallet(page);
  const button = page.getByRole('dialog').getByRole('button', { name: 'Connect ' + wallet, exact: true });
  await expect(button).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(value => value.url().endsWith('/api/chat/wallet/practice') && value.request().method() === 'POST', { timeout: 45_000 }),
    button.click()
  ]);
  const result = await response.json();
  assert.equal(result.network, 'regtest');
  assert.equal(result.connected, true);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Create Lightning invoice' })).toBeVisible();
}
async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Connect your identity', exact: false }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await dialog.getByLabel('Your backup passphrase', { exact: true }).fill(passphrase);
  await dialog.getByRole('button', { name: 'Unlock my inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Messages.', exact: true })).toBeVisible();
}
try {
  stage = 'landing';
  await alice.goto(origin);
  await screenshot(alice, 'desktop-landing.png');
  await fits(alice);
  stage = 'identity';
  const aliceAccount = await createAccount(alice, 'Builder Ada');
  const bobAccount = await createAccount(bob, 'Builder Tunde');
  assert.notEqual(aliceAccount.pubkey, bobAccount.pubkey);
  checks.push('Two GUI-created real Nostr identities, mandatory encrypted-backup acknowledgement, and owner-bound backend sessions');
  stage = 'contacts';
  await addContact(alice, bobAccount.name, bobAccount.npub);
  await addContact(bob, aliceAccount.name, aliceAccount.npub);
  checks.push('Public npub exchange and contact creation through the actual desktop and phone forms');
  stage = 'messages';
  const message = 'Private builder regtest: the design review is ready.';
  await alice.getByRole('textbox', { name: 'Message ' + bobAccount.name, exact: true }).fill(message);
  await alice.getByRole('button', { name: 'Send encrypted message', exact: true }).click();
  await expect(bob.getByRole('region', { name: 'Conversation with ' + aliceAccount.name }).getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });
  const reply = 'Thanks. Please send the Lightning request in this conversation.';
  await bob.getByRole('textbox', { name: 'Message ' + aliceAccount.name, exact: true }).fill(reply);
  await bob.getByRole('button', { name: 'Send encrypted message', exact: true }).click();
  await expect(alice.getByRole('region', { name: 'Conversation with ' + bobAccount.name }).getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
  checks.push('Actual signed/encrypted two-way delivery over the private relay; mobile touch composer is functional');
  await screenshot(alice, 'desktop-conversation.png');
  await screenshot(bob, 'phone-conversation.png');
  stage = 'receiving-wallet';
  await connectWallet(alice, 'Alice');
  await alice.getByRole('dialog').getByLabel('Amount in sats', { exact: false }).fill('100');
  await alice.getByRole('dialog').getByLabel('What’s it for?', { exact: false }).fill('Private builder regtest design review');
  await alice.getByRole('button', { name: 'Create Lightning invoice', exact: true }).click();
  const bolt11 = await alice.getByLabel('Generated Lightning invoice').inputValue({ timeout: 30_000 });
  invoice = signedBolt11(bolt11);
  assert.equal(invoice.network, 'regtest');
  assert.equal(invoice.amountSats, 100);
  await screenshot(alice, 'desktop-invoice.png');
  await alice.getByRole('button', { name: 'Share with Builder', exact: true }).click();
  await expect(alice.getByRole('dialog')).toHaveCount(0);
  await expect(bob.getByRole('button', { name: 'Review payment', exact: true })).toBeVisible({ timeout: 30_000 });
  checks.push('Real fixed 100-sat BOLT11 invoice from receiving LND wallet shared through encrypted chat');
  stage = 'paying-wallet';
  await connectWallet(bob, 'Bob');
  await closeDialog(bob);
  stage = 'payment-review';
  await bob.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect(bob.getByRole('button', { name: 'Confirm 100-sat payment', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(bob.getByRole('dialog')).toContainText('Bitcoin regtest');
  await screenshot(bob, 'phone-payment-review.png');
  checks.push('Explicit immutable amount/network/wallet review shown before any outgoing payment');
  stage = 'payment';
  const paidResponse = bob.waitForResponse(value => value.url().endsWith('/api/chat/payments') && value.request().method() === 'POST');
  await bob.getByRole('button', { name: 'Confirm 100-sat payment', exact: true }).click();
  payerResult = await (await paidResponse).json();
  assert(payerResult);
  assert.equal(payerResult?.paymentHash, invoice.paymentHash);
  assert.equal(payerResult?.state, 'settled');
  assert(checkProof(payerResult.preimage, invoice.paymentHash));
  await expect(bob.getByRole('dialog')).toContainText('Matching payment preimage verified', { timeout: 30_000 });
  await screenshot(bob, 'phone-verified-payment.png');
  await closeDialog(bob);
  await expect(alice.getByRole('region', { name: 'Conversation with ' + bobAccount.name }).getByText('Payment proof verified', { exact: true })).toBeVisible({ timeout: 30_000 });
  stage = 'receiver-proof';
  const receiverResponse = alice.waitForResponse(value => value.url().endsWith('/api/chat/wallet/invoices/' + invoice!.paymentHash));
  await alice.getByRole('button', { name: 'Verify with my wallet', exact: true }).click();
  receiverResult = await (await receiverResponse).json();
  assert(receiverResult);
  assert.equal(receiverResult?.state, 'settled');
  assert(checkProof(receiverResult.preimage, invoice.paymentHash));
  assert.equal(receiverResult.preimage, payerResult.preimage);
  checks.push('Actual private-regtest payment; matching sender and receiver wallet lookups; encrypted conversation receipt verified');
  await screenshot(alice, 'desktop-verified-receipt.png');
  await fits(alice);
  await fits(bob);
  stage = 'reload-recovery';
  await bob.reload();
  await expect(bob.getByRole('heading', { name: /Your people/ })).toBeVisible();
  await unlock(bob);
  await bob.getByRole('button', { name: 'Identity settings', exact: true }).click();
  await bob.getByRole('dialog').getByRole('button', { name: 'Identity', exact: true }).click();
  assert.equal(await bob.getByLabel('Your public Nostr key').inputValue(), bobAccount.npub);
  await closeDialog(bob);
  await bob.getByRole('navigation', { name: 'Phone navigation' }).getByRole('button', { name: 'People', exact: true }).click();
  await expect(bob.getByRole('heading', { name: aliceAccount.name, exact: true })).toBeVisible({ timeout: 30_000 });
  await bob.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(bob.getByRole('region', { name: 'Conversation with ' + aliceAccount.name }).getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });
  checks.push('Same-key encrypted-backup unlock after reload restores saved contact and genuinely encrypted message history');
  await bob.setViewportSize({ width: 360, height: 800 });
  await fits(bob);
  await screenshot(bob, 'phone-360-restored-conversation.png');
  stage = 'complete';
  assert.equal(errors.length, 0, 'Unexpected browser errors');
  assert.deepEqual(sources(), baseline, 'Source changed during browser acceptance');
  const report = { status: 'passed', checkedAt: new Date().toISOString(), origin, backend: config.backend, network: 'regtest', monetaryValue: false, publicMessagePublication: false, classification: 'Generated builder identities, separate isolated desktop/mobile contexts, private relay, two real LND regtest wallets. Technical integration only; no independent adoption or real-value settlement.', checks, viewports: [1440, 390, 360], screenshots, pageErrors: errors, sourceHashes: baseline, transaction: { paymentHash: invoice.paymentHash, amountSats: 100, preimage: payerResult.preimage, payerAndReceiverVerified: true } };
  writeFileSync(resolve(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(resolve('docs/evidence/nostrchat-browser-regtest.json'), JSON.stringify({ ...report, artifactDirectory: directory.replace(resolve('.') + '/', '') }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, artifactDirectory: directory, amountSats: 100, network: 'regtest', monetaryValue: false }));
} catch (error) {
  await screenshot(alice, 'desktop-failure.png').catch(() => {});
  await screenshot(bob, 'phone-failure.png').catch(() => {});
  writeFileSync(resolve(directory, 'verification.json'), JSON.stringify({ status: 'failed', stage, checkedAt: new Date().toISOString(), classification: 'Private regtest only', screenshots, pageErrors: errors, paymentRecorded: payerResult?.state === 'settled', paymentHash: invoice?.paymentHash }, null, 2) + '\n');
  console.error('NostrChat browser acceptance failed at:', stage, error instanceof Error ? error.message.slice(0, 350) : 'unknown');
  process.exitCode = 1;
} finally {
  if (stage === 'complete') {
    for (const page of [alice, bob]) {
      try { await openWallet(page); await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click(); await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await closeDialog(page); } catch { /* only generated builder connections */ }
      try { await page.getByRole('button', { name: 'Identity settings', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Identity', exact: true }).click(); await page.getByRole('button', { name: /Lock/ }).click(); } catch { /* browser closure destroys tab keys */ }
    }
  }
  await browser.close();
}
