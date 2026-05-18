#!/usr/bin/env bash
# Build a branded PDF of all skills using pandoc + Chrome headless.
# Output: build/Firefly-Services-Skills-v1.0.0.pdf

set -euo pipefail
cd "$(dirname "$0")/.."

OUT_HTML="build/firefly-services-skills.html"
OUT_PDF="build/Firefly-Services-Skills-v1.0.0.pdf"
CSS="build/style.css"

SKILLS_DIR="plugins/firefly-services/skills"

# Order: Tier 1 (foundation) then Tier 2 (APIs)
ORDER=(
  "firefly-services-bootstrap"
  "firefly-services-auth"
  "firefly-services-troubleshoot"
  "firefly-services-rate-limits"
  "firefly-services-storage-refs"
  "firefly-generate-image-v3-async"
  "firefly-custom-models"
  "firefly-expand-fill"
  "firefly-generate-similar"
  "firefly-video-model"
  "photoshop-api-actions"
  "photoshop-api-composition"
  "lightroom-api-batch"
)

TIER1_END=4 # index 4 is firefly-services-storage-refs (last Tier 1)

# Strip frontmatter from a SKILL.md and emit a pretty header card + body
emit_skill() {
  local idx=$1
  local slug=$2
  local file="$SKILLS_DIR/$slug/SKILL.md"
  local tier="Tier 2 — API & integration"
  if (( idx <= TIER1_END )); then tier="Tier 1 — Foundation"; fi

  # Extract frontmatter fields
  local fm description compat tools category
  fm=$(awk '/^---$/{f++; next} f==1{print} f==2{exit}' "$file")
  description=$(printf '%s\n' "$fm" | awk '/^description:/{sub(/^description: */,""); print; exit}')
  compat=$(printf '%s\n' "$fm" | awk '/^compatibility:/{sub(/^compatibility: */,""); print; exit}')
  tools=$(printf '%s\n' "$fm" | awk '/^allowed-tools:/{sub(/^allowed-tools: */,""); print; exit}')
  category=$(printf '%s\n' "$fm" | awk '/  category:/{sub(/^  category: */,""); print; exit}')

  # Body (everything after second ---)
  local body
  body=$(awk '/^---$/{f++; next} f>=2' "$file")

  {
    echo ""
    echo "<div class=\"skill-divider\">"
    echo "<span class=\"tier-banner\">$tier</span>"
    echo "</div>"
    echo ""
    # Body's H1 acts as section title (page-break-before: always already in CSS)
    # Inject frontmatter card right after the body's first H1 — keep body H1 intact

    # We'll print body first, then patch the first H1 to be followed by the frontmatter card.
    # Simpler approach: print metadata card BEFORE body, then body. body's H1 will become the title.

    if [[ -n "$description" || -n "$compat" || -n "$tools" || -n "$category" ]]; then
      :
    fi

    # Print body
    printf '%s\n' "$body"

    # Append a small metadata card (after body) — pandoc renders dl/dt/dd from this raw block
    if [[ -n "$category" || -n "$compat" || -n "$tools" ]]; then
      echo ""
      echo "<div class=\"frontmatter\">"
      echo "<dl>"
      [[ -n "$category" ]] && echo "<dt>Category</dt><dd>$category</dd>"
      [[ -n "$compat"   ]] && echo "<dt>Compatibility</dt><dd>$compat</dd>"
      [[ -n "$tools"    ]] && echo "<dt>Allowed tools</dt><dd><code>$tools</code></dd>"
      echo "</dl>"
      echo "</div>"
    fi
  }
}

# Build a single concatenated markdown file
COMBINED="build/_combined.md"
{
  cat build/cover.md
  echo ""
  echo "---"
  echo ""
  cat README.md
  echo ""
  for i in "${!ORDER[@]}"; do
    emit_skill "$i" "${ORDER[$i]}"
  done
} > "$COMBINED"

# Render to HTML via pandoc
pandoc "$COMBINED" \
  --standalone \
  --metadata title="Firefly Services Skills v1.0.0" \
  --metadata pagetitle="Firefly Services Skills" \
  --css="$CSS" \
  --self-contained \
  --toc \
  --toc-depth=2 \
  --highlight-style=tango \
  -o "$OUT_HTML"

echo "HTML written: $OUT_HTML ($(wc -c < "$OUT_HTML" | tr -d ' ') bytes)"

# Render HTML → PDF via Chrome headless
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-pdf-header-footer \
  --print-to-pdf-no-header \
  --print-to-pdf="$PWD/$OUT_PDF" \
  --no-margins \
  --hide-scrollbars \
  --virtual-time-budget=15000 \
  "file://$PWD/$OUT_HTML" 2>&1 | tail -3 || true

echo ""
echo "PDF written: $OUT_PDF"
ls -lh "$OUT_PDF" | awk '{print "  size:", $5}'
