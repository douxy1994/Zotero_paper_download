#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
cd "$ROOT"

VERSION=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
TMP_BUILD=$(mktemp -d "${TMPDIR:-/tmp}/skill-fulltext-zotero-${VERSION}.XXXXXX")
TMP_XPI="$TMP_BUILD/skill-fulltext-zotero.xpi"
trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$TMP_BUILD"' EXIT

zip -X -q -r "$TMP_XPI" \
  manifest.json bootstrap.js skill-fulltext-downloader.js README.md locale content

HASH=$(shasum -a 256 "$TMP_XPI" | awk '{print $1}')
cp "$TMP_XPI" skill-fulltext-zotero.xpi

python3 - "$VERSION" "$HASH" <<'PY'
import json
import sys
from pathlib import Path

version, digest = sys.argv[1:]
path = Path("updates.json")
data = json.loads(path.read_text())
addon_id = "skill-fulltext-downloader@example.com"
updates = data["addons"][addon_id]["updates"]
entry = {
    "version": version,
    "update_link": (
        "https://github.com/douxy1994/Zotero_paper_download/"
        f"releases/download/v{version}/skill-fulltext-zotero.xpi"
    ),
    "update_hash": f"sha256:{digest}",
    "applications": {
        "zotero": {
            "strict_min_version": "6.999",
            "strict_max_version": "9.0.*",
        }
    },
}
updates[:] = [entry] + [item for item in updates if item.get("version") != version]
tmp = path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
tmp.replace(path)
PY

unzip -t skill-fulltext-zotero.xpi >/dev/null
printf 'version=%s\nsha256=%s\nxpi=%s\n' "$VERSION" "$HASH" "$ROOT/skill-fulltext-zotero.xpi"
