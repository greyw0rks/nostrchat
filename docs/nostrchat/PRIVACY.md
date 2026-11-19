# NostrChat privacy notes

NostrChat is an open-source private messenger with a trusted Lightning wallet backend. This document describes the current implementation, not a promise of anonymity.

## On your device

LocalStorage holds public contact information, the private display name you choose, your NIP-49 encrypted key backup when saved, and encrypted message/outbox/recovery data. Unencrypted local secret keys and backup passphrases stay in tab memory. NIP-07 signers keep their keys in their own runtime. Locking closes the message connection and destroys the application's active local identity.

An encrypted key backup remains sensitive: a weak passphrase can be guessed. Protect the backup and passphrase separately. Device exports may include contact names and public keys. Review exports before sharing them. A payment preimage is proof, not a wallet private key.

## At the message relay

Messages are NIP-44 encrypted and enclosed in signed NIP-59 gift wraps before publication. The selected relay receives ciphertext and public recipient tags. It can observe subscriptions, connection IP addresses, timing, and data size. Relay acknowledgements do not establish message reading or durable availability. Different relay operators have their own policies.

Both participants need the same chosen relay in this release. Clearing a device or cloud cache does not remove copies already held by a peer or relay.

## At the application backend

Convex authenticates signed Nostr identities through an HttpOnly session cookie. It stores account public keys, encrypted profiles, encrypted outbox data, signed encrypted message envelopes, and owner-bound payment/invoice records. Payment records include invoice, sats, payment hash, settlement proof/time, and wallet reference. They are readable only through authenticated owner checks.

The server receives a delegated NWC connection through the wallet connection endpoint. It encrypts that connection using AES-GCM with product/owner binding and opens it only in trusted wallet actions. This credential authorizes the capabilities you granted at the wallet provider. Restrict capabilities and set a provider-enforced spending budget. The app never asks for a Bitcoin seed phrase.

Application history/outbox clearing removes that account's corresponding backend records. Verified or unresolved payment attempts are retained for receipts and reconciliation. Disconnecting a wallet removes its delegated connection but retains payment evidence. Hosting providers can retain operational metadata and backups according to their policies.

## At your Lightning provider

The connected provider sees wallet commands, invoice/payment information, and its Nostr relay traffic. It controls wallet availability, supported permissions, network fees, and its custody model. An NWC connection is not a new Bitcoin custody system.

## Controls and contact

Use Settings to export encrypted history, change the chosen relay, clear device/cloud caches, back up a local key, and lock the account. Use Wallet to disconnect. Revoke the delegated connection directly at your wallet provider to remove its authority.

No analytics SDK, advertising, social trackers, or externally hosted fonts are included. Report a product issue through [the source repository](https://github.com/greyw0rks/nostrchat/issues), with sanitized screenshots and no secret key, NWC URI, encrypted backup, or passphrase. For sensitive security findings, follow the repository's security policy rather than publishing credentials in an issue.
