# Iwara Queue Project Context

Last reviewed: 2026-10-09. This is the short handoff note for a fresh Codex task; it is not a substitute for checking the current worktree or dated test reports.

## What this project is

The repository combines a Windows local ledger/download service, a browser playlist/player, a Tampermonkey script that resolves Iwara video metadata and submits work, and the Iwara Android app (`android/`). Han1meViewer is a separate Android project and repository. The apps remain separate; they coordinate through the local service and a shared transfer contract.

The desktop SQLite ledger is the central catalog for computer-side media and playback. The phone apps keep their own Room databases and file permissions. Do not treat any one database as a replacement for the others.

## Important files

- `src/main.mjs` — configuration, service initialization, component wiring, startup/shutdown.
- `src/server.mjs` — HTTP routes, playlist/player pages, mobile and browser APIs.
- `src/scheduler.mjs` — queue state, leases, resolver results, retry and download scheduling.
- `src/han1me-importer.mjs`, `src/han1me-archive.mjs` — Han folder import and archive receive flow.
- `src/storage-config-manager.mjs`, `src/storage-repositories.mjs`, `src/storage-transfer-store.mjs` — repository roles/configuration and persistent transfer records (verify current files/status before assuming they are committed).
- `IwaraResilientQueue.user.js` — browser-side parsing/resolver workers; server leases cannot cancel a browser request that never settles.
- `android/` — Iwara Android local library, scanning, playback, and computer-to-phone batch receive.
- `docs/media-storage-sync-contract.md` — detailed cross-app protocol, storage roles, compatibility requirements, and acceptance gaps.
- `README.md` — quick setup overview; some feature/version details may lag the implementation.

## Data model and transfer rules

Keep these facts distinct:

1. **Download history**: a source item was downloaded before; useful for duplicate prevention.
2. **File inventory**: a particular file currently exists in a repository or phone URI, with size and (when verified) full SHA-256.
3. **Ledger/import state**: metadata and media have been committed and are available to the playlist.

The shared identity is `source + sourceId`; a content hash identifies bytes. One source ID may have multiple qualities/files, and an ID-only match is not enough to confirm an archive. Preserve existing task/video IDs and playback state. A transfer may be considered complete only at the level the receiver actually confirmed; do not permit phone cleanup based only on a legacy ID list.

The intended computer-side storage roles are configurable: Iwara download targets and scan/serve locations, plus Han receive and historical scan locations. Real absolute paths, drive letters, secrets, and tokens are local configuration, not repository defaults. Read the local config only when necessary and never echo its sensitive values.

The shared contract preserves old v1 endpoints/formats while new clients use persistent transfer/batch IDs and per-file size/SHA-256 receipts. Keep v1 response meaning stable. See the contract for endpoint details, state transitions, client ownership, and migration rules.

## User-verified behavior and limits

- The user reported a small end-to-end smoke test where Han1meViewer files reached the computer ledger, Iwara App and browser-LAN downloads succeeded for test items, the videos appeared in the playlist, and the app synchronized their IDs. This is a user-reported small-sample success, not proof of large-volume reliability.
- The dated contract reports service and isolated-emulator/HTTP tests passing for the cases listed there. It explicitly does **not** establish cumulative transfers over 5 GiB, real E/J/F disk-capacity contention, real-phone SAF authorization, or 400-card list performance. Recheck the contract and test artifacts before claiming those gates have passed.
- Most recent parsing diagnosis (2026-10-09): `gmFetch()` uses `GM_xmlhttpRequest` callbacks but does not set a request timeout. A stalled upstream request can leave a resolver Promise and one of the three browser workers occupied; the server's 120-second lease can requeue the task but does not cancel the browser request. The exact upstream trigger was not established, no permanent video failure was proven, and this code fix was still pending at the time of diagnosis.
- Desktop launch entry is intended to start `启动稳定下载.cmd`, whose `start.ps1` waits for service health and then opens `/playlist`. On 2026-10-09 the service took about a minute to become healthy in a launch check; `/playlist` then returned HTTP 200. Recheck current runtime before relying on this snapshot.

## Handoff checkpoint

At the last repository inspection on 2026-10-09, the working tree contained substantial uncommitted service, test, and Android changes. `docs/media-storage-sync-contract.md` and several implementation files were untracked; `config.json.previous` was also untracked and must not be committed. **Inspect `git status` and review each path before any commit or push.** No commit or GitHub upload was made as part of creating this context note.

## Safe first steps in a new task

1. Read this file and `AGENTS.md`, then check `git status` and the current service/client versions.
2. For sync changes, read the shared contract and confirm which side owns the files being changed. Do not edit the separate Han1meViewer checkout from this repo.
3. Use isolated fixtures for tests; preserve production media, databases, app data, and credentials.
4. Report exactly what was verified: unit/source, isolated HTTP/emulator, real phone, or production. These are different evidence levels.
