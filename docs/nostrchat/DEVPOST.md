# NostrChat · Devpost fields

## Project name

NostrChat

## Elevator pitch

Keep private conversations, Lightning invoices and verified payment receipts together, with a Nostr identity and your own receiving or paying wallet.

## About the project

## Inspiration

A freelancer agrees on work in one app, requests payment in another, and returns to explain what was paid. NostrChat keeps the private conversation, request and verified receipt in the same context.

## What it does

Create a Nostr key with an encrypted backup, or connect a compatible signer. Exchange encrypted one-to-one messages, manage contacts and search conversations. The sender retains an encrypted copy, and saved history can be restored with the same identity.

Connect a restricted NWC wallet, create a fixed-amount Lightning invoice and share it privately. The payer reviews the amount, Bitcoin network and wallet before explicit confirmation. A paid state requires matching wallet proof; the receiver can independently check its own invoice. The verified receipt returns as an encrypted conversation message.

Lock and reopen the account, restore contacts and encrypted history, or export records. An uncertain payment offers a status check against the original wallet and is never automatically paid again.

## How we built it

React, TypeScript and Vite power a responsive interface with local Manrope fonts. NIP-17, NIP-44 and NIP-59 protect message text; NIP-49 protects the local backup, and NIP-98 authenticates the account. Convex stores owner-bound encrypted profiles, history, outbox and payment records. NWC/NIP-47 supplies delegated wallet access. The complete local lab uses a private relay, Bitcoin Core and two LND regtest wallets.

## Challenges and what we learned

Async signer and wallet operations need identity checks before and after completion. A closed view must not cancel a new view's legitimate authentication. Payment review binds the invoice, amount, owner, network and wallet version; atomic claims and durable unknown states prevent duplicate sends. A relay acknowledgement confirms publication, not delivery or reading.

## Verified result

The standalone source passes its build, full TypeScript checks and automated protocol/backend suites. The actual desktop/phone browser exercise completed 7 checks: generated identities and mandatory backups, two-way encrypted delivery, a real 100-sat private LND regtest payment, matching payer and receiver proof, an encrypted receipt, and same-key history recovery at 1440, 390 and 360 pixels. These are builder-controlled engineering checks. Test sats have no monetary value; independent adoption and mainnet settlement are unmeasured.

## What's next

Test with independent freelancers on phones and weak connections. Measure first-message completion, invoice-to-payment time and uncertain-payment recovery. Add relay discovery and redundancy, then obtain an independent review of signer and delegated-wallet handling.

## Built with

React, TypeScript, Vite, Convex, Nostr, NIP-17, NIP-44, NIP-59, NIP-49, Nostr Wallet Connect, Lightning Network, LND, Bitcoin Core, Node.js, SQLite, CSS, Manrope, Playwright

## Try it out

https://nostrchat-greyw0rks.vercel.app/
https://github.com/greyw0rks/nostrchat

## Video demo URL

Render/export, upload to YouTube or Vimeo, and enter the actual URL.

## Additional information

Verification used generated builder identities, a private relay and two LND regtest wallets. Regtest sats have no monetary value. Relay recipient tags, connections and timing remain observable; encryption does not provide metadata anonymity or forward secrecy. The trusted backend holds an encrypted delegated NWC credential: use provider-enforced budgets and narrow permissions. Independent adoption and an independent security audit are unmeasured. The user will supply the final public demo-video URL and submission confirmation.

## Upload a file

nostrchat-devpost.zip

