# Free CI device runners — GitHub-hosted emulators for a public open-source repo

Ticket #4. Part of #1.

## Direct answer

**Yes. Emulator/simulator runs on standard GitHub-hosted runners are free and unlimited for public repositories.** The billing doc is explicit: "GitHub Actions usage is **free** for **self-hosted runners** and for **public repositories** that use standard GitHub-hosted runners", and the runners reference repeats: "Use of the standard GitHub-hosted runners is free and unlimited on public repositories." There is no device-runner surcharge — Android (KVM) and iOS (simulator) runs bill the same minute buckets as any other job.

- https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions
- https://docs.github.com/en/actions/reference/runners/github-hosted-runners

## Private-repo model

- Free tiers apply to _private_ repos only: GitHub Free 2,000 min/mo, Pro 3,000, Team 3,000 (per account), Enterprise Cloud 50,000. Above that, per-minute rates: Linux 2-core $0.006, macOS 3/4-core $0.062, larger runners always billed.
- For an open-source repo this is moot: public repos are free and unlimited.

## Android emulator on `ubuntu-latest`

- KVM/hardware acceleration is supported on standard Linux runners: "GitHub-hosted Linux runners support hardware acceleration for Android SDK tools." Nested virtualization is "not officially supported" but works via `/dev/kvm` on these hosts; an **enable-KVM** udev step must run before launching the emulator.
- Canonical flow: `reactivecircus/android-emulator-runner@v2` (installs SDK/system image, creates AVD, boots, waits, runs your `script`, kills emulator). Inputs: `api-level` (min 15), `target` (default/google_apis/playstore/atd), `arch` (x86_64 for API 21+), `profile`, `cores` (default 2), `emulator-boot-timeout` (default 600 s), `emulator-options` (default headless `-no-window -gpu swiftshader_indirect`), `disable-animations` (default true).
- Boot/reliability: 2-core `ubuntu-latest` is 2–3× faster and cheaper than macOS runners per the README. Cold first boot can approach the timeout on slow image downloads; snapshot + AVD caching via `actions/cache` (cache `~/.android/avd/*`, `~/.android/adb*`, use `-no-snapshot-save` on the test run) is the documented way to cut startup to well under a minute. System image download is the dominant variable; API 29–36 `google_apis` x86_64 are well exercised by big OSS projects (coil, sqldelight, Wikipedia).
- https://github.com/ReactiveCircus/android-emulator-runner#readme

## iOS simulator on macOS runners

- Labels: arm64 `macos-14` (3-core M1, 7 GB) / `macos-15` / `macos-latest`; Intel `macos-15-intel` (4-core, 14 GB). Xcode + CoreSimulator + iOS runtimes are preinstalled (`simctl` boots pre-baked iPhone devices per runtime).
- The iOS simulator is **not** a VM — it is a native host process, so it does **not** need nested virtualization. The documented arm64 limit ("Nested-virtualization is not supported due to Apple's Virtualization Framework") only affects VM-in-VM use (e.g. an Android emulator on macOS), not simctl. `xcodebuild test` and `maestro test` both work on arm64 runners.
- Intel label note: arm64 runners have no static UDID (matters only for physical-device signing). macos-14 is in deprecation (unsupported Nov 2026) — pin `macos-15`.
- https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md

## Maestro on both runner types

- Install: `curl -fsSL "https://get.maestro.mobile.dev" | bash` (macOS/Linux); needs Java 17+ (preinstalled) and Xcode CLT on macOS. Not preinstalled on runner images — install per job (~1 min) or cache `~/.maestro`.
- Usage: `maestro test flow.yaml` against the booted emulator/simulator (adb / `simctl`). API levels supported 29–34 (35/36 "Q2 2026").
- https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli

## Limits that could bite a photo-app matrix

- Job timeout: 6 h (hosted). Matrix: 256 jobs/workflow. Concurrency: Free plan 20 concurrent jobs, **max 5 concurrent macOS jobs** (biggest real cap for an iOS matrix). Cache 10 GB/repo. Queue drop at 45 min.
- Practical: keep emulator/simulator matrix small (≤5 jobs) or macOS jobs serialize.

## If hosted runners are insufficient

- Self-hosted (free, no limits): a spare Mac for simulator runs; an x86 Linux box with KVM for emulators.
- Maestro Cloud: per-run credits, free tier for OSS by request.
- Firebase Test Lab: Android robo/instrumented on real devices; free tier historically for OSS via grant; otherwise per-test pricing (~$0.13–$0.36/device-min).
- None needed for this repo's likely scale — the hosted surface is sufficient and free.

Source: https://docs.github.com/en/actions/reference/limits
