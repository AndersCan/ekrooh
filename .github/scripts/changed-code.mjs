#!/usr/bin/env node
/**
 * Decide whether a push or pull request touches anything but docs, for the
 * `changes` job in test.yml and playwright.yml.
 *
 * Required status checks must report on every PR, so the workflows always run
 * (no workflow-level `paths-ignore`, whose skipped workflow never reports).
 * The heavy jobs are instead gated on this job's `code` output: a skipped job
 * counts as passing. Fail-safe: anything unexpected (no base, a git error, an
 * empty diff) prints `code=true`, so the full suite runs.
 *
 * Docs-only means every changed path is a Markdown file, under `docs/`, or the
 * root `LICENSE` (the paths the workflows used to ignore).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when every path is documentation. An empty list is not docs-only. */
export function isDocsOnly(files) {
  return (
    files.length > 0 &&
    files.every(
      (f) => f.endsWith('.md') || f.startsWith('docs/') || f === 'LICENSE',
    )
  );
}

function changedFiles() {
  const event = process.env.GITHUB_EVENT_NAME;
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (event === 'pull_request') {
    // actions/checkout checks out the PR merge commit: its first parent is the
    // base branch, so this is exactly what the PR changes.
    return git('diff', '--name-only', 'HEAD^1', 'HEAD');
  }
  const before = process.env.BEFORE_SHA ?? '';
  if (
    event === 'push' &&
    /^[0-9a-f]{40}$/.test(before) &&
    !/^0+$/.test(before)
  ) {
    return git('diff', '--name-only', before, 'HEAD');
  }
  return [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let code = true;
  try {
    const files = changedFiles();
    code = !isDocsOnly(files);
    console.log(`${files.length} changed path(s); docs-only: ${!code}`);
  } catch (err) {
    console.log(`could not diff (${err.message}); running everything`);
  }
  const line = `code=${code}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}
