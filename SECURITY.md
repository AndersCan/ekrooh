# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting: the **Security** tab of this repository, then **Report a
vulnerability**. Do not open a public issue for a flaw that affects a published
release.

Include the affected version, the component (`@ekrooh/bare` npm package, the
Android host, the iOS host), and steps to reproduce.

## Supported versions

Only the latest release line receives security fixes.

## Security model

The threat model, trust boundaries and review checklist live in
[`docs/security.md`](docs/security.md).

## Release integrity

- Only the owner can push `v*` tags, and every publish waits for the owner's
  approval of the `release` environment, which holds the publishing secrets.
- The release builds and tests in a job with no credentials. The npm publish job
  only uploads the packed tarball (OIDC trusted publishing, no `NPM_TOKEN`).
- Bare Kit prebuilds are checked against SHA-256 pins in
  `scripts/prebuilds.lock.json` before they are unpacked. See
  [`RELEASING.md`](RELEASING.md) for the full pipeline.
