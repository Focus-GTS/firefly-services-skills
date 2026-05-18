---
name: firefly-expand-fill
description: Use Adobe Firefly's Generative Expand and Generative Fill APIs — when to use each, masking strategies, placement and aspect ratio control, prompt patterns for clean extension and inpainting, and the difference between filling versus replacing image regions. Use whenever the user mentions "generative expand", "extend canvas", "generative fill", "inpaint", "outpaint", "remove object", "replace background", "expand image", "fill image", "masking", "expand-async", "fill-async", or wants to grow / patch / modify an existing image. Encodes the production patterns for background extension on key-art assets and for brand-aligned background replacement in campaign creators.
license: Apache-2.0
compatibility: Requires `firefly_api`, `ff_apis` scopes. Endpoints: `firefly-api.adobe.io/v3/images/expand` and `/v3/images/fill`. Source images must be passed as storage refs.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: image-editing
---

# Firefly Generative Expand & Fill

Two related but distinct APIs for modifying existing images. **Expand** grows the canvas and generates new content into the new area. **Fill** modifies or replaces regions within the existing canvas, guided by a mask. Picking the right one is half the battle; the rest is mask quality.

## When to Use This Skill

Use this skill when:
- The user wants to extend an image's canvas in any direction
- The user wants to replace or modify a region of an image (background, object, text area)
- A campaign needs multiple aspect ratios from a single source asset
- A creative team wants to remove an unwanted object from an image
- The user mentions inpainting, outpainting, expand, or fill

Do **NOT** use this skill when:
- The user wants a completely new image — use `firefly-generate-image-v3-async`
- The user wants stylistic variations of an existing image — use `firefly-generate-similar`
- The transformation is purely raster editing (sharpen, color-correct) — use Lightroom API

## Expand vs Fill — Decision Table

| Need | Endpoint |
|---|---|
| Grow canvas, generate content in the new region | **Expand** |
| Change image aspect ratio (1:1 → 16:9) | **Expand** |
| Remove an object and patch the area | **Fill** |
| Replace background while keeping subject | **Fill** with mask covering background |
| Replace a specific region (sky, ground, person's shirt) | **Fill** |
| Inpaint a damaged or unwanted region | **Fill** |
| Outpaint (the classic AI-art "generate beyond the frame") | **Expand** |

In short: **canvas grows = Expand. Canvas stays = Fill.**

## Generative Expand

### Step 1 — Submit the Expand Job

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/expand' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "image": {"source": {"uploadId": "$SOURCE_UPLOAD_ID"}},
    "size": {"width": 2304, "height": 1280},
    "prompt": "a sweeping desert landscape continuing into the distance",
    "placement": {
      "alignment": {"horizontal": "center", "vertical": "center"}
    },
    "numVariations": 2
  }'
```

Returns the async job pattern (`jobId`, `statusUrl`, `cancelUrl`) — poll the same way as `firefly-generate-image-v3-async`.

### The `placement` field

`placement` controls where the *original* image sits within the *new* (larger) canvas:

```json
"placement": {
  "alignment": {"horizontal": "center", "vertical": "center"},
  "inset": {"left": 0, "top": 0, "right": 0, "bottom": 0}
}
```

| Alignment | Effect |
|---|---|
| `center`, `center` | Original in middle, expanded equally on all sides |
| `left`, `center` | Original on left, expanded to the right |
| `right`, `top` | Original in top-right, expanded down and left |

Use `inset` for fine pixel control. Typical pattern: original at center, expand evenly. For social-media variants (landscape → portrait), place the original off-center so the subject lands in the safe area.

### The `prompt` field for expand

Prompts describe what the *new* (expanded) area should contain. The original image stays as-is. Examples:

| Original | Prompt | Result |
|---|---|---|
| Portrait of a person | "the rest of their body in a business suit" | Original head + new body |
| Product on white | "a kitchen counter with morning light" | Product in scene |
| Landscape close-up | "a vast sky with scattered clouds above" | Scene continues upward |

Leave `prompt` empty to let Firefly extend the existing content stylistically (common for cropping/recropping workflows).

### Aspect ratio recipes

Common production use cases:

| From | To | `size` | `placement.alignment` |
|---|---|---|---|
| 1024×1024 (1:1) | 1408×768 (16:9 landscape) | width 1408, height 768 | center, center |
| 1024×1024 (1:1) | 768×1408 (9:16 portrait) | width 768, height 1408 | center, top (lower face) |
| 1408×768 (key art) | 2304×1280 (cinematic) | width 2304, height 1280 | center, center |
| 1024×1024 (square) | 1024×1792 (story portrait) | width 1024, height 1792 | center, top |

## Generative Fill

### Step 1 — Prepare the Mask

Fill requires a **mask** that tells Firefly which region to modify. White pixels = fill this. Black pixels = preserve. Grayscale = soft blend.

The mask must be the same dimensions as the source image. Generate the mask client-side (image editor, Photoshop API, or programmatically with `sharp` / `pillow`) and upload as a storage reference.

```bash
# Upload mask
MASK_UPLOAD_ID=$(curl --silent -X POST 'https://firefly-api.adobe.io/v2/storage/image' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H "Content-Type: image/png" \
  --data-binary "@./mask.png" \
  | jq -r '.images[0].id')
```

### Step 2 — Submit the Fill Job

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/fill' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "image": {"source": {"uploadId": "$SOURCE_UPLOAD_ID"}},
    "mask": {"source": {"uploadId": "$MASK_UPLOAD_ID"}},
    "prompt": "a modern minimalist living room background",
    "numVariations": 2
  }'
```

Returns the async job pattern — poll for completion.

### The `prompt` field for fill

Prompts describe what should appear *in the masked region*. The unmasked region stays as-is.

| Mask covers | Prompt | Result |
|---|---|---|
| Background of a product shot | "marble kitchen counter" | Product unchanged, new background |
| An unwanted person | "empty park bench" | Person removed, bench fills the area |
| A label area | "minimal white space" | Label gone, area cleaned up |
| A vehicle's color region | "matte red paint" | Vehicle now red |

### Mask generation strategies

| Strategy | Tool | When |
|---|---|---|
| Manual mask | Photoshop, image editor | One-off creative work |
| Programmatic mask | `sharp`, `pillow` | Geometric regions (top half, left third) |
| Subject detection | Photoshop API `select_subject` or custom segmentation | Replace background, isolate subject |
| Color-key mask | `sharp` threshold | Replace a specific colored region |
| AI segmentation | SAM (Segment Anything), Mediapipe | Production segmentation pipelines |

For high-volume workflows (background extension on hundreds of key-art assets daily), masks are generated programmatically from subject detection — never by hand.

## Combining Expand + Fill in a Pipeline

A common production pipeline:

```
Source key-art (1408×768)
  ↓ Expand (to 2304×1280, prompt extending the scene)
Expanded image
  ↓ Fill (mask covers text area, prompt: "clean background")
Cleaned cinematic version
  ↓ Apply Photoshop API actions (text overlay, layer compositing)
Final asset
```

This is the canonical key-art generation pattern condensed. Each stage is an async job; the pipeline is queue-fronted (see `firefly-services-rate-limits`).

## Production Patterns

### Pattern: Multi-aspect generation from one source

Given one square key art, generate landscape + portrait + story formats:

```js
const aspects = [
  { name: 'landscape-16-9', size: { width: 1408, height: 768 }, alignment: { horizontal: 'center', vertical: 'center' } },
  { name: 'portrait-9-16', size: { width: 768, height: 1408 }, alignment: { horizontal: 'center', vertical: 'top' } },
  { name: 'story-9-16', size: { width: 1024, height: 1792 }, alignment: { horizontal: 'center', vertical: 'top' } },
];

const jobs = await Promise.all(
  aspects.map(a => submitExpand({
    sourceUploadId: SOURCE_ID,
    size: a.size,
    placement: { alignment: a.alignment },
    prompt: 'continue the scene naturally',
    numVariations: 2,
  })),
);
```

Three submissions, ~6 outputs in parallel. Persist each with the aspect tag for the downstream creative team.

### Pattern: Background replacement at scale

For brand-campaign-creator background swaps:

```
Source image
  ↓ Photoshop API: select_subject → mask (subject white, background black)
  ↓ Invert mask (subject black, background white) — Sharp/Pillow
Fill request with inverted mask
  ↓ prompt: "<brand-aligned background>"
Output: subject preserved, new background
```

The inversion step is critical — Photoshop's `select_subject` gives you the subject mask; for background replacement you need the inverse.

## Validate

Expand/Fill pipelines are production-ready when:

1. Decision between Expand and Fill is documented per use case
2. Mask generation is automated, not manual (for any volume >50)
3. Masks are validated for correct dimensions and proper polarity before submission
4. Output is visually inspected against the source before being marked succeeded
5. Multi-aspect pipelines submit in parallel, not sequential
6. `placement` decisions align with brand safe-area guidelines

## Troubleshooting & Edge Cases

- **Expand output has visible seam between original and new content:** Original may have unusual color or grain. Try regenerating with seed change, or expand the prompt with description of the source's qualities.
- **Fill prompt is ignored:** Mask is likely inverted (white = preserve, black = fill instead of the other way). Re-check the mask polarity.
- **Fill output bleeds outside the mask:** Mask edges are too soft (heavy gaussian blur). Sharpen the mask edges, or use a binary mask.
- **Expand changes subject placement unexpectedly:** Explicitly set `placement.alignment` — defaults may move the subject.
- **Mask too large (>8MB):** Compress the mask. Single-channel grayscale PNG with limited palette typically compresses well.
- **Expand to extreme aspect ratio looks unnatural:** Expand in two steps: original → medium → final. Each step is a smaller leap.
- **Fill removes the subject entirely:** Mask is overlapping the subject. Tighten the mask to background-only.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Mask + source upload
- `firefly-generate-image-v3-async` — Same async pattern
- `photoshop-api-actions` — For automated mask generation (`select_subject`)
- `firefly-services-rate-limits` — For batch pipelines

## References

- [Generative Expand Tutorial](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/firefly-expand-image-api-tutorial/)
- [Generative Fill Tutorial](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/firefly-fill-image-api-tutorial/)
- [Masking Concept](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/masking/)
- [Placement Concept](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/placement/)
