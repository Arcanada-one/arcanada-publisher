#!/usr/bin/env bash
# Animated-cover video generator — HOUSE STYLE for social-post videos (PUB-0027).
# Canonical reference: docs/how-to/animated-cover-video.md
# Mirrored rule: ~/.claude/skills/publishing/SKILL.md § Video standard for social posts.
#
# Intro hold of the clean post cover, then a NEW visual effect every seg_sec,
# cycling a large RANDOMLY-SHUFFLED pool with smooth crossfades, for the full
# length of the article narration. Pure ffmpeg, no plugins. Audio plays from t=0.
# No audio supplied -> ~30 s cover-only cycle.
#
# Usage:
#   make-cycle-video.sh <cover.jpg> <audio.mp3> <out.mp4> [intro_sec] [seg_sec] [seed]
set -euo pipefail

COVER="$1"; AUD="$2"; OUT="$3"
INTRO="${4:-2}"; SEG="${5:-3}"
SEED="${6:-}"                      # optional: fixed seed for reproducible shuffle
W=1280; H=720; FPS=30
XF="0.6"                           # crossfade duration between effects (seconds)
WORK="$(dirname "$OUT")/_segwork"
rm -rf "$WORK"; mkdir -p "$WORK"

# Audio length → segment count
ADUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUD")
ADUR=${ADUR%.*}
NSEG=$(( (ADUR - INTRO + SEG - 1) / SEG ))
[ "$NSEG" -lt 1 ] && NSEG=1

# ---- Effect pool (segment-relative time t). 44 distinct looks. ----
# Each entry is a filterchain applied after scale/crop to WxH.
EFFECTS=(
  "hue=h='60*t':s=1.5"
  "hue=h='-90*t':s=1.7"
  "gblur=sigma=10,eq=saturation=1.7:contrast=1.15"
  "boxblur=12:1,eq=saturation=1.5"
  "rgbashift=rh=10:bv=-10,eq=saturation=1.8"
  "rgbashift=rh=-14:gh=8:bv=12"
  "edgedetect=low=0.1:high=0.3,negate,hue=h='120*t':s=2.0"
  "negate,hue=h='80*t':s=1.5"
  "vignette=PI/4,hue=h='70*t':s=1.6,eq=brightness=0.03"
  "noise=alls=14:allf=t,hue=h='-50*t':s=1.5"
  "zoompan=z='min(1+0.025*on,1.5)':d=__DT__:s=${W}x${H},eq=saturation=1.4"
  "zoompan=z='if(lte(on,1),1.5,max(1.5-0.025*on,1))':d=__DT__:s=${W}x${H},hue=h='40*t'"
  "rotate='0.06*sin(t*1.5)':c=black,eq=saturation=1.5"
  "pixelize=w=12:h=12,hue=h='90*t':s=1.6"
  "pixelize=w=24:h=24,eq=saturation=1.8"
  "lutyuv=y='val*1.1':u='128+1.4*(val-128)':v='128+1.4*(val-128)',hue=h='50*t'"
  "curves=preset=vintage,hue=h='30*t'"
  "curves=preset=cross_process,eq=saturation=1.4"
  "colorbalance=rs=0.3:gs=-0.1:bs=0.2,hue=h='60*t'"
  "colorbalance=rs=-0.2:bs=0.4,eq=saturation=1.6"
  "colorchannelmixer=2:0:0:0:0:1:0:0:0:0:1:0,hue=h='70*t'"
  "gradfun=3.5:8,eq=saturation=1.7:contrast=1.2"
  "unsharp=7:7:2.5,hue=h='-60*t':s=1.6"
  "prewitt,negate,hue=h='100*t':s=2.0"
  "sobel,hue=h='140*t':s=1.8"
  "erosion,hue=h='50*t':s=1.5"
  "dilation,eq=saturation=1.7,hue=h='-40*t'"
  "split=2[a][b];[b]crop=iw/2:ih:0:0,hflip[bf];[a][bf]overlay=W/2:0,hue=h='45*t'"
  "split=2[a][b];[b]crop=iw:ih/2:0:0,vflip[bf];[a][bf]overlay=0:H/2,hue=h='-45*t'"
  "transpose=2,transpose=1,hue=h='80*t':s=1.5"
  "lenscorrection=k1=-0.3:k2=-0.1,hue=h='60*t':s=1.6"
  "lenscorrection=k1=0.3:k2=0.1,eq=saturation=1.7"
  "rotate='0.04*sin(t*2)':c=black,rgbashift=rh=8:bv=-8,hue=h='50*t'"
  "tblend=all_mode=difference,hue=h='120*t':s=2.0"
  "colorbalance=rm=0.3:gm=-0.2:bm=0.3,hue=h='80*t':s=1.5"
  "eq=brightness='0.12*sin(t*2)':contrast=1.3:saturation=1.6,hue=h='70*t'"
  "eq=brightness='0.1*sin(t*3)':saturation='1.5+0.6*sin(t/2)':contrast=1.2"
  "convolution='0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 0 0 0 1 0 0 0 0',hue=h='40*t'"
  "gblur=sigma=6,negate,curves=preset=vintage,hue=h='90*t'"
  "hue=h='180*t':s='1.5+0.8*sin(t*2)'"
  "rgbashift=rh=6:gh=-6:bv=6,vignette=PI/5,hue=h='-70*t'"
  "noise=alls=8:allf=t+u,curves=preset=cross_process"
  "pixelize=w=16:h=16,negate,hue=h='110*t':s=1.9"
  "colorchannelmixer=0:1:0:0:0:0:1:0:1:0:0:0,hue=h='60*t'"
)
NPOOL=${#EFFECTS[@]}
DT=$(( FPS * SEG ))

# ---- Randomize effect order (different video every run; intro stays the cover) ----
# Build a shuffled index list. $RANDOM seeded for optional reproducibility (--seed).
[ -n "$SEED" ] && RANDOM="$SEED"
ORDER=()
for ((k=0;k<NPOOL;k++)); do ORDER+=("$k"); done
# Fisher-Yates
for ((k=NPOOL-1;k>0;k--)); do
  j=$(( RANDOM % (k+1) ))
  tmp="${ORDER[k]}"; ORDER[k]="${ORDER[j]}"; ORDER[j]="$tmp"
done
# Extend the shuffled order to cover NSEG segments by re-shuffling each pass,
# so even past the pool size the sequence keeps varying.
SEQ=()
while [ "${#SEQ[@]}" -lt "$NSEG" ]; do
  for idx in "${ORDER[@]}"; do SEQ+=("$idx"); [ "${#SEQ[@]}" -ge "$NSEG" ] && break; done
  # re-shuffle ORDER for the next pass
  for ((k=NPOOL-1;k>0;k--)); do j=$(( RANDOM % (k+1) )); tmp="${ORDER[k]}"; ORDER[k]="${ORDER[j]}"; ORDER[j]="$tmp"; done
done

echo "audio=${ADUR}s  intro=${INTRO}s  seg=${SEG}s  segments=${NSEG}  pool=${NPOOL} effects  xfade=${XF}s  seed=${SEED:-random}"

# intro segment (clean cover). Add XF tail so the first crossfade has overlap room.
INTRO_LEN=$(awk "BEGIN{print $INTRO + $XF}")
ffmpeg -y -v error -loop 1 -t "$INTRO_LEN" -i "$COVER" \
  -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p" \
  -r "$FPS" -t "$INTRO_LEN" -c:v libx264 -preset veryfast -crf 20 "$WORK/seg-000.mp4"

# Each effect segment is rendered SEG+XF long so xfade can eat XF of overlap and
# the effective on-screen time stays ~SEG.
SEG_LEN=$(awk "BEGIN{print $SEG + $XF}")
NFILES=1
for i in $(seq 1 "$NSEG"); do
  idx="${SEQ[$((i-1))]}"
  fx="${EFFECTS[$idx]}"
  fx="${fx//__DT__/$DT}"
  printf -v segf "seg-%03d.mp4" "$i"
  ffmpeg -y -v error -loop 1 -t "$SEG_LEN" -i "$COVER" \
    -filter_complex "[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,${fx},format=yuv420p[v]" \
    -map "[v]" -r "$FPS" -t "$SEG_LEN" -c:v libx264 -preset veryfast -crf 21 "$WORK/$segf" 2>"$WORK/err-$i.log" \
    || { echo "SEG $i (idx $idx) FAILED: $fx"; tail -2 "$WORK/err-$i.log"; }
  if [ ! -s "$WORK/$segf" ]; then
    ffmpeg -y -v error -loop 1 -t "$SEG_LEN" -i "$COVER" \
      -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,hue=h='60*t':s=1.4,format=yuv420p" \
      -r "$FPS" -t "$SEG_LEN" -c:v libx264 -preset veryfast -crf 21 "$WORK/$segf"
  fi
  NFILES=$((NFILES+1))
done

# ---- Crossfade-chain all segments in batches (keeps each graph small/fast) ----
# Batch size: number of segments fused per ffmpeg pass via xfade.
BATCH=12
xfade_join() {  # $1=out  $2..=input files (already SEG_LEN each, first may differ)
  local out="$1"; shift
  local files=("$@")
  local n="${#files[@]}"
  if [ "$n" -eq 1 ]; then cp "${files[0]}" "$out"; return; fi
  local inputs=() fc="" prev="0:v" off
  local acc
  # offset accumulator: first clip full length, each next overlaps by XF
  acc=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${files[0]}")
  for f in "${files[@]}"; do inputs+=(-i "$f"); done
  for ((m=1;m<n;m++)); do
    off=$(awk "BEGIN{printf \"%.3f\", $acc - $XF}")
    fc+="[${prev}][${m}:v]xfade=transition=fade:duration=${XF}:offset=${off}[x${m}];"
    prev="x${m}"
    local d
    d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${files[$m]}")
    acc=$(awk "BEGIN{printf \"%.3f\", $acc + $d - $XF}")
  done
  fc="${fc%;}"                       # strip trailing ';' — last label is [x<n-1>]
  ffmpeg -y -v error "${inputs[@]}" -filter_complex "$fc" -map "[x$((n-1))]" \
    -r "$FPS" -c:v libx264 -preset veryfast -crf 21 "$out"
}

# Gather all segment files in order
ALL=("$WORK/seg-000.mp4")
for i in $(seq 1 "$NSEG"); do printf -v segf "seg-%03d.mp4" "$i"; ALL+=("$WORK/$segf"); done

# Pass 1: fuse into non-overlapping batch chunks
CHUNKS=(); ci=0
total="${#ALL[@]}"
for ((s=0;s<total;s+=BATCH)); do
  part=("${ALL[@]:s:BATCH}")
  [ "${#part[@]}" -eq 0 ] && break
  printf -v cf "chunk-%03d.mp4" "$ci"
  xfade_join "$WORK/$cf" "${part[@]}"
  CHUNKS+=("$WORK/$cf"); ci=$((ci+1))
done

# Pass 2: fuse chunks into final silent video
if [ "${#CHUNKS[@]}" -eq 1 ]; then
  cp "${CHUNKS[0]}" "$WORK/video-silent.mp4"
else
  xfade_join "$WORK/video-silent.mp4" "${CHUNKS[@]}"
fi

# Final bounded encode + mux audio (PUB-0028: replaces -c:v copy for size control).
# Configure via env: MAX_BITRATE_KBPS (default 600) and CRF (default 28).
MAXK="${MAX_BITRATE_KBPS:-600}"
CRF_VAL="${CRF:-28}"

# Bottom audio-amplitude strip (house style, operator-approved 2026-06-28):
# a showwaves oscilloscope filled with a horizontal gold->crimson gradient,
# overlaid on the bottom edge ON TOP of the cycle animation. This is an
# ADDITION to the cycle video, never a bare-waveform video (forbidden as the
# whole post). Disable with WAVEFORM=0. Tune via env:
#   WAVEFORM_HEIGHT (px, default 180), WAVEFORM_C0 (left hex, default 0xFFD24C),
#   WAVEFORM_C1 (right hex, default 0xE03B5A).
WAVEFORM="${WAVEFORM:-1}"
WF_H="${WAVEFORM_HEIGHT:-180}"
WF_C0="${WAVEFORM_C0:-0xFFD24C}"
WF_C1="${WAVEFORM_C1:-0xE03B5A}"
# Validate env inputs (defence in depth — these reach filter_complex).
case "$WF_H" in (''|*[!0-9]*) echo "WAVEFORM_HEIGHT must be a positive integer" >&2; exit 2;; esac
[ "$WF_H" -gt 0 ] || { echo "WAVEFORM_HEIGHT must be a positive integer" >&2; exit 2; }
for c in "$WF_C0" "$WF_C1"; do
  case "$c" in
    0x[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]) : ;;
    *) echo "WAVEFORM colour '$c' must be 0xRRGGBB" >&2; exit 2 ;;
  esac
done

if [ "$WAVEFORM" = "1" ]; then
  WF_STRIP=$(( WF_H < H ? WF_H : H ))   # clamp to canvas
  WF_Y=$(( H - WF_STRIP ))
  WF_FC="[1:a]showwaves=s=${W}x${WF_STRIP}:mode=cline:colors=white:draw=full:rate=${FPS},format=gray[wfmask];"
  WF_FC+="gradients=s=${W}x${WF_STRIP}:c0=${WF_C0}:c1=${WF_C1}:x0=0:y0=0:x1=${W}:y1=0:d=1:n=2:rate=${FPS}[wfgrad];"
  WF_FC+="[wfgrad][wfmask]alphamerge[wfwave];"
  WF_FC+="[0:v][wfwave]overlay=0:${WF_Y}:format=auto,format=yuv420p[vout]"
  ffmpeg -y -v error -i "$WORK/video-silent.mp4" -i "$AUD" \
    -filter_complex "$WF_FC" -map "[vout]" -map 1:a \
    -c:v libx264 -preset veryfast -profile:v high -level 4.0 \
    -crf "$CRF_VAL" -maxrate "${MAXK}k" -bufsize "$((MAXK * 2))k" \
    -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
    -c:a aac -b:a 160k -shortest -movflags +faststart "$OUT"
else
  ffmpeg -y -v error -i "$WORK/video-silent.mp4" -i "$AUD" \
    -map 0:v -map 1:a \
    -c:v libx264 -preset veryfast -profile:v high -level 4.0 \
    -crf "$CRF_VAL" -maxrate "${MAXK}k" -bufsize "$((MAXK * 2))k" \
    -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
    -c:a aac -b:a 160k -shortest -movflags +faststart "$OUT"
fi

echo "DONE -> $OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | sed 's/^/final dur: /'
