# Architecture Decision Records

Durable, system-wide decisions for `@ekrooh/bare`. An ADR records a choice that future agents must respect or explicitly reopen — not a proposal or a status update. Read the relevant ADR before working in the area it covers (see `docs/agents/domain.md`).

## Index

| ADR                                              | Title                                                                                      | Summary                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](./0001-mechanical-enforcement.md)         | Mechanical enforcement of the stability and testing contract                               | Tests — not prose — enforce the stability/testing contract (presence manifests, coverage floor, frozen API snapshot, real `exports` paths).                |
| [0002](./0002-android-abi-support.md)            | Android ABI support: 64-bit runtimes only                                                  | Supported on-device runtimes are `arm64-v8a`/`x86_64`; 32-bit-only Android fails fast.                                                                     |
| [0003](./0003-loopback-auth-surface.md)          | Loopback auth surface: one explicit bootstrap, cookie + header only                        | One public bootstrap mount; auth via `bare_session` cookie or `X-Bare-Token` header; no token-in-URL.                                                      |
| [0004](./0004-owner-initiated-agent-run-repo.md) | Autonomy model: owner starts all work, agents execute, CI is the only judge                | Owner initiates all work; routine upkeep is scripted; agents self-merge on green except owner-gated changes; releases via a release PR.                    |
| [0005](./0005-wire-format-limits.md)             | Wire format: keep the JSON-header frame for v1, move results to the body in the next major | Proposed. 64 KB header cap stays; fail oversized results loudly now; body-framed results in the next major; do not adopt `bare-rpc`/`protomux` as framing. |

## How to add an ADR

1. Number sequentially by the next free `NNNN` (this set ends at `0005`, so the next is `0006-<kebab-title>.md`).
2. Copy `TEMPLATE.md` into `NNNN-<kebab-title>.md` and fill it in. Title is a `# <topic>: <decision-in-a-sentence>` line.
3. Add a row to the index table above (ADR number, title, one-line summary).
4. Keep it factual and durable. Don't edit existing ADRs to "update" them — supersede with a new ADR that cites the one it replaces.
