# Iwara Local Android 0.3.4 QA

## Included

- Opening a video starts playback automatically. ExoPlayer pauses when audio becomes noisy and routes from headphones to the speaker.
- Fullscreen controls include previous/next and touch lock. Buffering shows a loading indicator; playback errors remain visible with retry and next-item actions.
- The player can explicitly enter Android Picture-in-Picture. Returning from PiP restores the player page; leaving the player page stops playback.
- Selecting the author opens a locally filtered author library. Selecting a video creates a queue from that author's videos. Returning through the author page restores the original queue item and position in a paused state.
- The playback queue is an independent vertical scroller, loads adjacent batches, and keeps no more than 56 card views.

## Validation

- Personal Release and Android instrumentation APK build succeeded; Release `lintVital` succeeded.
- All 12 Android 35 emulator instrumentation tests passed on the final build, including autoplay, the noisy-audio event, persistent failure/retry/skip, fullscreen navigation, touch lock, PiP entry/return, author-only queueing, restoration of the prior queue position, portrait/landscape, gestures, and the bounded scroll window.
- The full Node service suite passed 124/124. After updating the APK download route, the focused server suite passed 11/11.
- Screenshots were reviewed for the author library, author-page return, fullscreen player, and system PiP.
- `apksigner` verified the delivered APK with v2 signing. Its certificate SHA-256 matches 0.3.3, so it can update that installation without uninstalling.
- This is emulator validation; a physical Android phone and OEM-specific PiP settings still need a brief real-device check.

## Artifact

- Version: 0.3.4, versionCode 9, personal build.
- Size: 4,405,597 bytes.
- SHA-256: `618A7B163DF920F6DF7744959184403E73C24C5528F13843580BE1EF848FD31D`.
- APK: `output/IwaraLocal-0.3.4.apk`.
