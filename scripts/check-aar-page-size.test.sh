#!/usr/bin/env bash
# Tests check-aar-page-size.sh with a stub unzip (creates empty .so files from
# $STUB_SOS) and a stub readelf (prints $STUB_ALIGN, or fails if STUB_FAIL=1).
set -uo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat > "$tmp/bin/unzip" <<'STUB'
#!/usr/bin/env bash
dest="$4"
for so in $STUB_SOS; do
  mkdir -p "$dest/$(dirname "$so")"
  : > "$dest/$so"
done
STUB
cat > "$tmp/bin/readelf" <<'STUB'
#!/usr/bin/env bash
[ "${STUB_FAIL:-0}" = 1 ] && exit 2
for a in $STUB_ALIGN; do
  echo "  LOAD           0x000000 0x0000000000000000 0x0000000000000000 0x001000 0x001000 R E $a"
done
STUB
chmod +x "$tmp/bin/"*

failures=0
expect() {
  local want="$1" name="$2"
  shift 2
  if env PATH="$tmp/bin:$PATH" READELF="$tmp/bin/readelf" "$@" \
    "$root/check-aar-page-size.sh" x.aar >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name (exit nonzero=$got, want $want)"
    failures=$((failures + 1))
  fi
}

expect 0 "0x4000 passes" STUB_SOS="jni/arm64-v8a/a.so" STUB_ALIGN="0x4000 0x4000"
expect 1 "0x1000 fails" STUB_SOS="jni/arm64-v8a/a.so" STUB_ALIGN="0x1000"
expect 1 "one bad segment fails" STUB_SOS="jni/x86_64/a.so" STUB_ALIGN="0x4000 0x1000"
expect 1 "readelf failure fails" STUB_SOS="jni/arm64-v8a/a.so" STUB_ALIGN="0x4000" STUB_FAIL=1
expect 1 "no LOAD lines fails" STUB_SOS="jni/arm64-v8a/a.so" STUB_ALIGN=""
expect 1 "no 64-bit .so fails" STUB_SOS="jni/armeabi-v7a/a.so" STUB_ALIGN="0x4000"

[ "$failures" -eq 0 ] && echo "all passed"
exit "$failures"
