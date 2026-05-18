---
name: lightroom-api-batch
description: Batch image processing with Adobe Lightroom API — preset application, auto-tone, auto-straighten, exposure/highlight/shadow/color adjustments, color grading, and batch normalization across an image set. Use whenever the user wants "Lightroom API", "batch photo processing", "apply preset", "auto-tone images", "color grade", "normalize a photo set", "lr.adobe.io", "Camera Raw filter", or needs to apply consistent processing to many images at scale. Encodes the pattern for delivering visually cohesive image sets from mixed-source raw input — the workhorse pipeline for any photo-heavy creative workflow.
license: Apache-2.0
compatibility: Requires `creative_sdk` scope. Endpoint base: `lr.adobe.io/v2/*`. Inputs accept JPEG, PNG, TIFF, and raw formats (.dng, .cr2, .nef, .arw). Outputs JPEG/PNG/TIFF/DNG. Async with job polling.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: lightroom-api
---

# Lightroom API — Batch Image Processing

The production pattern for applying Lightroom-grade adjustments to images at scale. Apply presets, normalize exposure, auto-tone, color grade — across hundreds or thousands of images consistently. Pair with Photoshop API for compositing or with Firefly for generation; Lightroom is the right tool for tonality and color.

## When to Use This Skill

Use this skill when:
- A campaign delivers a set of images that need to look like they were processed together
- Mixed-source images (different cameras, lighting conditions) need normalization
- A specific look or preset must be applied consistently
- Raw files (DNG, CR2, NEF, ARW) need processing before downstream use
- The user mentions Lightroom API, presets, auto-tone, batch color grading, or `lr.adobe.io`

Do **NOT** use this skill when:
- The transformation is structural (layers, smart objects, compositing) — use Photoshop API
- The need is to *generate* new image content — use Firefly
- The pipeline only needs to resize/crop — that's also Lightroom-territory but minimal; this skill is overkill

## Mental Model

Lightroom API operations split into three families:

| Family | Operations |
|---|---|
| **Auto** | `auto_tone`, `auto_straighten` — Lightroom decides values |
| **Adjustments** | Set explicit values for exposure, highlights, shadows, contrast, vibrance, saturation, white balance, color temperature |
| **Preset** | Apply a `.xmp` Lightroom preset file |

A typical batch pipeline combines all three: auto-tone for baseline normalization, then preset for stylistic look, then fine-tune adjustments for specific shots.

## Step 1 — Apply a Preset

Lightroom presets are `.xmp` files containing the develop settings. They are produced in desktop Lightroom and exported.

```bash
curl --silent -X POST 'https://lr.adobe.io/v2/presets/apply' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$SOURCE_IMAGE_URL"'", "storage": "external"}],
    "options": {
      "presets": [{
        "href": "'"$PRESET_XMP_URL"'",
        "storage": "external"
      }]
    },
    "outputs": [{
      "href": "'"$OUTPUT_URL"'",
      "storage": "external",
      "type": "image/jpeg",
      "overwrite": true,
      "quality": 9
    }]
  }'
```

Response includes a status URL to poll. Same pattern as Photoshop API.

## Step 2 — Apply Auto Adjustments

For "make these look consistent" without a specific preset, auto-tone is the right starting point:

```bash
curl --silent -X POST 'https://lr.adobe.io/v2/autoTone' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$SOURCE_IMAGE_URL"'", "storage": "external"}],
    "outputs": [{"href": "'"$OUTPUT_URL"'", "storage": "external", "type": "image/jpeg"}]
  }'
```

Auto-tone analyzes the image and applies exposure, highlights, shadows, whites, and blacks. It doesn't touch color/style — preset on top of auto-tone is the standard combination.

## Step 3 — Manual Adjustments

For shot-specific tuning:

```bash
curl --silent -X POST 'https://lr.adobe.io/v2/adjustments' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$SOURCE_IMAGE_URL"'", "storage": "external"}],
    "options": {
      "adjustments": {
        "exposure": 0.5,
        "highlights": -30,
        "shadows": 25,
        "whites": 10,
        "blacks": -10,
        "vibrance": 15,
        "saturation": 5,
        "temperature": 5500,
        "tint": 0
      }
    },
    "outputs": [{"href": "'"$OUTPUT_URL"'", "storage": "external", "type": "image/jpeg"}]
  }'
```

### Adjustment ranges

| Adjustment | Range | Effect |
|---|---|---|
| `exposure` | -5 to +5 EV | Overall brightness; ±1 stop is typical |
| `highlights` | -100 to +100 | Brighter areas; negative recovers blown highlights |
| `shadows` | -100 to +100 | Darker areas; positive opens shadows |
| `whites` / `blacks` | -100 to +100 | Set white and black points |
| `vibrance` | -100 to +100 | Saturation of less-saturated colors only |
| `saturation` | -100 to +100 | Saturation of all colors (use sparingly) |
| `temperature` | 2000-50000 K | Warm (lower) to cool (higher) |
| `tint` | -150 to +150 | Green-magenta axis |

## Step 4 — Composite Pipeline: Auto-Tone + Preset

The standard pattern for normalizing a mixed-source set:

```js
async function normalizeAndStyle({ sourceUrl, presetUrl, outputUrl }) {
  // Stage 1: auto-tone — write to an intermediate URL
  const intermediateUrl = await getSignedPutUrl(
    `intermediates/${randomUUID()}.jpg`,
    7200,
  );
  await submitAutoTone({ sourceUrl, outputUrl: intermediateUrl });
  await pollUntilSucceeded();

  // Stage 2: apply preset to the auto-toned intermediate
  const intermediateGetUrl = await getSignedGetUrl(
    `intermediates/${...}`,
    7200,
  );
  await submitPreset({
    sourceUrl: intermediateGetUrl,
    presetUrl,
    outputUrl,
  });
  await pollUntilSucceeded();
}
```

Two stages, two jobs. The intermediate file is a chunk of work; persist briefly, delete after final output is confirmed.

For a fully composed batch:

```
For each input image:
  1. auto_straighten
  2. auto_tone (sets exposure, highlights, shadows, whites, blacks)
  3. apply_preset (sets color/style)
  4. fine_tune_adjustments (per-image overrides if needed)
  5. Write to final destination
```

This produces a set of images that read as consistently processed. The exact recipe is brand-defined; the orchestration shape is universal.

## Step 5 — Raw File Processing

Lightroom API ingests raw formats directly:

```bash
curl --silent -X POST 'https://lr.adobe.io/v2/autoTone' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$RAW_FILE_URL"'", "storage": "external"}],
    "outputs": [
      {"href": "'"$OUTPUT_JPEG_URL"'", "storage": "external", "type": "image/jpeg", "quality": 10},
      {"href": "'"$OUTPUT_DNG_URL"'", "storage": "external", "type": "image/x-adobe-dng"}
    ]
  }'
```

Multi-output mode produces a JPEG for distribution and a processed DNG for further editing. Useful when the customer wants both delivery-ready and master files.

## Production Patterns

### Pattern: Daily-shoot normalization

A real-estate photography pipeline: hundreds of raw shots per day from various sites, must look brand-consistent.

```
SQS queue (one message per shot)
  ↓
Worker:
  1. Get pre-signed read for raw
  2. Lightroom: auto_straighten → auto_tone → brand_preset
  3. Output as JPEG to delivery bucket
  4. Output as DNG to master bucket
  5. Write metadata to DynamoDB
```

Throughput is bounded by Lightroom API quota (typically 10 RPM default). Provisioned higher for production at-scale.

### Pattern: Campaign-set normalization

A campaign uses 50 hero shots from a single shoot, but lighting varied throughout the day. To make them read as one campaign:

```
1. Photographer flags one "reference" shot
2. Reference shot is auto-toned, then human-tuned (or pre-defined preset)
3. Export adjustments from reference as a .xmp preset
4. Apply preset to all 49 other shots via Lightroom API
5. Per-shot fine-tune only on outliers
```

This produces visual cohesion across a campaign set in minutes rather than hours.

### Pattern: Pre-processing for Firefly input

Firefly's reference-image generation works best on clean, well-exposed inputs. Lightroom pre-processing improves Firefly output quality:

```
Raw shot
  ↓ Lightroom: auto_tone + auto_straighten
Clean source
  ↓ Firefly: generate_similar / fill / expand
```

Skipping the Lightroom step often means Firefly produces output that inherits weird color shifts or exposure issues from the source.

## Validate

A Lightroom batch pipeline is production-ready when:

1. Preset files are versioned in object storage with content-hashes
2. Auto-tone + preset is the default; manual adjustments only on outliers
3. Intermediate files have a defined lifecycle (auto-delete after final output succeeds)
4. Pipeline is queue-fronted with rate-limit awareness
5. Output quality settings match the delivery use case (`quality: 8-10` for distribution, `quality: 12` for master)
6. Raw → JPEG conversion is end-to-end without losing color space information

## Troubleshooting & Edge Cases

- **Preset not applied:** The `.xmp` file is broken or has wrong format. Open in desktop Lightroom to validate, re-export.
- **Output looks blown out / clipped:** Auto-tone results vary by source quality. For better consistency, use a brand preset instead of auto-tone alone.
- **Raw file rejected:** Some camera-specific raw formats are unsupported. Check the [Lightroom API supported formats](https://developer.adobe.com/firefly-services/docs/lightroom/) list. For unsupported raws, convert to DNG first using Adobe DNG Converter.
- **Color shifts between batches:** White balance varies by source. Lock `temperature` and `tint` to known values per-batch instead of relying on auto.
- **Adjustments take effect but appear weaker than in desktop Lightroom:** API uses Camera Raw values; ranges may not map 1:1 to desktop sliders. Test and calibrate against a known reference.
- **Rate-limited at 10 RPM despite single workload:** Provisioned default is low. Request an increase from the customer's Adobe account team.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Input/output URL management
- `firefly-services-auth` — Token retrieval
- `photoshop-api-composition` — Compose Lightroom-processed images into PSD templates
- `firefly-generate-similar` — Generate variations from Lightroom-cleaned sources
- `firefly-services-rate-limits` — Lightroom has separate quota from Firefly

## References

- [Lightroom API Documentation](https://developer.adobe.com/firefly-services/docs/lightroom/)
- [Adobe DNG Converter (for unsupported raws)](https://helpx.adobe.com/camera-raw/using/adobe-dng-converter.html)
- `firefly-services-bootstrap` — Lightroom API subscription
