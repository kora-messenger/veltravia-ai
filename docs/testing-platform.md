# Testing platform: web app and Android APK

Step 36 makes Veltravia usable away from a terminal. There are two ways to try it:

1. **The web app** — the existing React application, served normally.
2. **The Android APK** — the same bundle, packaged with Capacitor, built in CI.

Nothing about the backend changed. The mobile app is a client for the API that
already exists; it does not re-implement or embed the backend.

## The APK is the web app

`apps/mobile` is a Capacitor wrapper around `apps/web/dist`. There is one frontend,
one set of screens and one design system, so a change shipped to the browser is the
change shipped to the phone. The wrapper adds only:

- an application id (`com.veltravia.ai`, plus `com.veltravia.ai.debug` for test builds
  so a test APK installs beside a real one),
- the `INTERNET` permission and nothing else,
- an https WebView origin, with mixed content refused and cleartext traffic blocked,
- backup disabled, so no chat or project data is copied off the device,
- launcher icons, adaptive icon and splash generated from the existing brand asset.

Capacitor configuration lives in `apps/mobile/capacitor.config.ts`.

## What the phone screens look like

The phone is a different presentation of the same screens, not a different app.
At phone width the chat keeps one column: the greeting sits above the composer
rather than beside it, the two entry points are rows, the run line keeps its
single-line summary with the steps behind one toggle, and navigation and the top
bar surface arrive as overlays instead of columns.

`docs/qa/phone-sheet-a.png` shows a new conversation, a finished run and one step
opened onto its command and output; `docs/qa/phone-sheet-b.png` shows the top bar
surface and the navigation drawer. Both are captured at 390 x 844 with a device
pixel ratio of 3 and the `Capacitor` global present, which is how the bundled app
knows it is packaged. The run in those captures is a recorded fixture: the
simulated provider performs real orchestration but no model work, so a live
simulated run produces a single `Thinking` row.

## How the app finds the backend

The bundle deliberately carries no build-time environment: a packaged application
cannot be reconfigured after it is built, and a build-time secret would be readable
by anyone who unzips the APK.

Instead the app reads a small public file, `runtime-config.json`, served next to
`index.html`:

```json
{ "apiBaseUrl": "https://api.example.com" }
```

- An **empty string** means same-origin: correct for the browser, and the honest
  default when nobody has said where the API lives.
- The value must be **https** (loopback is allowed for local development). Anything
  else is refused rather than quietly downgraded.
- `scripts/write-runtime-config.mjs` writes the file; `--api-base-url` on
  `npm run build:web:apk` passes it through.

The config holds one key and only one key: a base URL. It is not a general-purpose
settings file, and no credential may ever be added to it — a test fails if the shape
changes.

## What the app does with no backend

A packaged build with no `apiBaseUrl` is a real state, not an error screen:

- the app renders normally and says plainly that no backend is configured,
- every network action fails with a visible message instead of a spinner that never
  resolves,
- going offline shows an offline notice, and the notice clears when the connection
  returns.

This is deliberate. A phone app that silently pretends to work is worse than one that
tells you what is missing.

## Building it

CI builds the APK on every push ([`.github/workflows/android.yml`](../.github/workflows/android.yml)):

1. install dependencies, `npm run build` (all workspace packages, then the web app),
2. `npx cap sync android`,
3. **scan the synced bundle** for provider credential shapes and for a malformed
   `runtime-config.json`, failing the run if anything is found,
4. set up Java 21 and use the runner's preinstalled Android SDK,
5. build the debug APK, and the release APK when a keystore is configured,
6. upload both as artifacts and write a summary stating whether the build is signed
   and whether a backend URL was used.

Local equivalent:

```bash
npm run build
cd apps/mobile && npx cap sync android
cd android && ./gradlew assembleDebug     # needs a local JDK + Android SDK
```

### Release signing

Signing material is never in the repository. The workflow reads
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` from repository secrets, decodes the keystore into the
runner's temp directory (never the workspace, so it cannot be packaged with the
artifacts), and only then signs.

With no keystore the release APK is built **unsigned** and the job says so. An
unsigned release APK cannot be installed; it exists so the release configuration is
compiled on every push rather than discovered at release time.

## Known gaps

These are real and should not be described otherwise:

- **No hosted backend.** Until an API URL exists, the APK installs and shows the
  not-configured notice. Nothing in this step creates hosting.
- **The APK is a client, not an offline app.** There is no local database, no offline
  queue and no background sync. Offline, the app tells you it is offline.
- **No Play Store distribution.** Artifacts come from the workflow, and installing
  one means sideloading it.
- **No device-farm testing.** Correctness is checked by unit tests, the CI build, and
  the viewport checks below; nobody has run the APK on physical hardware in this
  step, so platform-level bugs (WebView version differences, keyboard behaviour) are
  still possible.
- **The backend itself needs its own credentials** (`VELTRAVIA_CREDENTIAL_KEY`, the
  provider keys). Those live on the server and are never part of the app.

## What is verified

- Unit tests (`tests/testing-platform-android.test.ts`) pin the packaging contract:
  application ids, https-only configuration, no credential in any source that reaches
  the bundle, no `secrets` context read from a step condition, the workflow's build
  order, and the honest reporting of an unsigned release.
- **CI run [41407417931](https://github.com/kora-messenger/veltravia-ai/actions/runs/41407417931)**
  is green: lint, the full Vitest suite, and the production build.
- **Android run [41407417928](https://github.com/kora-messenger/veltravia-ai/actions/runs/41407417928)**
  is green: the packaged bundle scan passed and the debug APK was built and uploaded
  (4.4 MB artifact, 4.8 MB APK, 449 entries, `AndroidManifest.xml`, `classes.dex`,
  `resources.arsc` and 20 bundled web files including a public-only
  `runtime-config.json`).
- The built bundle was loaded at 1440×900, 900×800 and 390×844: no horizontal
  overflow at any width, navigation present, and the same shell in each.

## Still to do before this is a product

- A deployed API URL, so the mobile build can do anything.
- A physical-device pass on the APK (install, launch, keypad behaviour, rotation).
- Deciding whether the app is distributed through the Play Store or sideloaded, which
  determines the signing and update story.
