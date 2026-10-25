# Free CI device runners for a public repo

Ticket #4 (part of #1).

## Answer

Emulator and simulator runs on standard GitHub-hosted runners are free and
unlimited for public repositories. No device-runner surcharge: Android (KVM) and
iOS (simulator) jobs bill like any other job.

- https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners

Private repos only (for reference): included minutes are 2,000 (Free) / 3,000
(Pro, Team) / 50,000 (Enterprise Cloud) per month. Overage: Linux 2-core $0.006/min,
macOS 3/4-core $0.062/min.

## Android emulator on `ubuntu-latest`

- KVM works on standard Linux runners. An enable-KVM udev step must run before the
  emulator launches.
- Use `reactivecircus/android-emulator-runner@v2`. Key inputs: `api-level` (min 15),
  `target`, `arch` (`x86_64` for API 21+), `profile`, `cores` (2),
  `emulator-boot-timeout` (600 s), `emulator-options` (default headless
  `-no-window -gpu swiftshader_indirect`), `disable-animations` (true).
- Cold boot is dominated by the system image download. Cache `~/.android/avd/*` and
  `~/.android/adb*` with `actions/cache`; use `-no-snapshot-save` on test runs.
- API 29-36 `google_apis` x86_64 are well exercised by large OSS projects.

## iOS simulator on macOS runners

- Labels: `macos-15` (arm64, pin this; `macos-14` is deprecated Nov 2026),
  `macos-latest`, `macos-15-intel` (Intel, 4-core).
- The simulator is a native host process, not a VM. The arm64 nested-virt limit
  does not apply, so `xcodebuild test` and `maestro test` run on arm64 runners.
- arm64 runners have no static UDID (matters only for physical-device signing).
- https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md

## Maestro on both

- Install per job: `curl -fsSL "https://get.maestro.mobile.dev" | bash`. Needs
  Java 17+ and Xcode CLT (macOS). Not preinstalled; ~1 min, or cache `~/.maestro`.
- `maestro test flow.yaml` against the booted emulator or simulator. Android API
  29-34 supported (35/36 announced for Q2 2026).

## Limits that bite an iOS matrix

- Job timeout 6 h. 256 jobs per workflow. Cache 10 GB per repo.
- Free plan: 20 concurrent jobs, **max 5 concurrent macOS jobs**. Keep the
  emulator/simulator matrix at 5 jobs or fewer, or macOS jobs serialize.
- Queue drops after 45 min.

## Fallbacks if hosted runners fail

- Self-hosted (free, no limits): a spare Mac for simulators; an x86 Linux box with
  KVM for emulators.
- Maestro Cloud: per-run credits; free for OSS by request.
- Firebase Test Lab: real devices, per-minute pricing (~$0.13-$0.36 per device-min).

None is needed at this repo's scale.

Source: https://docs.github.com/en/actions/reference/limits
