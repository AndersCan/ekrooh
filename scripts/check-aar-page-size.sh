#!/usr/bin/env bash
# Fails if any LOAD segment of a 64-bit .so in the AAR (or AAB) is aligned
# below 0x4000 (16 KB), which Google Play rejects.
# Usage: READELF=llvm-readelf scripts/check-aar-page-size.sh <file.aar> [jni|base/lib]
set -euo pipefail

archive="${1:?usage: check-aar-page-size.sh <archive> [lib-prefix]}"
prefix="${2:-jni}"
readelf="${READELF:-llvm-readelf}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

unzip -q "$archive" -d "$dir"
fail=0
count=0
for abi in arm64-v8a x86_64; do
  for so in "$dir/$prefix/$abi"/*.so; do
    [ -e "$so" ] || continue
    count=$((count + 1))
    while read -r align; do
      echo "$prefix/$abi/$(basename "$so") LOAD align $align"
      if [ $((align)) -lt $((0x4000)) ]; then
        echo "  ^ below 0x4000" >&2
        fail=1
      fi
    done < <("$readelf" -lW "$so" | awk '$1 == "LOAD" { print $NF }')
  done
done

if [ "$count" -eq 0 ]; then
  echo "no 64-bit .so files found under $prefix" >&2
  exit 1
fi
exit "$fail"
