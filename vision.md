# Ekrooh - Vision

## What it is

Ekrooh is a cross-platform app framework on the **Bare** runtime. It provides the
boring bootstrap (wire protocol, plugin contracts, transports, Android and iOS
hosts) that lets an app run across platforms and enables **p2p** technology. It
is plumbing, not a product.

## Goal

Give justus (and future apps) a stable, distributable foundation: cross-platform
execution plus peer-to-peer connectivity, without the app owning the runtime or
transport layer.

## Relationships

- **justus is built on Ekrooh** and cannot be proven on a broken Ekrooh.
- Ekrooh uses **Mantaq** internally for its connection state machine (never exported).
- Ekrooh and Mantaq are the two foundations; **justus is the proof that Ekrooh
  works.** Prioritize work that unblocks or strengthens justus, especially the
  Bare and p2p integration points.

## Success

- A healthy, building, versioned framework published as `@ekrooh/bare` (npm),
  plus the Android (AAR) and iOS (Swift package) hosts.
- p2p and native-host parity: Android first-class, iOS at reference parity.
- Stable public boundaries (wire protocol, plugin contracts, exported surface,
  host APIs), with internals free to refactor.
- justus runs on Ekrooh end-to-end, and other apps could stand on the same base.

## Stability contract

Breaking changes are gated to four boundaries: the wire protocol, plugin
manifest/event contracts, the JS exported surface (`package.json` `exports`),
and the Kotlin host public API. Breaking one is a major-version event. Internal
layout, tooling, and implementation may change freely. Tests enforce presence,
coverage floor, public-API snapshot, and export-surface integrity.

Technical depth lives in [`vision.md.technical.md`](vision.md.technical.md).
