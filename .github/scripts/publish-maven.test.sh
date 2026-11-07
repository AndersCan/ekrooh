#!/usr/bin/env bash
# Dry run of publish-maven.sh `prepare` against the real staged publications,
# signed with a throwaway key (test.yml, linux-android). The release jobs run
# this signing path only on a real tag, so CI proves it here first: the bundle
# layout, the signatures, and the refusals.
#
# Needs: build/maven-staging filled by
#   ./gradlew :bare-host:publishMavenAarPublicationToLocalStagingRepository \
#     :bare-kit-runtime:publishMavenAarPublicationToLocalStagingRepository
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/publish-maven.sh"
STAGING="$ROOT/build/maven-staging"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HOST_VERSION="$(node -p "require('$ROOT/package.json').version")"
RUNTIME_VERSION="$(node -p "require('$ROOT/scripts/prebuilds.lock.json').maven['bare-kit-runtime']")"
GROUP_PATH="io/github/anderscan/ekrooh"

fail() {
  echo "::error::$*" >&2
  exit 1
}

export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --pinentry-mode loopback --passphrase test \
  --quick-gen-key 'publish-maven test <test@example.invalid>' ed25519 sign never
SIGNING_KEY="$(gpg --batch --pinentry-mode loopback --passphrase test --armor --export-secret-keys)"
export SIGNING_KEY SIGNING_PASSWORD=test

check_bundle() {
  local a="$1" v="$2" out="$3" dir n
  dir="$out/repo/$GROUP_PATH/$a/$v"
  for f in "$a-$v.aar" "$a-$v.pom" "$a-$v.module" "$a-$v-sources.jar" "$a-$v-javadoc.jar"; do
    for ext in "" .asc .md5 .sha1; do
      unzip -l "$out/bundle.zip" "$GROUP_PATH/$a/$v/$f$ext" >/dev/null || fail "bundle lacks $f$ext"
    done
    gpg --batch --quiet --verify "$dir/$f.asc" "$dir/$f" 2>/dev/null || fail "bad signature on $f"
    [ "$(cat "$dir/$f.sha1")" = "$(sha1sum "$dir/$f" | cut -d' ' -f1)" ] || fail "bad sha1 for $f"
  done
  n="$(unzip -Z1 "$out/bundle.zip" | grep -vc '/$')"
  [ "$n" -eq 20 ] || fail "$a bundle has $n files, expected 20"
  echo "ok: $a $v bundle (20 files, signatures verify)"
}

"$SCRIPT" prepare "$STAGING" bare-host "$HOST_VERSION" "$WORK/host" >/dev/null
check_bundle bare-host "$HOST_VERSION" "$WORK/host"
"$SCRIPT" prepare "$STAGING" bare-kit-runtime "$RUNTIME_VERSION" "$WORK/runtime" >/dev/null
check_bundle bare-kit-runtime "$RUNTIME_VERSION" "$WORK/runtime"

# Refusals, on a copy of the staging repository.
refuse() {
  local why="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "accepted: $why"; fi
  echo "ok: refuses $why"
}
cp -R "$STAGING" "$WORK/st"
D="$WORK/st/$GROUP_PATH/bare-host/$HOST_VERSION"
echo x >"$D/extra.sh"
refuse "an unexpected file" "$SCRIPT" prepare "$WORK/st" bare-host "$HOST_VERSION" "$WORK/o1"
rm "$D/extra.sh"
rm -f "$D/bare-host-$HOST_VERSION.pom.sha512"
ln -s /etc/passwd "$D/bare-host-$HOST_VERSION.pom.sha512"
refuse "a symlink" "$SCRIPT" prepare "$WORK/st" bare-host "$HOST_VERSION" "$WORK/o2"
rm "$D/bare-host-$HOST_VERSION.pom.sha512"
mv "$D/bare-host-$HOST_VERSION-javadoc.jar" "$WORK/javadoc.jar"
refuse "a missing javadoc jar" "$SCRIPT" prepare "$WORK/st" bare-host "$HOST_VERSION" "$WORK/o3"
mv "$WORK/javadoc.jar" "$D/bare-host-$HOST_VERSION-javadoc.jar"
refuse "a wrong key password" env SIGNING_PASSWORD=wrong "$SCRIPT" prepare "$WORK/st" bare-host "$HOST_VERSION" "$WORK/o4"
refuse "no signing key" env -u SIGNING_KEY "$SCRIPT" prepare "$WORK/st" bare-host "$HOST_VERSION" "$WORK/o5"
refuse "a bad version" "$SCRIPT" prepare "$WORK/st" bare-host "1.0;id" "$WORK/o6"
refuse "a bad artifactId" "$SCRIPT" prepare "$WORK/st" ../bare-host "$HOST_VERSION" "$WORK/o7"
# Control: the restored copy prepares again.
"$SCRIPT" prepare "$WORK/st" bare-host "$HOST_VERSION" "$WORK/o8" >/dev/null || fail "restored copy refused"
echo "publish-maven.sh: all checks passed"
