# Domain docs

How engineering skills consume this repo's domain documentation.

## Read before exploring

- `CONTEXT.md` at the repo root (single-context repo). If `CONTEXT-MAP.md` exists
  instead, read the `CONTEXT.md` for each relevant context it lists.
- `docs/adr/`: read the ADRs that touch the area you are changing. Multi-context
  repos also check `src/<context>/docs/adr/`.

Missing files are not an error. Do not flag or suggest creating them. The
`/domain-modeling` skill creates them lazily.

## Vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, proposals, hypotheses and test
names. Do not drift to synonyms the glossary avoids. A concept missing from the
glossary means either the wording should change or the glossary has a gap to note
for `/domain-modeling`.

## ADR conflicts

If your output contradicts an ADR, say so explicitly rather than overriding it:

> Contradicts ADR-0003 (loopback auth surface): worth reopening because ...
