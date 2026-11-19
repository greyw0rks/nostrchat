# Three-minute NostrChat demo

## 0:00–0:25 — Problem and product

“A freelance designer agrees on work in one app, sends a payment request in another, and comes back to explain what was paid. NostrChat keeps the private conversation, Lightning request, and verified receipt together.”

Show the actual landing page and enter the product. Identify generated builder accounts and private-regtest sats clearly; these are not independent users or real-value money.

## 0:25–1:05 — Real private messaging

In separate browser contexts, open two Nostr identities, exchange public npubs, and send a short message. Show the sender acknowledgement and recipient's actual decrypted message. Explain that NIP-44/NIP-59 protect text, while relay connection metadata remains observable.

Show the encrypted local-key backup or Connect signer flow without displaying a secret, NWC URI, or backup passphrase.

## 1:05–2:05 — Real Lightning workflow

Connect separate receiving and paying NWC wallets. The demo uses two controlled LND wallets on Bitcoin regtest; all sats have no monetary value.

Generate a fixed-amount invoice from the receiver and share it privately. On the payer, show the reviewed amount, network, wallet reference, and deliberate confirmation. Then show the verified paid state and encrypted receipt. The receiver checks the invoice through its own wallet.

The retained API run is **100 sats** with matching payer and receiver preimages. Use the amount in the actual filmed browser run if it differs. Each proof is tied to its own payment hash; never combine separate runs or label fixtures as settlement.

## 2:05–2:35 — Recovery and phone use

Show the 360px conversation and payment activity. Explain that an unknown outcome offers a status check against the original wallet, not an automatic repeat payment. Lock and reopen the same identity with its encrypted backup to demonstrate real history recovery.

Mention the server's encrypted delegated NWC connection and provider-enforced spending limits. Application confirmation does not make the backend a multisignature wallet.

## 2:35–3:00 — Impact and next iteration

“We are targeting freelancers and small teams who already discuss work and need to settle small payments. Next we will measure first-message success, invoice-to-payment time, and recovery with independent users on weak connections.”

Point to the public app, open-source code, privacy notes, and one-command private lab. Relay discovery/redundancy and independent usability/security review are next.

## Submission media

Use actual desktop/mobile captures, the declared network, and the corresponding verified payment hash. The user owns final video rendering/export and will add the YouTube or Vimeo URL at submission. A script or editable recording is not a public demo URL. Preserve the final Devpost project URL and submission confirmation after submitting.
