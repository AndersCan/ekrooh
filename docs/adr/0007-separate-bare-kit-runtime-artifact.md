# Android packaging: the Bare Kit runtime is its own Maven artifact, versioned by bare-kit

## Context

Up to 0.6.2, `bare-host` bundled the upstream Bare Kit Android prebuild
(`libbare-kit.so` and `libc++_shared.so` for four ABIs, plus its `classes.jar`).
That made every `bare-host` AAR about 69 MB, of which our own code (Kotlin
classes and the `libnativehelper.so` stub, ADR 0002) is about 40 KB.

Maven Central (Sonatype Central Portal) limits each organization's total
release size per calendar month. Two patch releases in November 2026 (0.6.1,
0.6.2) went over it, even though neither changed the runtime. The runtime only
changes when the pinned bare-kit version in `scripts/prebuilds.lock.json` is
bumped. iOS already works this way: `Package.swift` resolves
`BareKit.xcframework` from a zip that is re-hosted only on a bare-kit bump.

Out of scope: dropping ABIs (ADR 0002 keeps all four installable), and the
GitHub Packages fallback for `bare-host`.

## Decision

- The upstream Android prebuild is published as
  `io.github.anderscan.ekrooh:bare-kit-runtime`, built by the Gradle project
  `:bare-kit-runtime` (`android/bare-kit-runtime/`). It contains only the
  upstream files: no ekrooh code.
- Its version is the `maven["bare-kit-runtime"]` pin in
  `scripts/prebuilds.lock.json`: the bare-kit version without the `v`
  (`2.5.5`), with a `-N` suffix only if the same bare-kit version has to be
  republished. It does **not** follow the ekrooh version. This is the one
  exception to "one version across every artifact", like the iOS binary.
- It is published only by `.github/workflows/release-bare-kit-runtime.yml` on a
  `bare-kit-v<pin>` tag, to Maven Central only.
- `bare-host` depends on it with `api project(":bare-kit-runtime")`, so the
  published POM names `bare-kit-runtime:<pin>`. `libnativehelper.so` stays in
  `bare-host`, because it is our code and changes with ekrooh releases.
- `release.yml` refuses to publish if `bare-kit-runtime:<pin>` is not on Maven
  Central. CI fails if the `bare-host` AAR bundles `libbare-kit.so` or the
  runtime jar, or grows over 5 MB.

## Consequences

- A normal ekrooh release uploads about 40 KB to Central instead of 69 MB. The
  69 MB is uploaded once per bare-kit bump.
- Additive for consumers: they still declare only `bare-host`, and Gradle
  resolves `bare-kit-runtime` from Maven Central. No Kotlin host API, wire
  protocol, or JS export changes. A consumer that mirrors only selected
  artifacts must mirror `bare-kit-runtime` too.
- A bare-kit bump is now a two-tag sequence: `bare-kit-v<pin>` (runtime; also
  hosts the iOS zip) first, then the next `vX.Y.Z`.
- The `release` environment's tag rule must allow `bare-kit-v*` as well as `v*`.
