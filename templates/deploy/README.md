# Deploying an `@ekrooh/bare` app to the app stores

Ships the Android and iOS reference apps from GitHub Actions. One workflow per
platform, both dispatch-only: a human clicks **Run workflow** and picks a target.

| Workflow                 | Target       | Ships to                      |
| ------------------------ | ------------ | ----------------------------- |
| `android-play-store.yml` | `internal`   | Google Play internal testing  |
| `android-play-store.yml` | `production` | Google Play production        |
| `ios-app-store.yml`      | `testflight` | TestFlight (internal testers) |
| `ios-app-store.yml`      | `appstore`   | App Store review submission   |

The security boundary is **GitHub environments**, not the workflow files.
Anyone with write access can dispatch a workflow from a branch where they
edited it, so a check inside the file (an allowlist of usernames) cannot gate
anything. Every secret therefore lives in an environment whose deployment
policy allows only the default branch:

| Environment       | Holds                                                         | Reviewers |
| ----------------- | ------------------------------------------------------------- | --------- |
| `android-signing` | the upload keystore                                           | none      |
| `internal`        | a Play service account limited to testing tracks              | none      |
| `production`      | a Play service account with production rights / the App Store | required  |
| `ios-signing`     | `match` access for read-only certificate sync                 | none      |
| `testflight`      | an App Store Connect API key for TestFlight uploads           | none      |

Production and App Store submission wait for the `production` environment's
required reviewers. Do not store these secrets at repository level: any
workflow on any branch could read them. Actions are pinned to full commit
SHAs and dependencies install with `--ignore-scripts`; keep both when you edit
the files.

Costs: fastlane is free (MIT). Apple $99/yr, Google one-time $25.

## Files

```
templates/deploy/
├── android-play-store.yml   → .github/workflows/
├── ios-app-store.yml        → .github/workflows/
├── fastlane/                → <repo>/fastlane/
└── README.md
```

## Setup

1. Copy the files above. In the repo root `bundle install` and commit `Gemfile.lock`.
2. Edit the placeholders at the top of each workflow: `APPLICATION_ID`,
   `ANDROID_MODULE`, `AAB_PATH` (Android); `APP_IDENTIFIER`, scheme, plist paths
   (iOS).
3. Signing config (once per platform):
   - Android: in the app module `build.gradle`, add a `release` signingConfig reading
     `ANDROID_KEYSTORE_*` env vars; read `versionCode`/`versionName` from `-P`
     flags. Keep minify/R8 off (JS/WebView + native-addon bundle).
   - iOS: create the App ID and App Store Connect app, then run `fastlane match
     appstore` once on a Mac. CI syncs certs read-only.
4. Store access (once per platform):
   - Android: create the app and upload the first release manually in Play
     Console. Opt into Play App Signing and create an upload keystore. Use two
     least-privilege service accounts: one that can release to testing tracks
     only (`internal`), one with production-release rights (`production`).
   - iOS: create App Store Connect API keys with the narrowest role that can
     upload (TestFlight) and submit (App Store), and save the `.p8` files.
5. Create the environments above (GitHub > Settings > Environments). For each,
   set the deployment branch policy to the default branch only; give
   `production` required reviewers. Then add the secrets **to the
   environment** that uses them (signing secrets to `*-signing`, store
   credentials to `internal`/`testflight`/`production`) and the variables:

   | Platform | Secrets                                                                                                                     | Variables                                                                                                                                                                              |
   | -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Android  | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `SERVICE_ACCOUNT_JSON` | `PLAY_ROLLOUT_FRACTION` (optional, e.g. `0.1` for staged rollout)                                                                                                                      |
   | iOS      | `APP_STORE_CONNECT_API_KEY`, `MATCH_GIT_URL`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_PASSWORD`                             | `APPLE_TEAM_ID`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, `IOS_EXPORT_COMPLIANCE_USES_ENCRYPTION`, `DELIVER_LANGUAGES` (e.g. `en-US`, release notes locales) |

6. Deploy: Run workflow, pick a target. Test tracks ship immediately; production
   waits for approval.

## Versioning

- Android: `versionCode` = run number; `versionName` = `package.json` version.
  Testers are invited in Play Console.
- iOS: `MARKETING_VERSION` = `package.json` version; build number = run number.
  TestFlight internal testers must be App Store Connect team members (max 100).

## Verify locally

Run the Gradle and fastlane commands from the workflow files to build and sign
without uploading, or run the workflow on a non-production target first.
