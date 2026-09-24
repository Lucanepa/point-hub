# Point Hub app ↔ console contract

This is the contract between the Android tablet app (`android/`, package `ch.kscw.pointhub`) and the
console the board serves. The app is a kiosk WebView that loads the console **from the board**, so
console updates need no app update. The console's side of this contract is written against this
document. `app/src/main/java/ch/kscw/pointhub/web/PointHubBridge.kt` implements it.

## Detection

- **User-Agent.** It is WebView's default UA plus ` PointHubApp/<versionName>`, for example
  `… Chrome/126.0 Mobile Safari/537.36 PointHubApp/1.0.3`. The server can match
  `/\bPointHubApp\/(\S+)/`.
- **In the page.** Always feature-detect the bridge:
  `const app = window.PointHubApp || null`. Never infer it from the UA alone.

## App mode (read this first)

When `window.PointHubApp` exists, the console is running inside the tablet app. The console must
then behave as the installed app, whatever `display-mode` reports:

- **No full-screen / keep-awake gate.** Never show `#fsGate`. The WebView is already fullscreen and
  landscape, and element fullscreen is not supported in it, so the gate could never be satisfied.
- **No wake lock, no silent-video fallback.** The app keeps the screen on itself
  (`FLAG_KEEP_SCREEN_ON`) while it is in front. Treat keep-awake as held.
- **Use `PointHubApp.keepAwake(on)`** for the one case the console needs: `false` on a shutdown or
  "board is off" screen, `true` again afterwards.

The app also loads the console as `<origin>/?app=1`, so a console that only knows `?app=1` enters app
mode too, but `?app=1` alone still asks for a wake lock (refused on plain http and in WebView), so
the rule above is what actually removes the gate.

## Where the bridge exists

`window.PointHubApp` is registered once with `addJavascriptInterface`. It only works for pages whose
**main frame** is on a board origin. The match is exact on scheme, host and port after
normalisation: lower-case, and the default port dropped.

| Origin | Used when |
|---|---|
| `https://ledbox-c0270.noodlefish-pence.ts.net:8891` | First choice. It has a real Let's Encrypt certificate. On the board AP the board's dnsmasq resolves it to 172.24.1.1; elsewhere Tailscale MagicDNS resolves it. |
| `http://172.24.1.1:8890` | The board's own Wi-Fi AP (`ledbox_C0270`). |
| `http://192.168.5.1:8890` | The cable fallback (USB-C Ethernet). |
| the admin **override**, if set | Must be `http(s)://host[:port]`. Plain http is only allowed to the two IPs above. |

How the app enforces this:
- Every bridge call re-checks the origin the main frame has committed. A call from any other origin
  returns the **denied value**, which is `"{}"`, `"[]"`, `null` or `false` depending on the method
  (see the table), and the app logs it.
- The WebView loads nothing from any other origin. Main-frame navigations elsewhere are dropped, and
  subresource and subframe requests get an empty 403. The only exceptions are `about:blank`,
  `data:`, and `blob:` URLs of a board origin.
- Links to the outside world therefore do nothing. Do not rely on them.

## Methods

All methods are synchronous and run on the app's bridge thread. Only strings, booleans and void
cross the bridge. Parse JSON strings yourself.

| Call | Returns | Denied value | Meaning |
|---|---|---|---|
| `getInfo()` | JSON string | `"{}"` | See **getInfo** below. |
| `keepAwake(on)` | void | (nothing) | `true` keeps the screen on (the default). `false` lets it sleep, for example on a shutdown screen. `false` lasts until `keepAwake(true)` or the next app start. |
| `saveBackup(name, json)` | boolean | `false` | Saves one backup file on the tablet. See **Backups**. Returns `true` once the file is on disk. It does **not** export anything. |
| `listBackups()` | JSON string | `"[]"` | `[{"name":"20260924T181502.123Z_match-4711.json","bytes":18234,"savedAt":"2026-09-24T18:15:02.123Z"}, …]`, newest first. |
| `exportBackups()` | boolean | `false` | Opens Android's "save as" sheet with `pointhub-backups-YYYYMMDD-HHmm.zip`, starting in Downloads. Returns `true` if the sheet opened. Returns `false` if an export is already running or there are no backups. The result comes later as an `export` event. The sheet opens inside the app's task, so the tablet stays pinned. |
| `saveSchedule(json)` | boolean | `false` | Stores the offline copy of the season schedule. The app keeps exactly one copy. `json` must be an object or an array, at most 2 MB. |
| `loadSchedule()` | string or `null` | `null` | Returns the last schedule saved, or `null` if there is none. |
| `reloadConsole()` | void | (nothing) | Runs board discovery again and loads `<origin>/?app=1` fresh. Call it after the console notices that a new console build was deployed. |
| `openSettings()` | void | (nothing) | Opens the app's admin PIN prompt, then the admin menu. Volunteers still need the app's admin PIN, which is **not** the board's scorer PIN. |

Input limits (anything over them returns `false`):
- `name`: at most 80 characters. The app sanitises it to `[A-Za-z0-9._-]`, and an empty result
  becomes `backup`.
- Backup `json`: at most 5 MB. It must parse as exactly one JSON object or array.
- Schedule `json`: at most 2 MB. It must parse as exactly one JSON object or array.

### getInfo

```json
{"app":"pointhub-android","versionCode":12,"versionName":"1.0.3","device":"samsung SM-X115",
 "android":"14 (34)","origin":"http://172.24.1.1:8890","network":"wifi-bound",
 "deviceOwner":false,"lockTask":"pinned"}
```

- **Fixed keys.** The first five (`app`, `versionCode`, `versionName`, `device`, `android`) are
  stable.
- **Extras.** The remaining keys are informational. `network` is one of `wifi-bound`,
  `ethernet-bound` or `default`. `lockTask` is one of `none`, `pinned` or `locked`.

## Events from the app

The app dispatches events on `window`, and only while a board origin is committed:

```js
window.addEventListener('pointhubapp', (e) => { const d = e.detail; /* d.type … */ })
```

| `detail` | When |
|---|---|
| `{"type":"export","ok":true,"files":7}` | The zip was written. |
| `{"type":"export","ok":false,"reason":"cancelled"}` | The volunteer closed the save sheet. `reason` can also be `"io"`. |
| `{"type":"update","available":true,"versionName":"1.0.4","notes":"…"}` | A newer app is on the board. The app also shows its own strip **below** the console (it never covers it); only its "Install…" button reacts, and installing needs the admin PIN. |
| `{"type":"network","state":"lost"}` | The board network has been gone for 5 s. The console stays up and usable (it keeps recording scores); the app only shows a small, non-blocking "connection lost" note at the top. Sent once per loss. |
| `{"type":"network","state":"restored"}` | The board is reachable again **under the same origin** as the page. No reload happens. |

If the board comes back under a **different** origin (for example Wi-Fi dropped and the cable took
over), the old origin is not reachable any more: the app then reloads the console from the new
origin instead of sending `restored`. Anything the console has not yet persisted must therefore be
in `localStorage` or a `saveBackup` by then (remember that storage is per origin).

## Backups

- **Where they are stored.** Backups live in the app's private storage (`files/backups/`) as
  `<yyyyMMdd'T'HHmmss.SSS'Z'>_<name>.json`.
- **Rotation.** The app keeps at most 50 files and 20 MB, and deletes the oldest first. The newest
  file is always kept.
- **Surviving updates.** Backups survive app updates. They are lost if the app is uninstalled, so
  export them before a reinstall.
- **Export.** The zip holds `backups/*.json`, then `schedule.json` if one exists, then
  `manifest.json` (getInfo plus the backup list).

### The `summary` convention (please follow it)

When the board is unreachable, the app shows the newest backup read-only on its offline screen. The
app does not know the console's data model. To show something useful, **include a top-level
`summary` object in every backup**:

```json
{
  "summary": {"title":"Herren 2 – VBC Züri","home":"KSCW","away":"VBC Züri",
              "sets":"25:21 19:25 25:18","score":"2:1","state":"live","at":"2026-09-24T18:15:02Z"},
  "…": "the console's own backup payload"
}
```

- Every field is an optional string.
- `state` is `"live"` or `"final"` (other values are shown as they are).
- Without a `summary`, the offline screen shows only the backup's name and time.

## Things the console should know

- **Storage is per origin.** `localStorage` and IndexedDB are separate for each origin, so the
  https, AP-IP and cable-IP origins each keep their own store. The app may switch between them (for
  example when https fails because the tablet clock is wrong). Anything that must survive a switch
  belongs on the board, or in `saveBackup` / `saveSchedule`.
- **Cache.** The app clears the WebView HTTP cache once per app start. The server should still send
  `Cache-Control: no-store` for the console HTML.
- **Transient errors.** The console handles its own polling errors, and the app does not react to a
  single failed request. The app only takes over, with its offline screen, when:
  - a main-frame load fails,
  - the main frame gets a 5xx, or a 404 on `/`,
  - the WebView renderer crashed.

  Losing the board network does **not** cover a live console (see the `network` events).
- **Page lifetime.** The app never navigates away from a live console page by itself, except for
  `reloadConsole()`, recovery from the offline screen, or the board coming back under a different
  origin.
- **Dialogs.** `alert` and `confirm` work (they are native dialogs). `window.open`, file pickers,
  geolocation, camera and microphone are refused.

## Board-side endpoints the app uses

These are served by the board (the server agent's side):

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Discovery. A 200 with a JSON **object** body means "this is the board". Redirects count as failures. |
| `GET /app/version.json` | The update manifest: `{"versionCode":13,"versionName":"1.0.4","sha256":"<64 hex>","url":"/app/pointhub.apk","notes":"…","size":5234567}`. `url` must be `/app/…` or an absolute URL on the same board origin. |
| `GET /app/pointhub.apk` | The APK. Serve it as `application/vnd.android.package-archive` with `Cache-Control: no-store`. |

`android/build-release.sh` writes `dist/pointhub.apk` and `dist/version.json` in exactly this shape.
