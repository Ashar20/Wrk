#!/bin/sh
# Copies the reference TS modules to a temp dir (adding .ts import suffixes so
# Node can strip types natively) and regenerates golden vectors.
set -e
R=${REF_SRC:-/Users/silas/worldmod/web/src/lib}
T=$(mktemp -d)
mkdir -p "$T/manifest" "$T/capture"
cp "$R/manifest/canonicalize.ts" "$R/manifest/hash.ts" "$T/manifest/"
cp "$R/capture/imu-codec.ts" "$T/capture/"
sed -i.bak 's#from "./canonicalize"#from "./canonicalize.ts"#' "$T/manifest/hash.ts"
cd "$(dirname "$0")/.."
REF="$T" node --experimental-strip-types --no-warnings scripts/gen-golden.mjs
