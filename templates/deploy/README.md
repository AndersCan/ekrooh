# Deploying an `@ekrooh/bare` app to the app stores

Ship the Android and iOS reference apps to **Google Play** and the **App Store**
from GitHub Actions. One workflow per platform, both **dispatch-only** — a
human clicks **Run workflow** and picks a target:

| Workflow                 | Target       | Ships to                                   |
| ------------------------ | ------------ | ------------------------------------------ |
| `android-play-store.yml` | `internal`   | Google Play **internal testing** (testers) |
| `android-play-store.yml` | `production` | Google Play **production**                 |
| `ios-app-store.yml`      | `testflight` | **TestFlight** (internal testers)          |
| `ios-app-store.yml`      | `appstore`   | submit for **App Store review**            |

Only users in `DEPLOY_APPROVERS` can trigger a run, and the production paths
also require approval on the **`production`** GitHub environment.

---

## Files

```
templates/deploy/
├── android-play-store.yml     → copy to .github/workflows/
├── ios-app-store.yml          → copy to .github/workflows/
├── fastlane/                  → copy whole dir to <repo>/fastlane/
└── README.md
```

**fastlane is free** (MIT, Google-backed, no pro tier). Costs are only Apple's
$99/yr and Google's one-time $25 developer fees.

---

## High-level steps

### 1. Copy the templates in

Copy the two `.yml` files into `<repo>/.github/workflows/` and the `fastlane/`
directory into `<repo>/fastlane/`, then `bundle install` there and commit the
`Gemfile.lock`.

### 2. Fill in the placeholders

At the top of each workflow file set the app identity (`APPLICATION_ID` /
`ANDROID_MODULE` / `AAB_PATH` for Android; `APP_IDENTIFIER` / scheme / plist
paths for iOS) and `DEPLOY_APPROVERS` — the comma-separated GitHub usernames
allowed to deploy. Until `DEPLOY_APPROVERS` is set, no one can run the
workflows (fail-closed).

### 3. Add app-store & signing config (one-time, per platform)

- **Android**: in the app module's `build.gradle`, wire a `release`
  signingConfig that reads the `ANDROID_KEYSTORE_*` env vars, and read
  `versionCode`/`versionName` from `-P` flags. Keep minify/R8 **off** for the
  JS/WebView + native-addon bundle.
- **iOS**: create the App ID + App Store Connect app, then run fastlane
  **match** once on a Mac to create the distribution cert + profile (CI only
  syncs them read-only).

### 4. Grant store access (one-time, per platform)

- **Android**: create the app + upload the **first** release manually in Play
  Console, opt into Play App Signing, generate an upload keystore, and invite a
  Google Play service-account email with track/release permissions.
- **iOS**: generate an App Store Connect **API key** (App Manager role) and
  save the `.p8`.

### 5. Add the GitHub secrets & variables

| Android                                                                                             | iOS                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | `APP_STORE_CONNECT_API_KEY`, `MATCH_GIT_URL`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_PASSWORD`             |
| `SERVICE_ACCOUNT_JSON`                                                                              | `APPLE_TEAM_ID`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID` (non-secret → variables) |

Full definitions of every secret live in the platform sections below.

### 6. Create the `production` environment

In **GitHub → Settings → Environments** add `production` with **required
reviewers** set to the same users as `DEPLOY_APPROVERS`. This is the final
gate before anything ships.

### 7. Deploy

Click **Run workflow** → pick a target. Testers get `internal` / `testflight`
immediately; production waits for the `production` approval.

---

## Who can run these actions

- **Trigger** any run: `DEPLOY_APPROVERS` only (checked by the workflow's
  `authorize` job against `github.actor`).
- **Approve production / App Store submission**: the `production` environment
  required reviewers only.

Set `DEPLOY_APPROVERS` to a single username to make that person the sole
deployer.

---

## Platform details

### Android

- Play Console: create the app, upload the first release manually, opt into
  **Play App Signing**, create the upload keystore, and invite a service
  account with track + production-release permissions.
- Secrets: `ANDROID_KEYSTORE_BASE64` (keystore base64), `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `SERVICE_ACCOUNT_JSON`.
- Optional variable `PLAY_ROLLOUT_FRACTION` (e.g. `0.1`) → staged rollout.
- Versioning: `versionCode` = run number, `versionName` = `package.json`
  version. Testers are invited in Play Console. First upload must be manual.

### iOS

- Apple Developer: create the App ID + App Store Connect app (fill required
  metadata), generate an API key (App Manager), run `fastlane match appstore`
  once.
- Secrets & variables: `APP_STORE_CONNECT_API_KEY`, `MATCH_GIT_URL`,
  `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_PASSWORD` (secrets); `APPLE_TEAM_ID`,
  `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`,
  `IOS_EXPORT_COMPLIANCE_USES_ENCRYPTION`, `DELIVER_LANGUAGES` (variables —
  `DELIVER_LANGUAGES` is the comma-separated App Store Connect locales for the
  version, e.g. `en-US`, used for release notes).
- Versioning: `MARKETING_VERSION` = `package.json`, build number = run number.
  TestFlight internal testers are App Store Connect team members (up to 100).

---

## Verify locally

Run the same Gradle/fastlane commands the workflows use (see the workflow
files) to build + sign without uploading, or just run the workflow on a
non-production target first.
