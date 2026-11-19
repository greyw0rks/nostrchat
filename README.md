# NostrChat

Private conversations and verified Lightning payments in one place.

[Open NostrChat](https://nostrchat-greyw0rks.vercel.app/) · [Source](https://github.com/greyw0rks/nostrchat)

Create a Nostr identity with an encrypted backup, or connect a compatible signer. Exchange encrypted one-to-one messages, share a Lightning invoice, review its amount and network, and retain a verified payment receipt in the conversation.

The app supports contacts, search, encrypted history, account lock and restore, wallet permissions, deliberate payment confirmation and recovery after uncertain results. A relay acknowledgement records publication; settlement requires matching wallet proof.

Run the complete private messaging and Lightning lab on Linux x64 with Node.js 22.12+ and pnpm:

```sh
./start.sh
```

Open http://127.0.0.1:4405. The lab uses a private relay and two LND regtest wallets. Regtest sats have no monetary value.

NostrChat has its own repository, public site and submission. The release builds only its interface. Production uses Convex for owner-bound encrypted records and a selected WSS relay for messages.

Read the [product guide](docs/nostrchat/README.md), [privacy notes](docs/nostrchat/PRIVACY.md), [security notes](docs/nostrchat/SECURITY.md) and [demo outline](docs/nostrchat/PITCH.md).

Retained evidence comes from generated builder identities and private regtest. Independent adoption and an independent security audit are unmeasured.

Submission copy is in [DEVPOST.md](docs/nostrchat/DEVPOST.md). The local `submission` shortcut opens the upload kit.
