# Ekrooh - Vision

## What it is

Ekrooh is a **cross-platform app framework** built on the **Bare** runtime. It
provides the boring bootstrap - wire protocol, plugin contracts, transports, and
native hosts (Android/iOS) - that lets an app run across platforms and enables
**p2p** technology. It is plumbing, not a product.

## Goal

Give justus (and future apps) a stable, distributable foundation to run on:
cross-platform execution plus peer-to-peer connectivity, without the app owning
the runtime or transport layer.

## Relationship to the others

- **Foundation for justus.** justus is built on Ekrooh; it cannot be proven on
  top of a broken Ekrooh.
- **Uses Mantaq internally** for its connection state machine (never exported).
- Ekrooh and Mantaq are the two foundations; **justus is the proof that
  Ekrooh works.** Work here is prioritized where it unblocks or strengthens
  justus (especially the Bare/p2p integration points).

## Direction of travel / success

- Healthy, building, and versioned framework published as `@ekrooh/bare` (npm)
  plus Android (AAR) and iOS (Swift package) hosts.
- p2p and native-host parity (Android first-class, iOS at reference parity) so
  justus can ship cross-platform.
- Stable public boundaries (wire protocol, plugin contracts, exported surface,
  host APIs) with internals free to refactor.
- Success = justus runs on Ekrooh end-to-end, and the framework is a sound base
  other apps could also stand on.
