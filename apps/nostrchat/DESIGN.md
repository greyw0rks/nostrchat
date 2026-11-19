# NostrChat design system

NostrChat is a personal place for private conversations and the Lightning payments that belong in them. The direction is warm stationery: paper, deep teal, coral, generous typography, and precise messaging controls. Its original SVG envelopes and coral Lightning mark give the welcome screen an identity without sample conversations or external imagery.

## Color

- Warm paper #fbfaf6 is the page and welcome canvas.
- White #ffffff carries the inbox, incoming messages, and forms.
- Deep teal #1a5c50 and #154a41 carry the brand and primary actions.
- Ink #233e36 is the main text color.
- Soft mint #e4efe6 and #f2f6ef distinguish outgoing messages and private context.
- Coral #d8876b accents the mark and original illustration. Dark coral #b9664d gives the welcome headline its human detail.
- Muted #5d7066 keeps supporting content readable.
- Thin borders #dde5da define flat surfaces.
- Focus #ac593f is a visible three-pixel outline. Errors use #91402d; unresolved payments use amber with a written state.

States always have a label or icon as well as color. A green relay dot reflects an actual WebSocket connection. A paid invoice requires a matching cryptographic payment preimage from a verified wallet result or an authenticated, correctly scoped receipt.

## Typography

Locally bundled Manrope Variable is the product font. Weight, spacing, and a compact type scale give messages and forms priority. A single Georgia italic line on the welcome screen provides a stationery detail. Public keys and invoice hashes use the browser monospace stack. Message content preserves line breaks and wraps long words without widening the page.

## Layout

Desktop navigation is horizontal: the wordmark, Messages, People, Activity, relay state, wallet, and identity. Messages use an inbox/thread grid inside the page content. The conversation list is message content, with search and invoice filtering; there is no persistent navigation rail or contact detail sidebar.

Phones have a horizontal top bar and five labeled bottom controls: Messages, People, Activity, Wallet, and Settings. The inbox and selected thread become separate screens. The thread has a 44px back button. The phone keyboard reduces the usable viewport and hides the bottom navigation while open. Layouts support 360px, 390px, tablet, and wide desktop widths.

People uses a responsive contact grid. Activity uses a compact invoice list that becomes stacked rows on phones. The wallet is a temporary modal drawer with the same focus trap as other dialogs.

## Components and real states

- Initials are local, with five pastel contact colors. Profile names and notes stay private to the browser or an owner-encrypted backup.
- The initial welcome page explains identity, messages, and payments, with working Connect, create-key, and help actions.
- Local key setup requires a passphrase and explicit encrypted-backup acknowledgement before opening the inbox. NIP-49 backups can be restored or unlocked.
- Inbox search operates only on the browser's decrypted content. Empty searches, no contacts, no invoices, encrypted-history loading, offline relay, declined subscription, and sync conflicts have useful recovery controls.
- Outgoing messages distinguish Publishing, Published, and Not published. Published describes a relay acknowledgement; it does not imply that the recipient read the message.
- Failed publication retains an immutable encrypted retry bundle. Retry reuses the original wrapped events. A queued bundle is archived only after its sender envelope is safely cached.
- Invoice cards show the fixed amount, purpose, expiry, and verification source. Payment review captures the original identity, peer, invoice, and paying wallet. Interrupted results lead to status-only reconciliation.
- Activity uses actual decrypted invoice messages and verified payment state. It contains no adoption counts, sample payments, or decorative metrics.
- The wallet shows actual balance availability, delegated permissions, invoice creation, QR/text sharing, explicit review, and disconnect. Local regtest connection controls are conditional on a local lab configuration and say that practice sats have no monetary value.
- Settings includes relay selection, a private display name, public-key copy, encrypted backup, history/contact import and export, and deliberate device-data clearing.
- Convex account, history, and outbox sync receive ciphertext or validated encrypted gift wraps. Keys, wallet URIs, drafts, message text, and plaintext contact profiles are never sent as account data.

## Accessibility and motion

Every icon control has a name; primary navigation is labeled. Dialogs trap focus, restore it on close, and support Escape, except while a confirmed payment is being processed. Background content is inert while a modal is open. Inputs have persistent labels, errors announce themselves, and loading/notification states use polite status feedback.

Primary touch controls are at least 44px. Focus, hover, active, and disabled styles remain visible. Motion is limited to short color transitions, a loading spinner, and conversation scrolling. Reduced-motion preferences remove animation and smooth scrolling.
