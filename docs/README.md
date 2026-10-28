# Internal docs

This directory holds **internal, agent-primary documentation** for `@ekrooh/bare`. It is the system-of-record for decisions and agent operations — not user-facing material.

## What lives here

- **`adr/`** — Architecture Decision Records. System-wide, durable decisions that future agents must respect (stability enforcement, ABI support, loopback auth surface). See `adr/README.md` for the index and how to add one.
- **`security.md`** — Threat model, trust boundaries with their enforcing code and tests, and the routine review checklist.
- **`agents/`** — Agent-ops docs: `issue-tracker.md` (gh issue workflow), `triage-labels.md` (label vocabulary), `domain.md` (how engineering skills read this repo's domain docs).

The repo's single-context model is documented in `AGENTS.md` and `vision.md`: one `CONTEXT.md` + `docs/adr/` at the repo root.

## Internal vs public docs

- **Internal (`docs/`)** — ADRs + agent operations. Read by agents; authoritative for "why" and "what is supported".
- **Public (`apps/docs/`)** — the Astro documentation site for humans/consumers. Anything you intend to publish goes there, not here.

Keep internal prose tight and factual. Don't duplicate public-site content here.
