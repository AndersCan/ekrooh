# Android ABI support: 64-bit runtimes only

## Context

The Bare Kit worklet ships as a prebuilt `libbare-kit.so` for four ABIs
(`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`), bundled into the `bare-host` AAR. On
32-bit-only ARM devices (`zygote32`, `armeabi-v7a`) the worklet's thread bootstrap
crashes (SIGSEGV in `bare_kit__on_thread_enter`). The prebuilt library also
`DT_NEEDED`s the platform `libnativehelper.so`, which the app namespace cannot
resolve. Investigation (ekrooh#45, #46) found that the only symbol imported from it
is `JNI_GetCreatedJavaVMs`. A functional stub compiled with the worklet
(`android/src/main/cpp/bare_nativehelper_stub.c`) fixes the `UnsatisfiedLinkError`.
That does not make 32-bit-only devices a supported target.

## Decision

**Supported on-device runtimes are 64-bit only: `arm64-v8a` and `x86_64`.** The
32-bit ABIs stay in the AAR so the library installs and links on 32-bit-capable
devices and emulators. A **32-bit-only** runtime (no 64-bit ABI in
`Build.SUPPORTED_ABIS`) is unsupported.

Consequences:

- `bare-host` exposes `BareHostAbi.requireSupportedAbi()`, which throws
  `IllegalStateException` on 32-bit-only runtimes before the worklet starts. The
  reference app calls it in `MainActivity.onCreate`.
- The native helper stub ships for all four ABIs, so `System.loadLibrary("bare-kit")`
  resolves. The stub costs nothing on 64-bit devices.
- Specific 32-bit hardware is out of scope and will not be scheduled. Remaining
  thread-enter fragility on 32-bit-only runtimes (for example a null
  `ActivityThread.currentApplication()`) is an upstream bare-kit issue, tracked
  against `holepunchto/bare-kit`.

## Status note (2026-11, security review)

- `requireSupportedAbi()` now also throws in a **32-bit process on a 64-bit
  device** (`Process.is64Bit()`), which happens when an APK ships some native
  library only for a 32-bit ABI. The rule is "a 64-bit process on a 64-bit
  ABI" (`BareHostAbi.isSupportedRuntime`).
- The pinned Bare Kit prebuilds (v2.5.5) no longer list `libnativehelper.so`
  in `DT_NEEDED` and do not import `JNI_GetCreatedJavaVMs`, so nothing loads
  the stub today. When a library is loaded only as a `DT_NEEDED` dependency,
  ART never calls its `JNI_OnLoad`, so the stub would report no VM anyway.
  The stub stays until its removal is verified on a device against the pinned
  release (see the comment in `bare_nativehelper_stub.c`).

## Rationale

- Modern Android is 64-bit. 32-bit-only devices have no maintenance path.
- A clear, documented exception beats a native crash.
- An ABI-correct stub keeps install compatibility without a 32-bit commitment.
