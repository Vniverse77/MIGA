#!/usr/bin/env bash
# Builds the MIGA app icon (white "M.I.G.A" on the app blue) and the Tauri icon set.
# Usage: bash desktop/icon/make-icons.sh   (needs ImageMagick `magick`, JetBrains Mono Nerd Font)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
icons="$here/../src-tauri/icons"
font=/usr/share/fonts/TTF/JetBrainsMonoNerdFont-ExtraBold.ttf
[ -f "$font" ] || font=/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf
[ -f "$font" ] || { echo "JetBrains Mono Nerd Font not found" >&2; exit 1; }
text="M.I.G.A"
blue="#1a6bbf"

# render SIZE POINTSIZE OUT : rounded square (inset/radius scale with SIZE) + centered text
render() {
	local s=$1 pt=$2 out=$3
	local inset=$((s * 32 / 1024)) radius=$((s * 200 / 1024))
	local max=$((s - 1 - inset))
	magick -size "${s}x${s}" xc:none -antialias \
		-fill "$blue" -draw "roundrectangle $inset,$inset $max,$max $radius,$radius" \
		-font "$font" -pointsize "$pt" -fill '#ffffff' -gravity center \
		-annotate +0+0 "$text" "PNG32:$out"
}

render 1024 200 "$here/icon-1024.png"

# Small sizes are rendered natively (no downscale): thin inset so the blue fills the square, heaviest
# weight, text fitted as wide as fits with a 1-2 px margin, placed on integer pixel offsets.
# render_small SIZE INSET RADIUS MARGIN OUT
render_small() {
	local s=$1 inset=$2 radius=$3 margin=$4 out=$5 pt w best=""
	local limit=$((s - 2 * margin))
	for pt in $(seq 4 0.1 $((s / 2))); do
		w=$(magick -background none -font "$font" -pointsize "$pt" -fill '#ffffff' -antialias label:"$text" -trim +repage -format '%w' info:)
		if [ "$w" -le "$limit" ]; then best=$pt; else break; fi
	done
	magick -background none -font "$font" -pointsize "$best" -fill '#ffffff' -antialias label:"$text" -trim +repage "$out.txt.png"
	local tw th
	tw=$(magick "$out.txt.png" -format '%w' info:)
	th=$(magick "$out.txt.png" -format '%h' info:)
	magick -size "${s}x${s}" xc:none -antialias \
		-fill "$blue" -draw "roundrectangle $inset,$inset $((s - 1 - inset)),$((s - 1 - inset)) $radius,$radius" \
		"$out.txt.png" -geometry "+$(((s - tw) / 2))+$(((s - th) / 2))" -composite "PNG32:$out"
	rm -f "$out.txt.png"
	echo "small icon ${s}px: pointsize $best, text ${tw}x${th}" >&2
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
render_small 32 0 6 1 "$tmp/32x32.png"
render_small 48 0 9 2 "$tmp/48x48.png"
render_small 64 1 12 2 "$tmp/64x64.png"

cd "$here/.."
npx tauri icon "icon/icon-1024.png" -o src-tauri/icons
rm -rf "$icons/android" "$icons/ios"
cp "$tmp/32x32.png" "$icons/32x32.png"
cp "$tmp/48x48.png" "$icons/48x48.png"
cp "$tmp/64x64.png" "$icons/64x64.png"
