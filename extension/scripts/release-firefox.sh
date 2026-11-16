#!/usr/bin/env bash
# Firefox 版を出す: manifest.json の版を Mozilla の非公開署名 (AMO unlisted、鍵はキーチェーン) に通し、
# GitHub Release v<版> に red-marker-page-<版>.xpi と updates.json を添付する。
# v<版> のタグを push した後に叩く (Release 自体は release.yml が作るので、出来るまで待つ)。
# updates.json は拡張の update_url (releases/latest/download/updates.json) が読む確かめ先。
# xpi より先に上げると、まだ無い xpi を指してしまうので最後に上げる。
# 使い方: cd extension && npm run release:firefox
set -euo pipefail
cd "$(dirname "$0")/.."

repo=ktsm-yt/rmp
id=red-marker-page@ktsm-yt.github.io
update_url="https://github.com/$repo/releases/latest/download/updates.json"
v=$(node -p 'require("./manifest.json").version')
tag="v$v"
xpi="red-marker-page-$v.xpi"

# 同じ版は AMO で 1 回しか署名できないので、前に署名した物があればそれを使う。
signed=$(ls web-ext-artifacts/*-"$v".xpi 2>/dev/null | head -n 1 || true)
if [ -z "$signed" ]; then
  npm run build:firefox
  WEB_EXT_API_KEY=$(security find-generic-password -s amo-jwt-issuer -w) \
  WEB_EXT_API_SECRET=$(security find-generic-password -s amo-jwt-secret -w) \
    npx --yes web-ext@10.8.0 sign --channel=unlisted --source-dir dist-firefox
  signed=$(ls web-ext-artifacts/*-"$v".xpi | head -n 1)
fi
# 確かめ先の無い xpi を配ると、その版の人は自動更新されず手で入れ直すことになる。
unzip -p "$signed" manifest.json | grep -qF "\"update_url\": \"$update_url\"" || {
  echo "$signed に update_url ($update_url) が入っていない" >&2
  exit 1
}

out=$(mktemp -d)
cp "$signed" "$out/$xpi"
hash=$(shasum -a 256 "$out/$xpi" | cut -d' ' -f1)
cat > "$out/updates.json" <<EOF
{"addons": {"$id": {"updates": [{"version": "$v", "update_link": "https://github.com/$repo/releases/download/$tag/$xpi", "update_hash": "sha256:$hash"}]}}}
EOF

for _ in $(seq 60); do
  gh release view "$tag" -R "$repo" > /dev/null 2>&1 && break
  echo "Release $tag ができるのを待っています (release.yml)"
  sleep 10
done
gh release upload "$tag" -R "$repo" --clobber "$out/$xpi"
gh release upload "$tag" -R "$repo" --clobber "$out/updates.json"
echo "添付した: $xpi と updates.json → https://github.com/$repo/releases/tag/$tag"
