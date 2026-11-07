import { describe, expect, it } from 'vite-plus/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ErrorCode,
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
} from './core/messages/constants';
import { MEDIA_HOST_TIMEOUT_MS } from './plugins/media/kinds';
import { PERMISSION_IDS } from './plugins/permissions/ids';

// Greppable security invariants for the Apple and desktop hosts
// (docs/security.md §1 and §5): the iOS host package (`ios/`), the reference
// iOS app (`examples/ios-app`) and the desktop host (`examples/desktop-app`,
// `core/desktop.core.ts`). Each check reads files only. Behavior is pinned by
// the Swift tests (`ios/Tests/BareHostTests`: `BareWebHostTest`,
// `HostIpcRouterTest`, `DefaultHostPluginsTest`), the Zig tests
// (`zig build test`) and `scripts/smoke-desktop.mjs`.

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Source text without `//` line comments (doc text may name what the code
 * must not do). */
const code = (rel: string) =>
  read(rel)
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

/** Every file under `dir` with one of `exts`. */
function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), {
      withFileTypes: true,
    })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (
          ![
            'node_modules',
            'dist',
            'zig-out',
            'zig-pkg',
            '.zig-cache',
            'Resources',
            'addons',
          ].includes(entry.name)
        )
          walk(child);
      } else if (exts.some((e) => entry.name.endsWith(e))) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** Value of a Swift constant written as `a * b * …` (decimal or hex). */
function product(expr: string): number {
  const factors = expr.split('*').map((f) => f.trim());
  if (factors.some((f) => !/^(0x[0-9a-f]+|[0-9]+)$/i.test(f))) return NaN;
  return factors.reduce((acc, f) => acc * Number(f), 1);
}

const WEB_HOST = 'ios/Sources/BareHost/BareWebHost.swift';
const RUNTIME = 'examples/ios-app/app/BareRuntime.swift';
const INFO_PLIST = 'examples/ios-app/app/Info.plist';
const MAIN_ZIG = 'examples/desktop-app/src/main.zig';

describe('iOS host invariants (docs/security.md §5)', () => {
  it('ATS allows only local networking: no arbitrary loads, no exceptions', () => {
    const plist = read(INFO_PLIST);
    expect(plist).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    for (const key of [
      'NSAllowsArbitraryLoads',
      'NSAllowsArbitraryLoadsInWebContent',
      'NSAllowsArbitraryLoadsForMedia',
      'NSExceptionDomains',
    ]) {
      expect(plist, key).not.toContain(`<key>${key}</key>`);
    }
  });

  it('the app registers no URL schemes and does not expose its files', () => {
    const plist = read(INFO_PLIST);
    for (const key of [
      'CFBundleURLTypes',
      'UIFileSharingEnabled',
      'LSSupportsOpeningDocumentsInPlace',
    ]) {
      expect(plist, key).not.toContain(`<key>${key}</key>`);
    }
  });

  it('the bootstrap is a main-frame, document-start, origin-guarded script', () => {
    const src = code(WEB_HOST);
    expect(src).toMatch(
      /WKUserScript\(\s*source: bootstrapScriptSource,\s*injectionTime: \.atDocumentStart,\s*forMainFrameOnly: true\s*\)/,
    );
    expect(src).toContain('if (location.origin === ');
    // Removed once the first page has loaded, so a later navigation never
    // gets the nonce again.
    expect(src).toContain('removeAllUserScripts()');
    // The handoff is deleted as soon as it is read.
    expect(src).toMatch(
      /static func consume[\s\S]*?parse\(data\)[\s\S]*?removeItem\(at: url\)/,
    );
  });

  it('only a loopback origin and a base64url nonce are accepted from the handoff', () => {
    const src = code(WEB_HOST);
    expect(src).toContain('let prefix = "http://127.0.0.1:"');
    expect(src).toContain(
      'Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")',
    );
  });

  it('storage is excluded from backup, fatally, and kept out of Documents', () => {
    const src = code(WEB_HOST);
    expect(src).toContain('values.isExcludedFromBackup = true');
    expect(src).toMatch(
      /try storage\.setResourceValues\(values\)\s*\} catch \{\s*throw BareStorageError\.backupExclusionFailed/,
    );
    expect(src).toContain('.applicationSupportDirectory');
    expect(src).toContain('.cachesDirectory');
  });

  it('WebViews are hardened: no link previews, never inspectable', () => {
    expect(code(WEB_HOST)).toContain('webView.allowsLinkPreview = false');
    const swift = [
      ...files('ios/Sources', ['.swift']),
      ...files('examples/ios-app', ['.swift']),
    ];
    for (const file of swift) {
      expect(code(file), file).not.toMatch(/isInspectable\s*=\s*true/);
      expect(code(file), file).not.toMatch(
        /allowFileAccessFromFileURLs|allowUniversalAccessFromFileURLs/,
      );
      expect(code(file), file).not.toMatch(
        /javaScriptCanOpenWindowsAutomatically\s*=\s*true/,
      );
    }
  });

  it('the reference app uses the library confinement, not its own copy', () => {
    const src = code(RUNTIME);
    expect(src).toContain('BareStorage.prepare()');
    expect(src).toContain('BareHandoff.consume(at:');
    expect(src).toContain('BareWebHost.configure(webView)');
    expect(src).toContain('BareWebHost.load(');
    expect(src).toContain('BareNavigationDelegate()');
    // No hand-rolled injection, storage location or delegate.
    expect(src).not.toContain('WKUserScript(');
    expect(src).not.toContain('.documentDirectory');
    expect(src).not.toMatch(/class \w+: NSObject, WKNavigationDelegate/);
  });

  it('the navigation delegate is installed before any page load', () => {
    const src = code(RUNTIME);
    const delegate = src.indexOf('webView.navigationDelegate = navDelegate');
    const firstLoad = src.indexOf('waitForHandoffAndLoad(webView:');
    expect(delegate).toBeGreaterThan(-1);
    expect(firstLoad).toBeGreaterThan(delegate);
  });

  it('the permission allowlist matches the canonical ids and fails closed', () => {
    const src = code('ios/Sources/BareHost/DefaultHostPlugins.swift');
    const known = [...src.matchAll(/^\s*case "([a-z]+)":/gm)].map((m) => m[1]);
    expect([...new Set(known)].sort()).toEqual([...PERMISSION_IDS].sort());
    // No fallback to a granted id for a missing argument.
    expect(src).not.toMatch(/\?\? "storage"/);
  });

  it('user-mediated host handlers outlast the worklet-side deadline', () => {
    const registry = code('ios/Sources/BareHost/HostPluginRegistry.swift');
    const seconds = (name: string) => {
      const m = new RegExp(
        `static let ${name}: TimeInterval = ([0-9 *]+)`,
      ).exec(registry);
      expect(m, name).not.toBeNull();
      return product(m![1]);
    };
    const hostIpc = code('core/messages/host-ipc.ts');
    const tsDefault = Number(
      /const DEFAULT_HOST_INVOKE_TIMEOUT_MS = (\d+)/.exec(hostIpc)?.[1],
    );
    expect(seconds('defaultInvokeTimeout') * 1000).toBe(tsDefault);
    // The worklet gives up first and reports it; the host never times out a
    // pick the worklet is still waiting for.
    expect(seconds('userMediatedInvokeTimeout') * 1000).toBeGreaterThanOrEqual(
      MEDIA_HOST_TIMEOUT_MS,
    );
    const media = code('examples/ios-app/app/MediaHostPlugins.swift');
    for (const event of ['media.pick', 'media.capture']) {
      expect(media, event).toMatch(
        new RegExp(
          `event: "${event.replace('.', '\\.')}",\\s*timeout: HostPluginRegistry\\.userMediatedInvokeTimeout`,
        ),
      );
    }
    expect(code('ios/Sources/BareHost/DefaultHostPlugins.swift')).toMatch(
      /event: "permissions\.request",\s*timeout: HostPluginRegistry\.userMediatedInvokeTimeout/,
    );
  });
});

describe('iOS wire parity with core/messages/constants.ts', () => {
  it('ErrorCodes.swift lists exactly the canonical error codes', () => {
    const swift = code('ios/Sources/BareHost/ErrorCodes.swift');
    const values = [
      ...swift.matchAll(/public static let \w+ = "([A-Z_]+)"/g),
    ].map((m) => m[1]);
    expect(values.sort()).toEqual(Object.values(ErrorCode).sort());
  });

  it('frame limits and the field cap match', () => {
    const protocol = code('ios/Sources/BareHost/BareProtocol.swift');
    const value = (name: string) =>
      product(
        new RegExp(`static let ${name} = ([0-9a-fx* ]+)`).exec(protocol)?.[1] ??
          '',
      );
    expect(value('maxHeaderBytes')).toBe(MAX_HEADER_BYTES);
    expect(value('maxFrameBytes')).toBe(MAX_FRAME_BYTES);
    expect(code('ios/Sources/BareHost/HostIpcCoordinator.swift')).toContain(
      'public static let maxFieldBytes = 256',
    );
    expect(
      code(
        'android/src/main/java/to/holepunch/bare/android/HostIpcCoordinator.kt',
      ),
    ).toMatch(/MAX_FIELD_BYTES = 256\b/);
  });

  it('handler results are checked before JSONSerialization can throw', () => {
    // `JSONSerialization.data` raises an Objective-C exception that `try?`
    // does not catch: every call site must check `isValidJSONObject` first.
    for (const file of files('ios/Sources', ['.swift'])) {
      const src = code(file);
      const calls =
        src.split('JSONSerialization.data(withJSONObject').length - 1;
      const guards =
        src.split('JSONSerialization.isValidJSONObject').length - 1;
      expect(guards, file).toBeGreaterThanOrEqual(calls);
    }
  });
});

describe('desktop host invariants (docs/security.md §1, §5)', () => {
  it('the backend always runs with auth on and no handoff file', () => {
    const src = code('core/desktop.core.ts');
    // The forced values come after the spread, so no CLI token overrides them.
    expect(src).toMatch(
      /\.\.\.resolveCliConfig\(argv\),\s*deviceMode: true,\s*auth: true,\s*handoffFile: false,/,
    );
    expect(code(MAIN_ZIG)).toContain('"auth=on"');
  });

  it('the window is confined before it navigates to the backend', () => {
    const src = code(MAIN_ZIG);
    expect(src).toMatch(
      /ekrooh_harden\(browser\) != 0\) return error\.WebviewHardeningFailed/,
    );
    // Hardening runs right after the webview exists, before any page.
    expect(src.indexOf('ekrooh_harden(browser)')).toBeLessThan(
      src.indexOf('webview_set_html(w, starting_html)'),
    );
    expect(src).toMatch(
      /allowed_origin = nav\.url;\s*_ = webview_init\(w, nav\.script\);\s*_ = webview_navigate\(w, nav\.url\);/,
    );
    const darwin = code('examples/desktop-app/src/harden_darwin.m');
    expect(darwin).toContain('webView.navigationDelegate = ekroohDelegate');
    expect(darwin).toContain(
      'setValue:@NO forKey:@"javaScriptCanAccessClipboard"',
    );
    expect(darwin).toContain('setValue:@NO forKey:@"DOMPasteAllowed"');
    const gtk = code('examples/desktop-app/src/harden_gtk.c');
    expect(gtk).toContain('"decide-policy"');
    expect(gtk).toContain(
      'webkit_settings_set_javascript_can_access_clipboard(settings, FALSE)',
    );
    const build = code('examples/desktop-app/build.zig');
    expect(build).toContain('b.path("src/harden_darwin.m")');
    expect(build).toContain('b.path("src/harden_gtk.c")');
  });

  it('the nonce is injected on the backend origin only, never escaped in', () => {
    const src = code(MAIN_ZIG);
    expect(src).toContain('if (location.origin === \\"{s}\\") window.__ekrooh');
    expect(src).toContain('return error.UnsafeBootstrap');
    expect(src).toContain('const origin_prefix = "http://127.0.0.1:";');
  });

  it('devtools are on only with --debug', () => {
    expect(code(MAIN_ZIG)).toContain(
      'webview_create(@intFromBool(opts.debug), null)',
    );
  });

  it('the handoff-copy test hook exists only in test-hook builds', () => {
    const src = code(MAIN_ZIG);
    expect(src).toContain(
      'if (build_options.test_hooks) init.environ_map.get("EKROOH_TEST_HANDOFF_COPY") else null',
    );
    expect(src.match(/EKROOH_TEST_HANDOFF_COPY/g)).toHaveLength(1);
    expect(code('examples/desktop-app/build.zig')).toMatch(
      /b\.option\(bool, "test-hooks", "[^"]*"\) orelse false/,
    );
    // The release build never asks for it.
    expect(code('scripts/build-desktop-app.mjs')).not.toContain('test-hooks');
  });

  it('the webview dependency is pinned to a commit and a content hash', () => {
    const zon = read('examples/desktop-app/build.zig.zon');
    expect(zon).toMatch(
      /\.url = "https:\/\/github\.com\/webview\/webview\/archive\/[0-9a-f]{40}\.tar\.gz"/,
    );
    expect(zon).toMatch(/\.hash = "[A-Za-z0-9_-]{20,}"/);
  });
});

// ---------------------------------------------------------------------------

// Public API snapshot of the iOS host Swift package (`BareHost` + the vendored
// `BareKit`), part of vision.md's stability contract alongside the JS exports
// and the Kotlin host API. Every `public`/`open` declaration (and the cases of
// public enums) is extracted from the sources and compared with the committed
// `ios/public-api.swift.snap`. A change fails this test until the snapshot is
// regenerated and the diff is reviewed as a stability-boundary change:
//
//   vp test security.apple.test.ts -u
//
// Extraction reads source text, so it runs anywhere `vp test` does (no Swift
// toolchain). It is a deliberately small parser: comments are dropped and
// brackets inside strings neutralized, braces are tracked to know the enclosing type, and a
// declaration is everything up to its body's `{` (or the end of the
// statement), whitespace-collapsed. Doc comments are not API.

const IOS = path.join(path.dirname(new URL(import.meta.url).pathname), 'ios');
const SOURCE_DIRS = ['Sources/BareHost', 'Sources/BareKit'];

/** Drops comments and neutralizes brackets inside string literals (so they
 * cannot confuse brace tracking), keeping line breaks and string text. */
function clean(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const block = source.slice(i, end === -1 ? n : end + 2);
      out += block.replace(/[^\n]/g, ' ');
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"') {
      // `#"…"#` raw strings are not used in the package sources.
      let literal = '"';
      i++;
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') literal += source[i++];
        literal += source[i++] ?? '';
      }
      out += `${literal.replace(/[{}()[\]]/g, '_')}"`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const TYPE_DECL =
  /^(?:(?:public|open|final|indirect)\s+)*(struct|class|enum|actor|protocol|extension)\s+([A-Za-z_][A-Za-z0-9_.]*)/;

/** `Scope.decl` lines for one file's public surface. */
function publicDeclarations(source: string): string[] {
  const lines = clean(source).split('\n');
  const out: string[] = [];
  // One entry per open brace: the type it opened (public types only), or
  // null for any other block (a body, a closure, a private type).
  const stack: ({ name: string; isEnum: boolean } | null)[] = [];
  let pending: string | null = null; // public declaration being accumulated
  let pendingType: { name: string; isEnum: boolean } | null = null;

  const scope = () =>
    stack
      .filter((s): s is { name: string; isEnum: boolean } => s !== null)
      .map((s) => s.name)
      .join('.');
  const directlyInPublicType = () => {
    const top = stack[stack.length - 1];
    return stack.length === 0 || (top !== null && top !== undefined);
  };
  const record = (decl: string) => {
    const text = decl
      .replace(/\s+/g, ' ')
      .replace(/\s*=\s*$/, '')
      .trim();
    const s = scope();
    out.push(s ? `${s} :: ${text}` : text);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (pending === null && directlyInPublicType()) {
      const top = stack[stack.length - 1];
      if (/^(@\w+(\([^)]*\))?\s+)*(public|open)\b/.test(line)) {
        pending = '';
        const type = TYPE_DECL.exec(
          line.replace(/^(@\w+(\([^)]*\))?\s+)*/, ''),
        );
        pendingType = type
          ? { name: type[2], isEnum: type[1] === 'enum' }
          : null;
      } else if (top?.isEnum && /^case\s/.test(line)) {
        record(line);
      }
    }

    let depth = 0; // paren/bracket depth within the pending declaration
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (pending !== null) {
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === '{' && depth <= 0) {
          record(pending);
          pending = null;
          stack.push(pendingType);
          pendingType = null;
          continue;
        }
        pending += c;
        continue;
      }
      if (c === '{') stack.push(null);
      else if (c === '}') stack.pop();
    }

    if (pending !== null) {
      pending += ' ';
      const text = pending.trim();
      const continues =
        /(=|,|\(|\[|->|:)$/.test(text) ||
        (text.match(/[([]/g)?.length ?? 0) >
          (text.match(/[)\]]/g)?.length ?? 0);
      if (!continues && text !== '') {
        record(pending);
        pending = null;
        pendingType = null;
      }
    }
  }
  return out;
}

function snapshotText(): string {
  const sections: string[] = [];
  for (const dir of SOURCE_DIRS) {
    const files = fs
      .readdirSync(path.join(IOS, dir))
      .filter((f: string) => f.endsWith('.swift'))
      .sort();
    for (const file of files) {
      const decls = publicDeclarations(
        fs.readFileSync(path.join(IOS, dir, file), 'utf8'),
      ).sort();
      if (decls.length > 0)
        sections.push(`# ${dir}/${file}\n${decls.join('\n')}`);
    }
  }
  return `${sections.join('\n\n')}\n`;
}

describe('iOS host public API (vision.md stability contract)', () => {
  it('extracts declarations, enum cases and nesting, ignoring bodies', () => {
    const decls = publicDeclarations(`
      public enum Outer {
        case a(Int)
        public struct Inner: Hashable {
          public let x: String // "{"
          private let hidden = "}"
          public init(x: String) { self.x = x }
        }
        public static func make(
          y: Int = 1
        ) throws -> Outer { switch y { case 1: return .a(1) default: return .a(2) } }
        public var computed: Int { 1 }
        public typealias H =
          (Int) -> Void
      }
      final class Hidden { public func no() {} }
    `);
    expect(decls).toEqual([
      'public enum Outer',
      'Outer :: case a(Int)',
      'Outer :: public struct Inner: Hashable',
      'Outer.Inner :: public let x: String',
      'Outer.Inner :: public init(x: String)',
      'Outer :: public static func make( y: Int = 1 ) throws -> Outer',
      'Outer :: public var computed: Int',
      'Outer :: public typealias H = (Int) -> Void',
    ]);
  });

  it('matches the committed snapshot', async () => {
    await expect(snapshotText()).toMatchFileSnapshot(
      './ios/public-api.swift.snap',
    );
  });
});
