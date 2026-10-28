#!/bin/bash
# e2e デモ動画の合成: videos.json の順に WebM と各章の segments をつなぐ。
# 使い方: scripts/e2e-demo-video.sh <test出力dir> [out.mp4]
# 較正: OFFSET_MS=500 で全ナレーションを 500ms 後ろへずらす。
# 既定は聞き取れる等速。SPEED=2.5 のように明示すればピッチを保って倍速化する。
set -euo pipefail

DIR="${1:?usage: e2e-demo-video.sh <output-dir> [out.mp4]}"
DIR="$(cd "${DIR}" && pwd)"
OUT="${2:-${DIR}/demo.mp4}"
OFFSET_MS="${OFFSET_MS:-0}"
SPEED="${SPEED:-1}"

MANIFEST="${DIR}/videos.json"
[ -f "${MANIFEST}" ] || { echo "videos.json not found in ${DIR}" >&2; exit 1; }

VIDEO_COUNT=$(jq length "${MANIFEST}")
[ "${VIDEO_COUNT}" -gt 0 ] || { echo "no recordings" >&2; exit 1; }

PART_DIR="${DIR}/demo-parts"
mkdir -p "${PART_DIR}"
CONCAT_LIST="${PART_DIR}/concat.txt"
: > "${CONCAT_LIST}"

for part in $(seq 0 $((VIDEO_COUNT - 1))); do
  VIDEO=$(jq -r ".[$part].file" "${MANIFEST}")
  SEGMENTS_NAME=$(jq -r ".[$part].segments" "${MANIFEST}")
  SEGMENTS="${DIR}/${SEGMENTS_NAME}"
  [ -f "${VIDEO}" ] || { echo "video not found: ${VIDEO}" >&2; exit 1; }
  [ -f "${SEGMENTS}" ] || { echo "segments not found: ${SEGMENTS}" >&2; exit 1; }

  N=$(jq length "${SEGMENTS}")
  [ "${N}" -gt 0 ] || { echo "no segments: ${SEGMENTS}" >&2; exit 1; }

  INPUTS=(-i "${VIDEO}")
  FILTER=""
  MIX=""
  for i in $(seq 0 $((N - 1))); do
    FILE=$(jq -r ".[$i].file" "${SEGMENTS}")
    T_MS=$(jq -r "(.[$i].t * 1000 | floor)" "${SEGMENTS}")
    DELAY=$((T_MS + OFFSET_MS))
    [ "${DELAY}" -ge 0 ] || { echo "OFFSET_MS makes a negative delay" >&2; exit 1; }
    [ -f "${FILE}" ] || { echo "audio not found: ${FILE}" >&2; exit 1; }
    INPUTS+=(-i "${FILE}")
    FILTER+="[$((i + 1)):a]adelay=${DELAY}:all=1[a${i}];"
    MIX+="[a${i}]"
  done
  FILTER+="${MIX}amix=inputs=${N}:normalize=0[amix]"
  FILTER+=";[0:v]setpts=PTS/${SPEED}[vout];[amix]atempo=${SPEED}[aout]"
  PART="${PART_DIR}/part-${part}.mp4"
  ffmpeg -y "${INPUTS[@]}" \
    -filter_complex "${FILTER}" \
    -map "[vout]" -map "[aout]" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac \
    "${PART}" 2>&1 | tail -2
  printf "file '%s'\n" "${PART}" >> "${CONCAT_LIST}"
done

ffmpeg -y -f concat -safe 0 -i "${CONCAT_LIST}" -c copy "${OUT}" 2>&1 | tail -2
ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${OUT}" | rg -x "audio"

echo "OK: ${OUT}"
