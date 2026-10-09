# Desktop launcher verification — 2026-10-09

## Confirmed failure

The desktop shortcut uses Windows PowerShell 5.1. Earlier checks ran under the bundled PowerShell 7 terminal runtime, including when the shell option requested Windows PowerShell.

Before the fix, invoking the actual Windows PowerShell executable to parse `start.ps1` produced 16 syntax errors. The source file was UTF-8 without BOM; interpreting its Chinese strings with the system encoding broke string delimiters before any error handler could execute. Reading local JSON with the default encoding also failed, while explicitly reading UTF-8 succeeded. The local config itself was valid UTF-8 JSON; no config values needed to be changed.

## Fix

- Save `start.ps1` as UTF-8 with BOM (`EF BB BF`).
- Read local, example, and legacy JSON with explicit `-Encoding UTF8`.
- Preserve sanitized startup errors and a visible browser-launch failure message.
- Add the encoding requirement to `.editorconfig` and `AGENTS.md`.

## Actual startup verification

1. Before testing, the local health/playlist were unavailable and there was no Node service process.
2. Run the same Windows PowerShell 5.1 executable and hidden launch arguments used by the desktop shortcut.
3. Cold start exited successfully after 103.7 seconds. One Node service process was running; health and playlist returned HTTP 200. The service error log was empty.
4. Chrome opened a tab titled `Iwara 本地播放列表` on the local playlist route.
5. Invoke the actual desktop `.lnk`. It exited successfully after 3 seconds and retained a single Node service process.
6. The Chrome browser connector confirmed a second playlist tab created by this shortcut invocation. Reading that tab showed the loaded library navigation, pagination, and 30 video cards, with the library count of 3,163.

The shortcut and service were exercised on the real computer. This verification did not perform another operating-system reboot or initiate a media transfer. Production videos, credentials, and database locations were not edited. Browser window-title checks alone are insufficient when another Chrome tab is active; the tab inventory and actual loaded page were also checked.
