#!/usr/bin/env bash
# Sign and upload one Maven artifact without running Gradle.
#
# The credential-free build job runs Gradle once, publishing the release
# variant to a local file repository (`build/maven-staging`, the
# `LocalStaging` repository in the Gradle builds). The publish job downloads
# that directory and runs this script, so no build tool or dependency code
# runs next to the signing key or the Sonatype / GitHub tokens
# (docs/security.md, "Release pipeline").
#
# Usage:
#   publish-maven.sh prepare <staging-dir> <artifactId> <version> <out-dir>
#       Checks the staged files are exactly the expected publication, copies
#       them to <out-dir>/repo, writes fresh .md5/.sha1 checksums and detached
#       .asc signatures (SIGNING_KEY, SIGNING_PASSWORD), verifies every
#       signature, and zips the Central Portal bundle to <out-dir>/bundle.zip.
#   publish-maven.sh central <out-dir> <artifactId> <version>
#       Uploads bundle.zip to the Sonatype Central Portal (SONATYPE_USERNAME,
#       SONATYPE_PASSWORD: a portal user token) and waits until it publishes.
#       Skips when the version is already on Maven Central.
#   publish-maven.sh github <out-dir> <artifactId> <version>
#       Uploads the signed files to GitHub Packages (GITHUB_ACTOR,
#       GITHUB_TOKEN). Skips when the version is already there.
#
# Only bash, coreutils, gpg, zip, curl and jq are used (all on ubuntu-latest).
set -euo pipefail

GROUP="io.github.anderscan.ekrooh"
GROUP_PATH="${GROUP//.//}"
CENTRAL="https://central.sonatype.com/api/v1/publisher"
GITHUB_REPO="https://maven.pkg.github.com/AndersCan/ekrooh"

die() {
  echo "::error::$*" >&2
  exit 1
}

check_coords() {
  [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]] || die "bad artifactId '$1'"
  [[ "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "bad version '$2'"
}

# The five files every Android library publication here has.
expected_files() {
  local a="$1" v="$2"
  printf '%s\n' "$a-$v.aar" "$a-$v.pom" "$a-$v.module" "$a-$v-sources.jar" "$a-$v-javadoc.jar"
}

# A curl header file, so tokens never appear in a process argument list.
auth_header_file() {
  local file
  file="$(mktemp)"
  chmod 600 "$file"
  printf '%s\n' "$1" >"$file"
  echo "$file"
}

prepare() {
  local staging="$1" a="$2" v="$3" out="$4"
  check_coords "$a" "$v"
  [ -n "${SIGNING_KEY:-}" ] || die "SIGNING_KEY is not set"
  [ -d "$staging/$GROUP_PATH/$a" ] || die "nothing staged for $a under $staging"
  [ ! -e "$out" ] || die "$out already exists"

  local dir="$GROUP_PATH/$a/$v"
  local -a want
  mapfile -t want < <(expected_files "$a" "$v")

  # Every entry under the artifact's directory must be one of the expected
  # files, a checksum of one, or Gradle's maven-metadata.xml (and its
  # checksums). Nothing else, and no symlinks: what gets signed is exactly the
  # publication. Other artifacts in the same staging repository are ignored.
  local entry rel name ok
  while IFS= read -r -d '' entry; do
    rel="${entry#"$staging"/}"
    [ -f "$entry" ] && [ ! -L "$entry" ] || die "unexpected non-file entry: $rel"
    name="${rel##*/}"
    ok=false
    if [ "$rel" = "$dir/$name" ]; then
      for f in "${want[@]}"; do
        case "$name" in
          "$f" | "$f".md5 | "$f".sha1 | "$f".sha256 | "$f".sha512) ok=true ;;
        esac
      done
    elif [ "$rel" = "$GROUP_PATH/$a/$name" ]; then
      case "$name" in
        maven-metadata.xml | maven-metadata.xml.md5 | maven-metadata.xml.sha1 | \
          maven-metadata.xml.sha256 | maven-metadata.xml.sha512) ok=true ;;
      esac
    fi
    $ok || die "unexpected file in the staging repository: $rel"
  done < <(find "$staging/$GROUP_PATH/$a" -mindepth 1 ! -type d -print0)
  for f in "${want[@]}"; do
    [ -f "$staging/$dir/$f" ] || die "missing $dir/$f"
  done

  # Copy only the publication; checksums are recomputed here, not trusted.
  mkdir -p "$out/repo/$dir"
  for f in "${want[@]}"; do
    cp "$staging/$dir/$f" "$out/repo/$dir/$f"
  done

  local gnupg
  gnupg="$(mktemp -d)"
  chmod 700 "$gnupg"
  # shellcheck disable=SC2064
  trap "rm -rf '$gnupg'" EXIT
  printf '%s\n' "$SIGNING_KEY" | GNUPGHOME="$gnupg" gpg --batch --quiet --import
  (
    cd "$out/repo/$dir"
    for f in "${want[@]}"; do
      md5sum "$f" | cut -d' ' -f1 | tr -d '\n' >"$f.md5"
      sha1sum "$f" | cut -d' ' -f1 | tr -d '\n' >"$f.sha1"
      printf '%s' "${SIGNING_PASSWORD:-}" | GNUPGHOME="$gnupg" gpg --batch --yes --quiet \
        --pinentry-mode loopback --passphrase-fd 0 \
        --armor --detach-sign --output "$f.asc" "$f"
      GNUPGHOME="$gnupg" gpg --batch --quiet --verify "$f.asc" "$f" 2>/dev/null ||
        die "signature check failed for $f"
    done
  )
  (cd "$out/repo" && zip -q -r -X ../bundle.zip "$GROUP_PATH")
  echo "Prepared $GROUP:$a:$v:"
  (cd "$out/repo" && find . -type f | sort)
}

central() {
  local out="$1" a="$2" v="$3"
  check_coords "$a" "$v"
  [ -f "$out/bundle.zip" ] || die "no bundle at $out/bundle.zip (run prepare first)"
  local pom="https://repo1.maven.org/maven2/$GROUP_PATH/$a/$v/$a-$v.pom"
  if curl -fsSI "$pom" >/dev/null 2>&1; then
    echo "Maven Central: $a $v is already published, skipping"
    return 0
  fi
  [ -n "${SONATYPE_USERNAME:-}" ] && [ -n "${SONATYPE_PASSWORD:-}" ] ||
    die "SONATYPE_USERNAME / SONATYPE_PASSWORD are not set"
  local token hdr id state body
  token="$(printf '%s:%s' "$SONATYPE_USERNAME" "$SONATYPE_PASSWORD" | base64 | tr -d '\n')"
  hdr="$(auth_header_file "Authorization: Bearer $token")"
  # shellcheck disable=SC2064
  trap "rm -f '$hdr'" EXIT
  id="$(curl -fsS --retry 3 -H @"$hdr" -F "bundle=@$out/bundle.zip" \
    "$CENTRAL/upload?name=$a-$v&publishingType=AUTOMATIC")"
  [[ "$id" =~ ^[0-9a-fA-F-]+$ ]] || die "unexpected upload response: $id"
  echo "Central Portal deployment $id uploaded; waiting for it to publish"
  # Validation plus publishing usually takes a few minutes; allow 40.
  for _ in $(seq 1 160); do
    body="$(curl -fsS --retry 3 -X POST -H @"$hdr" "$CENTRAL/status?id=$id")"
    state="$(jq -r '.deploymentState' <<<"$body")"
    case "$state" in
      PUBLISHING | PUBLISHED)
        echo "Central Portal deployment $id: $state (repo1.maven.org can take about 30 minutes to sync)"
        return 0
        ;;
      FAILED)
        jq '.errors' <<<"$body" >&2 || true
        die "Central Portal deployment $id failed validation"
        ;;
      PENDING | VALIDATING | VALIDATED) sleep 15 ;;
      *) die "unexpected deployment state '$state'" ;;
    esac
  done
  die "Central Portal deployment $id did not publish within 40 minutes (state $state)"
}

github() {
  local out="$1" a="$2" v="$3"
  check_coords "$a" "$v"
  [ -n "${GITHUB_TOKEN:-}" ] || die "GITHUB_TOKEN is not set"
  local dir="$GROUP_PATH/$a/$v" hdr
  [ -d "$out/repo/$dir" ] || die "no signed files at $out/repo/$dir (run prepare first)"
  hdr="$(auth_header_file "Authorization: Bearer $GITHUB_TOKEN")"
  # shellcheck disable=SC2064
  trap "rm -f '$hdr'" EXIT
  if curl -fsS -H @"$hdr" "$GITHUB_REPO/$GROUP_PATH/$a/maven-metadata.xml" 2>/dev/null |
    grep -q "<version>$v</version>"; then
    echo "GitHub Packages: $a $v is already published, skipping"
    return 0
  fi
  # The POM goes last: once it exists the version resolves.
  local f
  for f in $(cd "$out/repo/$dir" && ls | grep -v '\.pom') $(cd "$out/repo/$dir" && ls | grep '\.pom'); do
    curl -fsS --retry 3 -H @"$hdr" --upload-file "$out/repo/$dir/$f" "$GITHUB_REPO/$dir/$f" >/dev/null
    echo "GitHub Packages: uploaded $f"
  done
}

cmd="${1:-}"
shift || true
case "$cmd" in
  prepare) [ $# -eq 4 ] || die "usage: prepare <staging-dir> <artifactId> <version> <out-dir>"; prepare "$@" ;;
  central) [ $# -eq 3 ] || die "usage: central <out-dir> <artifactId> <version>"; central "$@" ;;
  github) [ $# -eq 3 ] || die "usage: github <out-dir> <artifactId> <version>"; github "$@" ;;
  *) die "usage: publish-maven.sh prepare|central|github ..." ;;
esac
