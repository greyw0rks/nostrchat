# NostrChat submission media review

Status: accepted, 2026-11-19. All seven final outputs passed direct agent inspection.

Codex directly inspected all seven final exported 1500 × 1000 PNGs at full resolution with `view_image`. This records agent review, not human approval. No app interaction, render, wallet action or publication was performed by the reviewer. The release agent repaired the thumbnail spacing and dismissed the actual payment-review notification through the product control before capturing a fresh complete run; the reviewer inspected every refreshed output.

All seven files are PNGs, have the recommended 3:2 ratio, and are below 5 MB. The one thumbnail and six gallery images total **694,711 bytes**. Their bytes and SHA-256 hashes match the manifest, and every source capture hash matches the same passing builder run at `docs/nostrchat/acceptance/2026-11-19T09-06-00-207Z`. The source report agrees with `docs/evidence/nostrchat-browser-regtest.json`: 100 sats, private regtest, no monetary value, matching payer and receiver verification, and no public message publication. The retained payment preimage hashes to the recorded payment hash. The accepted output and capture hashes are recorded in `MEDIA-MANIFEST.json`.

| Image | Visual result |
| --- | --- |
| `00-thumbnail.png` | Accepted: both headline lines, the complete subtitle and actual landing capture fit. The screenshot frame begins below the subtitle and retains the footer margin. |
| `01-private-messages.png` | Accepted: title, subtitle, desktop conversation and both disclosure lines fit. The displayed messages belong to generated builder identities and the private relay. |
| `02-invoice.png` | Accepted: request amount 100, invoice QR and private-regtest description visible; screenshot and authored text remain contained. |
| `03-payment-review.png` | Accepted: amount 100, Bitcoin regtest network, Sats Lab Bob paying wallet, identity binding and the complete **Confirm 100-sat payment** button are readable. No notification obscures the review or confirmation controls. |
| `04-verified-receipt.png` | Accepted: actual 100-sat paid invoice and matching conversation proof visible; header and disclosures fit. |
| `05-phone-messages.png` | Accepted: actual phone conversation, composer and bottom navigation fit; private-regtest exercise and no-value labels readable. |
| `06-recovery.png` | Accepted: actual same-key restored contact/history, 100-sat receipt and verified preimage status visible. The backup itself and its password are not shown. |

No blank capture or exported composition clipping/overlap was found. The source screenshots are embedded intact with uniform scaling. Titles, subtitles and the important amount/network review fit. Every image shows readable generated-builder/private-relay and no-value regtest disclosure. No private key, delegated NWC credential, backup content or password is visible in the seven images. Public identity snippets, invoice QR and payment hash are ordinary displayed public/payment data. The recovery capture shows restored history and the verified receipt, without exposing its encrypted backup or unlocking password.

Final acceptance is recorded against the inspected output hashes in the manifest. This is technical submission-media review of a generated-builder private-regtest integration, with no independent learner/adoption or monetary-value settlement claim. Any later rerender changes the reviewed hashes and requires a new visual inspection.
