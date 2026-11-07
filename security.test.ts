import { describe, expect, it } from 'vite-plus/test';
import fs from 'node:fs';
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

/** Shell commands of a `run:` block with comments and continuations folded. */
function commands(run: string | undefined): string[] {
  if (!run) return [];
  return run
    .replace(/\\\n/g, ' ')
    .split(/\n|&&|\|\||;/)
    .map((c) => c.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
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

/** A package-manager command that would run dependency lifecycle scripts. */
function runsInstallScripts(cmd: string): boolean {
  const c = cmd.replace(/\s+/g, ' ');
  const words = c.split(' ');
  const ignore = words.includes('--ignore-scripts');
  if (
    /\b(npm|pnpm|yarn|bun) (ci|install|i|clean-install|install-ci-test|install-test|it|cit|add)\b/.test(
      c,
    )
  ) {
    return !ignore;
  }
  if (/^(yarn|pnpm i|bun i)$/.test(c)) return true;
  if (/\b(vp|vpx) install\b/.test(c)) return true;
  // `npm rebuild` with no package runs every install script.
  const rebuild = /\bnpm (rebuild|rb)\b(.*)$/.exec(c);
  if (rebuild) {
    const pkgs = rebuild[2]
      .trim()
      .split(' ')
      .filter((w) => w && !w.startsWith('-'));
    return (
      pkgs.length === 0 || pkgs.some((p) => !REBUILD_ALLOWLIST.includes(p))
    );
  }
  return false;
}
/** Packages whose install script a privileged job may run (resolves a binary). */
const REBUILD_ALLOWLIST = ['esbuild'];

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
      for (const cmd of commands(step.run)) {
        if (/\b(npm|pnpm|yarn|vp) (ci|install|i|rebuild)\b/.test(cmd)) {
          privilegedInstalls++;
        }
        if (runsInstallScripts(cmd)) bad.push(`${where}: ${cmd}`);
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
      'pnpm install',
      'yarn',
      'vp install',
      'npm rebuild',
      'npm rebuild sharp',
    ]) {
      expect(runsInstallScripts(cmd), cmd).toBe(true);
    }
    for (const cmd of [
      'npm ci --ignore-scripts',
      'npm rebuild esbuild',
      'npm run build',
    ]) {
      expect(runsInstallScripts(cmd), cmd).toBe(false);
    }
    // A flag hidden in a comment does not count.
    expect(commands('npm ci # --ignore-scripts').some(runsInstallScripts)).toBe(
      true,
    );
  });

  it('a job that can mint an OIDC token runs no repo or dependency code', () => {
    // npm trusted publishing (and Pages) trust any step of an `id-token:
    // write` job. Such a job only downloads an artifact and publishes it.
    const bad: string[] = [];
    let jobs = 0;
    for (const { file, wf } of workflowFiles()) {
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        if (!hasIdToken(job)) continue;
        jobs++;
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith('actions/checkout@')) {
            bad.push(`${file}#${id}: checkout`);
          }
          for (const raw of commands(step.run)) {
            // `if npm ci; then` must not hide a command behind a keyword.
            const cmd = raw.replace(/^((if|then|else|elif|!)\s+)+/, '');
            const ok =
              /^(fi|then|else|exit \d+|echo .*|test -f \S+)$/.test(cmd) ||
              /^npm view \S+ version\b/.test(cmd) ||
              /^npm publish "?[^\s"]+\.tgz"? .*--ignore-scripts\b/.test(cmd);
            if (!ok) bad.push(`${file}#${id}: ${raw}`);
          }
        }
      }
    }
    expect(jobs).toBeGreaterThan(0);
    expect(bad).toEqual([]);
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
    // Jobs with secrets: no JS toolchain, and Gradle only for publish tasks.
    const bad: string[] = [];
    for (const [id, job] of Object.entries(jobs)) {
      if (!/\bsecrets\./.test(JSON.stringify(job))) continue;
      for (const step of job.steps ?? []) {
        for (const cmd of commands(step.run)) {
          if (/\b(npm|npx|pnpm|yarn|vp|vpx)\b/.test(cmd))
            bad.push(`${id}: ${cmd}`);
          const gradle = /\.\/gradlew\b(.*)$/.exec(cmd);
          if (gradle) {
            const tasks = gradle[1]
              .split(/\s+/)
              .filter((w) => w && !w.startsWith('-'));
            for (const t of tasks) {
              if (!/publish|closeAndRelease/i.test(t))
                bad.push(`${id}: gradle ${t}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
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
      for (const ev of ['push', 'pull_request']) {
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
