#!/usr/bin/env bash
# Vendors Mozilla's prebuilt pdf.js viewer (the one Firefox ships) into extension/public/pdfjs.
# Usage: extension/scripts/vendor-pdfjs.sh [version]   (default: the version below)
set -euo pipefail
VERSION="${1:-6.4.299}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/public/pdfjs"
TMP="$(mktemp -d)"
gh release download "v$VERSION" --repo mozilla/pdf.js --pattern "pdfjs-$VERSION-dist.zip" --dir "$TMP"
unzip -q "$TMP/pdfjs-$VERSION-dist.zip" -d "$TMP/dist"
# ponytail: keep only what the viewer loads at runtime (maps, sample PDF, debugger, other locales go).
find "$TMP/dist" -name '*.map' -delete
rm -f "$TMP/dist/web/compressed.tracemonkey-pldi-09.pdf" "$TMP/dist/web/debugger.css" "$TMP/dist/web/debugger.mjs"
for d in "$TMP/dist/web/locale"/*/; do
  case "$(basename "$d")" in en-US|ja) ;; *) rm -r "$d" ;; esac
done
python3 - "$TMP/dist/web/locale/locale.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
json.dump({k: v for k, v in d.items() if k in ("en-US", "ja")}, open(p, "w"))
PY
# The viewer refuses files from another origin unless it is hosted on mozilla.github.io;
# our extension origin opens the PDF the user pressed the button on.
perl -0pi -e 's/if \(HOSTED_VIEWER_ORIGINS\.has\(viewerOrigin\)\) \{/if (HOSTED_VIEWER_ORIGINS.has(viewerOrigin) || \/^(chrome|moz)-extension:\/.test(viewerOrigin)) {/' "$TMP/dist/web/viewer.mjs"
grep -q 'moz)-extension' "$TMP/dist/web/viewer.mjs" || { echo "origin patch failed" >&2; exit 1; }
# Our glue (viewer.js) and the annotation overlay (overlay.js) ride along at the end of the page.
perl -pi -e 's#</body>#  <script src="../../viewer.js"></script>\n  <script src="../../overlay.js"></script>\n</body>#' "$TMP/dist/web/viewer.html"
grep -q 'overlay.js' "$TMP/dist/web/viewer.html" || { echo "viewer.html patch failed" >&2; exit 1; }
# The page's own CSP (style-src 'self') would drop the overlay's inline stylesheet.
perl -pi -e "s#style-src 'self';#style-src 'self' 'unsafe-inline';#" "$TMP/dist/web/viewer.html"
# connect-src '*' covers network schemes only; local PDFs are file: URLs.
perl -pi -e "s#connect-src \* blob: data:;#connect-src * blob: data: file:;#" "$TMP/dist/web/viewer.html"
grep -q "style-src 'self' 'unsafe-inline'" "$TMP/dist/web/viewer.html" && grep -q "connect-src \* blob: data: file:" "$TMP/dist/web/viewer.html" || { echo "csp patch failed" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$TMP/dist/build" "$TMP/dist/web" "$TMP/dist/LICENSE" "$OUT/"
echo "$VERSION" > "$OUT/VERSION"
du -sh "$OUT"
