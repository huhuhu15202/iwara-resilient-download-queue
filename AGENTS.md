# Iwara Queue Project Instructions

## Start here

- For project orientation, read `docs/PROJECT_CONTEXT.md`.
- For cross-device storage, archive, and transfer work, also read `docs/media-storage-sync-contract.md` and the relevant dated validation report.
- Treat the source tree and tests as the current implementation; dated docs describe the state when they were written and can become stale.

## Scope and ownership

- This repository owns the Windows Node.js ledger/queue service, browser playlist/player, Tampermonkey resolver, and the Iwara Android client under `android/`.
- Han1meViewer is a separate client project. Coordinate through the shared media-sync contract; do not modify its checkout from this repository unless the user explicitly asks.
- Keep the desktop service, Iwara Android app, and Han1meViewer as separate apps with compatible shared protocols; do not merge their databases.

## Data and privacy safeguards

- Preserve existing user edits. Inspect `git status` before work and do not reset, clean, overwrite, or revert unrelated changes.
- Never move/delete production videos, databases, backups, or phone media as part of ordinary testing. Use synthetic fixtures and isolated databases. For production data changes, make a verified backup and obtain explicit authorization for the exact operation.
- Do not commit, print, or share `config.json`, local config backups, tokens, signed links, Tailscale/LAN addresses, logs containing credentials, signing keys, or APK/build outputs. `config.json` and machine-specific paths belong to the local machine.
- Do not expose the service to the public internet. Preserve the existing authentication and private-network boundary.
- Do not restart the production service or initiate real uploads/downloads unless the user asks for that operational action.

## Implementation and verification

- Keep legacy v1 clients and response fields compatible when changing sync APIs; update the shared contract before changing protocol meaning.
- Distinguish download history, current file inventory, and completed ledger/import state. A matching ID alone is not proof that a file is present or safely archived.
- For transfers, use stable task/batch IDs and verify actual file length and SHA-256 before claiming success or allowing cleanup.
- Run `npm test` for service changes. Run `npm run test:engine` only when its configured local engine/data environment is safe; use isolated Android tests for client changes. Report source checks, emulator tests, real-device tests, and production tests separately.
- Do not claim large-volume or real-device behavior from synthetic tests. The user must confirm real-phone playback/SAF when hardware-only behavior is involved.
