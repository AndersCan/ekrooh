# Android ABI support: 64-bit runtimes only

## Context

The Bare Kit worklet ships as a prebuilt `libbare-kit.so` for four ABIs
(`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`) and is bundled into the
`bare-host` AAR. On a **32-bit-only** ARM device (e.g. a `zygote32`
`armeabi-v7a` runtime), the worklet's native thread bootstrap crashes with a
SIGSEGV (null-pointer dereference at `bare_kit__on_thread_enter`), and the
prebuilt library declares a `DT_NEEDED` on the private platform library
`libnativehelper.so` that the app classloader namespace cannot resolve.

Investigation (ekrooh#45, #46) established that `libbare-kit.so` imports
exactly one symbol from `libnativehelper.so` — `JNI_GetCreatedJavaVMs` — and
that the worklet calls that symbol at thread enter. Retargeting the missing
platform library is solved by shipping a small functional stub compiled
alongside the worklet (see `android/src/main/cpp/bare_nativehelper_stub.c`).
That removes the `UnsatisfiedLinkError` and the primary 32-bit failure
vector. It does not, however, make 32-bit-only devices a first-class target.

The framework has no documented ABI/runtime support matrix. Echoing
`vision.md`'s "boring bootstrap for cross-platform apps", the supported
surface should be explicit rather than implicit.

## Decision

**Supported on-device runtimes are 64-bit only: `arm64-v8a` and `x86_64`.**
The 32-bit ABIs (`armeabi-v7a`, `x86`) remain shipped in the AAR so the
library installs and links on 32-bit-capable devices and 32-bit emulators,
but a **32-bit-only** runtime (`zygote32` — no 64-bit ABI in
`Build.SUPPORTED_ABIS`) is **unsupported**.

Consequences:

- `bare-host` exposes `BareHostAbi.requireSupportedAbi()`, which fails fast
  with a clear `IllegalStateException` on 32-bit-only runtimes _before_ the
  worklet starts. Consumers may call it explicitly; the reference app does so
  in `MainActivity.onCreate` before constructing `Worklet`.
- The native helper stub ships in the AAR for all four ABIs (including the
  32-bit ones) so that `System.loadLibrary("bare-kit")` resolves and the
  64-bit story is fully self-contained — the stub is ABI-correct by compile
  and costs nothing on 64-bit devices.
- Support for specific 32-bit-only hardware is out of scope and will not be
  scheduled. The remaining worklet thread-enter fragility on 32-bit-only
  runtimes (e.g. a null `ActivityThread.currentApplication()`) is an upstream
  bare-kit concern, tracked separately against `holepunchto/bare-kit`.

## Rationale

- Modern Android is statically 64-bit; 32-bit-only devices are legacy
  hardware with no maintenance path.
- Fail-fast beats a native crash: a clear, documented error is diagnosable;
  an `assert`-stripped null-deref is not.
- Keeping the stub ABI-correct across all shipped ABIs preserves install
  compatibility without a 32-bit runtime commitment.
