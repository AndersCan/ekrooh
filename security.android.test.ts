import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";

// Greppable Android-host invariants from docs/security.md section 5. Each
// check reads files only; behavior is pinned by the JUnit tests in
// android/src/test and the emulator journey test
// (examples/android-app/src/androidTest/.../ReferenceJourneyTest.kt).

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const APP = "examples/android-app/src/main";
const KOTLIN = "java/to/holepunch/bare/android";
const HOST = `android/src/main/${KOTLIN}`;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Kotlin sources under `dir`, as repo-relative paths. */
function kotlinFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), {
      withFileTypes: true,
    })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".kt")) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** Source with `//` line comments and block comments removed. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** XML with comments removed (an unterminated comment drops the rest). */
function xml(rel: string): string {
  let src = read(rel);
  let out = "";
  for (;;) {
    const start = src.indexOf("<!--");
    if (start === -1) return out + src;
    out += src.slice(0, start);
    const end = src.indexOf("-->", start + 4);
    if (end === -1) return out;
    src = src.slice(end + 3);
  }
}

const shipped = [...kotlinFiles(`${APP}/java`), ...kotlinFiles(HOST)];

describe("Android WebView", () => {
  const activity = code(`${APP}/${KOTLIN}/MainActivity.kt`);

  it("has file and content access off and never allows mixed content", () => {
    expect(activity).toMatch(/settings\.allowFileAccess = false/);
    expect(activity).toMatch(/settings\.allowContentAccess = false/);
    expect(activity).toMatch(/MIXED_CONTENT_NEVER_ALLOW/);
    for (const file of shipped) {
      const src = code(file);
      expect(src, file).not.toMatch(/allow(File|Content)Access\s*=\s*true/);
      expect(src, file).not.toMatch(/allowUniversalAccessFromFileURLs/);
      expect(src, file).not.toMatch(/allowFileAccessFromFileURLs/);
      expect(src, file).not.toMatch(/MIXED_CONTENT_ALWAYS_ALLOW/);
    }
  });

  it("exposes no JS interface and does not force web debugging on", () => {
    for (const file of shipped) {
      const src = code(file);
      expect(src, file).not.toMatch(/addJavascriptInterface/);
      expect(src, file).not.toMatch(/setWebContentsDebuggingEnabled\(\s*true/);
    }
  });

  it("opens web debugging only when the build has a dev server", () => {
    const starter = code(
      "examples/vote/android/app/src/main/java/com/example/vote/MainActivity.kt",
    );
    expect(starter).toMatch(
      /setWebContentsDebuggingEnabled\(BuildConfig\.DEV_SERVER_URL\.isNotEmpty\(\)\)/,
    );
  });

  it("injects the bootstrap only into the handoff origin, once, after a feature check", () => {
    expect(activity).toMatch(
      /WebViewFeature\.isFeatureSupported\(WebViewFeature\.DOCUMENT_START_SCRIPT\)/,
    );
    const calls = [
      ...activity.matchAll(/addDocumentStartJavaScript\(([\s\S]*?)\)\n/g),
    ];
    expect(calls).toHaveLength(1);
    // The origin rule is the handoff's exact origin, never a wildcard.
    expect(calls[0][1]).toMatch(/setOf\(handoff\.origin\)/);
    expect(activity).not.toMatch(/setOf\("\*"\)/);
    // Removed after the first load (A-7): later documents get no nonce.
    expect(activity).toMatch(
      /val script = bootstrapScript \?: return\s+script\.remove\(\)/,
    );
    // Confinement and page URL come from the same checked origin (E-13).
    expect(activity).toMatch(/allowedOrigin = handoff\.origin/);
    expect(activity).toMatch(/loadUrl\(handoff\.indexUrl\)/);
  });

  it("confines POST navigations and opens the browser only on a gesture", () => {
    const client = code(`${HOST}/BareWebViewClient.kt`);
    expect(client).toMatch(/override fun shouldInterceptRequest/);
    expect(client).toMatch(
      /shouldOpenExternally\(url, request\.hasGesture\(\)\)/,
    );
  });
});

describe("Android handoff", () => {
  it("reads the handoff only through BareHandoff, which deletes it and never logs it", () => {
    const handoff = code(`${HOST}/BareHandoff.kt`);
    expect(handoff).toMatch(/file\.delete\(\)/);
    expect(handoff).not.toMatch(/Log\./);
    for (const file of kotlinFiles(`${APP}/java`)) {
      // No ad-hoc reads (and so no logging) of handoff.json in the shell.
      expect(code(file), file).not.toMatch(/readText\(\)/);
    }
    expect(code(`${APP}/${KOTLIN}/ReferenceHost.kt`)).toMatch(
      /BareHandoff\.consume\(/,
    );
  });

  it("keeps durable storage out of the cache dir, migrating without data loss", () => {
    const host = code(`${APP}/${KOTLIN}/ReferenceHost.kt`);
    expect(host).toMatch(
      /val storageDir: File get\(\) = activeStorage \?: File\(app\.noBackupFilesDir, "bare"\)/,
    );
    // The move goes through StorageMigration (pinned by StorageMigrationTest).
    expect(host).toMatch(/activeStorage = StorageMigration\.resolve\(/);
  });

  it("keeps polling for a late handoff after showing the error", () => {
    const host = code(`${APP}/${KOTLIN}/ReferenceHost.kt`);
    expect(host).toMatch(/main\.postDelayed\(this, HANDOFF_SLOW_POLL_MS\)/);
    expect(host).not.toMatch(/finishHandoff\(null\)/);
  });

  it("does not re-inject a spent bootstrap nonce into a later WebView", () => {
    const activity = code(`${APP}/${KOTLIN}/MainActivity.kt`);
    expect(activity).toMatch(
      /if \(host\.bootstrapDelivered\) \{[\s\S]*?\} else if \(WebViewFeature\.isFeatureSupported/,
    );
    expect(activity).toMatch(/host\.markBootstrapDelivered\(\)/);
  });
});

describe("Android IPC", () => {
  it("writes frames only through the serialized writer", () => {
    const coordinator = code(`${HOST}/HostIpcCoordinator.kt`);
    // The single raw write is the Port adapter; every frame goes via send().
    expect([...coordinator.matchAll(/ipc\.write\(/g)]).toHaveLength(1);
    // stop() changes the readable callback under the writer's lock.
    expect(coordinator).toMatch(
      /fun stop\(\) \{[\s\S]*?synchronized\(outboundLock\) \{\s*port\.readable\(null\)/,
    );
    expect(coordinator).toMatch(/val written = try \{\s*port\.write\(head\)/);
  });
});

describe("Android manifest and resources", () => {
  const manifest = xml(`${APP}/AndroidManifest.xml`);

  it("disables backup and points at complete exclusion rules", () => {
    expect(manifest).toMatch(/android:allowBackup="false"/);
    expect(manifest).toMatch(
      /android:dataExtractionRules="@xml\/data_extraction_rules"/,
    );
    expect(manifest).toMatch(/android:fullBackupContent="@xml\/backup_rules"/);
    expect(manifest).not.toMatch(/usesCleartextTraffic="true"/);
  });

  it("exports only the launcher activity, as singleTop, and a private FileProvider", () => {
    const exported = [...manifest.matchAll(/android:exported="true"/g)];
    expect(exported).toHaveLength(1);
    expect(manifest).toMatch(
      /<activity\s+android:name="to\.holepunch\.bare\.android\.MainActivity"[\s\S]*?android:exported="true"[\s\S]*?android:launchMode="singleTop"/,
    );
    // singleTask/singleInstance would clear the camera, picker and permission
    // screens when the user returns through the launcher icon.
    expect(manifest).not.toMatch(/singleTask|singleInstance/);
    const changes = manifest
      .match(/android:configChanges="([^"]*)"/)?.[1]
      .split("|");
    for (const c of [
      "orientation",
      "screenSize",
      "screenLayout",
      "smallestScreenSize",
      "keyboardHidden",
      "uiMode",
      "density",
      "fontScale",
      "locale",
      "layoutDirection",
    ]) {
      expect(changes, c).toContain(c);
    }
    const filters = [
      ...manifest.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g),
    ];
    expect(filters).toHaveLength(1);
    expect(filters[0][1]).not.toMatch(/<data\b/);
    expect(filters[0][1]).not.toMatch(/BROWSABLE/);
    expect(manifest).toMatch(
      /<provider[\s\S]*?android:exported="false"[\s\S]*?<\/provider>/,
    );
    expect(manifest).not.toMatch(/<receiver\b|<service\b/);
  });

  it("runs the worklet in the Application, not per Activity", () => {
    expect(manifest).toMatch(
      /android:name="to\.holepunch\.bare\.android\.BareApplication"/,
    );
    expect(code(`${APP}/${KOTLIN}/MainActivity.kt`)).not.toMatch(/Worklet\(/);
  });

  it("declares CAMERA so the permission dialog can be shown", () => {
    expect(manifest).toMatch(
      /<uses-permission android:name="android\.permission\.CAMERA" \/>/,
    );
  });

  it("allows cleartext only to the loopback hosts", () => {
    const nsc = xml(`${APP}/res/xml/network_security_config.xml`);
    expect(nsc).toMatch(/<base-config cleartextTrafficPermitted="false"/);
    const domains = [...nsc.matchAll(/<domain\b[^>]*>([^<]*)<\/domain>/g)].map(
      (m) => m[1].trim(),
    );
    expect(domains.sort()).toEqual(["127.0.0.1", "localhost"]);
    expect(nsc).not.toMatch(/includeSubdomains="true"/);
    expect(nsc).not.toMatch(/<certificates src="user"/);
  });

  const domains = [
    "root",
    "file",
    "database",
    "sharedpref",
    "external",
    "device_root",
    "device_file",
    "device_database",
    "device_sharedpref",
  ];
  const excluded = (section: string) =>
    [...section.matchAll(/<exclude domain="([a-z_]+)" path="\." \/>/g)]
      .map((m) => m[1])
      .sort();

  it("excludes every domain from full backup", () => {
    const rules = xml(`${APP}/res/xml/backup_rules.xml`);
    expect(rules).not.toMatch(/<include\b/);
    expect(excluded(rules)).toEqual([...domains].sort());
  });

  it("excludes every domain from cloud backup and device transfer", () => {
    const rules = xml(`${APP}/res/xml/data_extraction_rules.xml`);
    expect(rules).not.toMatch(/<include\b/);
    for (const tag of ["cloud-backup", "device-transfer"]) {
      const section = rules.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      expect(section, tag).not.toBeNull();
      expect(excluded(section![1]), tag).toEqual([...domains].sort());
    }
  });

  it("keeps the p2p verify bundle out of the app APK", () => {
    const gradle = read("examples/android-app/build.gradle");
    expect(gradle).not.toMatch(/src\/main\/assets\/p2p-verify/);
    expect(gradle).toMatch(/src\/androidTest\/assets\/p2p-verify\.bundle/);
  });
});

describe("Kotlin host public API", () => {
  it("is dumped and checked as part of the Gradle build", () => {
    const gradle = read("android/build.gradle");
    expect(gradle).toMatch(
      /tasks\.named\("check"\) \{ dependsOn "apiCheck" \}/,
    );
    const dump = read("android/api/bare-host.api");
    // Private implementation constants must not leak as public static fields.
    expect(dump).not.toMatch(/MIN_PARTIAL_BYTES|RETAIN_BYTES/);
  });
});

describe("Gradle dependency verification", () => {
  it("verifies every artifact against committed checksums, aapt2 on every CI OS", () => {
    const meta = read("gradle/verification-metadata.xml");
    expect(meta).toMatch(/<verify-metadata>true<\/verify-metadata>/);
    expect(meta).not.toMatch(/<trusted-artifacts>/);
    for (const os of ["linux", "osx"]) {
      expect(meta).toMatch(
        new RegExp(`artifact name="aapt2-[^"]+-${os}\\.jar"`),
      );
    }
  });
});
