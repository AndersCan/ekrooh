---
name: security-review
description: Routine security review of the whole repo, or of a branch against main, driven by docs/security.md. Use when the user asks for a security review, audit, or checkup, or before a release.
---

Review the repo against its own security model. `docs/security.md` is the
checklist; this skill is the procedure.

## 1. Pick the scope

- **Full review** (no argument, or "the repo"): every boundary in
  `docs/security.md`.
- **Change review** (a branch, PR or "since X"): run
  `git diff --stat <base>...HEAD`, map each changed file to the boundaries it
  touches, and review only those plus anything the diff makes newly reachable.

## 2. Run the mechanical checks first

```sh
npm run build:pkg && vp test security.test.ts
npm audit --omit=dev
```

A failure here is a finding. Do not spend review time on what they already
cover.

## 3. Walk each boundary

For each section of `docs/security.md` in scope:

1. Open the enforcing file it names and confirm every invariant still holds in
   the code, not just in comments.
2. Confirm the named test still asserts it. An invariant with no test is a
   finding (category `test-coverage`).
3. Hunt for **new** entry points the section does not list yet:
   - `registerRoute`, `mount`, `mountDir` callers (new HTTP surface)
   - `definePlugin` handlers that use an argument as a path, URL, id or
     command (section 4: args are never validated for you)
   - host plugin registrations in `android/`, `ios/`, `examples/*-app`
   - new `uses:`, `permissions:` or secrets in `.github/workflows/`
   - new dependencies in `package.json` or Gradle files
4. For each entry point, ask what each attacker in the table can send it, and
   whether that reaches an asset.

## 4. Report

For each finding give: severity (high / medium / low / hardening), the
attacker, the file and line, a concrete failure scenario, and a fix. Order by
severity. Say plainly which boundaries were reviewed and found clean.

Then:

- File one GitHub issue per finding labelled `security` (see
  `docs/agents/issue-tracker.md`). A finding exploitable in a published release
  goes through the private channel in `SECURITY.md`, not a public issue.
- If the review found a boundary, invariant or accepted risk that
  `docs/security.md` does not describe, update that file in the same PR.
- If an invariant can be checked by reading files, add it to
  `security.test.ts`.
