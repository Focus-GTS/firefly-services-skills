---
name: photoshop-api-actions
description: Apply Photoshop actions, smart-object replacement, and document operations programmatically using the Adobe Photoshop API — running .atn action files, smart-object source replacement, text replacement, layer visibility toggles, and the input/output storage pattern. Use whenever the user mentions "Photoshop API", "smart object replacement", "smart-object", "apply action", "action runner", "image.adobe.io", ".atn file", "PSD automation", "layer replacement", "text layer update", or wants to drive Photoshop operations from a server without the desktop app. Encodes the production pattern for replacing smart-object content in key-art PSDs at enterprise scale.
license: Apache-2.0
compatibility: Requires `creative_sdk` scope. Endpoint base: `image.adobe.io/pie/psdService/*`. Source PSDs and assets pass through storage refs (input + output destinations). Most operations are async with job polling.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: photoshop-api
---

# Photoshop API — Actions & Operations

Run Photoshop operations on the server. The Photoshop API exposes the same operation surface that the desktop app uses: action playback, smart-object replacement, text replacement, layer manipulation, and PSD rendering. Inputs and outputs are passed as storage references (pre-signed URLs you control).

This is the workhorse API for any campaign workflow that involves template PSDs — replace smart objects, swap text layers, render to JPEG/PNG, ship.

## When to Use This Skill

Use this skill when:
- A campaign uses template PSDs with smart-object slots and you need to fill them at scale
- An existing Photoshop action (`.atn`) needs to run server-side
- Layer visibility, text content, or smart-object content must change programmatically
- The output is a rendered image (JPEG, PNG) from a PSD template
- The user mentions "Photoshop API", "smart object", "action runner", or `image.adobe.io`

Do **NOT** use this skill when:
- The transformation is purely color/exposure adjustment — use `lightroom-api-batch`
- The need is to *generate* a new image from a prompt — use `firefly-generate-image-v3-async`
- The work is interactive editing for a single human user — desktop Photoshop is the right tool

## The Photoshop API Mental Model

Every Photoshop API call follows the same shape:

```
inputs: [{ href: "pre-signed-GET-url", storage: "external" }, ...]
options: { ...operation-specific }
outputs: [{ href: "pre-signed-PUT-url", storage: "external", type: "image/jpeg" }]
```

Adobe reads inputs from your pre-signed GET URLs, runs the operation, and writes results to your pre-signed PUT URLs. Adobe never holds your assets — you do.

Valid `storage` values are `external`, `azure`, and `dropbox` (there is no `adobe` storage type for these operations). Use `external` for your own pre-signed S3/GCS/blob URLs.

Output `type` values:

| MIME | Format |
|---|---|
| `image/jpeg` | JPEG (most common output) |
| `image/png` | PNG |
| `image/tiff` | TIFF |
| `vnd.adobe.photoshop` | PSD (preserves layers) |

## Step 1 — Smart Object Replacement

The canonical template-driven workflow. A template PSD has named smart-object layers; replace each layer's contents with a new image and render the result.

```bash
curl --silent -X POST 'https://image.adobe.io/pie/psdService/smartObject' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{
      "href": "'"$TEMPLATE_PSD_URL"'",
      "storage": "external"
    }],
    "options": {
      "layers": [{
        "name": "hero-image",
        "input": {
          "href": "'"$NEW_HERO_IMAGE_URL"'",
          "storage": "external"
        }
      }, {
        "name": "background",
        "input": {
          "href": "'"$NEW_BACKGROUND_URL"'",
          "storage": "external"
        }
      }]
    },
    "outputs": [{
      "href": "'"$OUTPUT_JPEG_URL"'",
      "storage": "external",
      "type": "image/jpeg",
      "overwrite": true,
      "quality": 7
    }]
  }'
```

JPEG `quality` is an integer from 1 to 7, with 7 as the highest quality (and the default).

Response:

```json
{
  "_links": {
    "self": {"href": "https://image.adobe.io/pie/psdService/status/<job-id>"}
  }
}
```

Always poll the `_links.self.href` value returned by the submit call — do not construct the status URL yourself. (The status path is `/pie/psdService/status/{jobId}`, but treat the returned `_links.self.href` as authoritative.)

```bash
curl --silent "$STATUS_URL" \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID"
```

Status values: `pending` → `running` → `succeeded` | `failed`. Polling cadence 1-2s is appropriate.

### Layer naming convention

Smart objects are addressed **by name**, not by position. The template PSD must have unique, predictable layer names. Brand-defined patterns:

| Pattern | Example |
|---|---|
| `<role>-<purpose>` | `hero-image`, `bg-photo`, `logo-overlay` |
| Use kebab-case or snake_case, not spaces | |
| Unique within the PSD | |

If two layers share a name, the API replaces both — sometimes desirable, often not. Audit templates before going live.

## Step 2 — Text Layer Replacement

```bash
curl --silent -X POST 'https://image.adobe.io/pie/psdService/text' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$TEMPLATE_PSD_URL"'", "storage": "external"}],
    "options": {
      "layers": [{
        "name": "headline",
        "text": {
          "content": "Limited Edition",
          "characterStyles": [{
            "fontColor": {"rgb": {"red": 32768, "green": 32768, "blue": 32768}},
            "fontSize": 48
          }]
        }
      }]
    },
    "outputs": [{"href": "'"$OUTPUT_JPEG_URL"'", "storage": "external", "type": "image/jpeg"}]
  }'
```

Text replacement preserves the original layer's font, position, and tracking unless explicitly overridden. Override only what you need to.

### Supported character styles

| Field | Notes |
|---|---|
| `fontSize` | Point size |
| `fontColor` | Color object — provide `rgb` (`red`/`green`/`blue`, integers 0–32768), or `cmyk`/`gray`/`lab` |
| `from` / `to` | Character index range the style applies to |
| `orientation` | Text orientation (`horizontal` / `vertical`) |

**Changing the font by name is not supported on the current schema** — live-verified 2026-08-10: `characterStyles[].fontName` is rejected at submission with `Additional property fontName is not allowed`. The layer keeps the font defined in the PSD; text replacement changes content and the styles listed above. If a different font is required, set it in the template PSD itself.

Font *availability* is a document-level concern: `options.manageMissingFonts` governs what happens when the PSD references a font the service doesn't have (`useDefault` substitutes ArialMT; `"fail"` fails the job), and `options.fonts` supplies custom font files as storage refs. Keep template fonts on the [supported list](https://github.com/AdobeDocs/photoshop-api-docs/blob/main/SupportedFonts.md) to avoid substitution surprises.

## Step 3 — Apply Photoshop Actions (.atn)

Run an existing `.atn` action file against an input image:

```bash
curl --silent -X POST 'https://image.adobe.io/pie/psdService/photoshopActions' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$INPUT_IMAGE_URL"'", "storage": "external"}],
    "options": {
      "actions": [{
        "href": "'"$ATN_FILE_URL"'",
        "storage": "external",
        "actionName": "my-brand-treatment"
      }]
    },
    "outputs": [{"href": "'"$OUTPUT_URL"'", "storage": "external", "type": "image/jpeg"}]
  }'
```

`actionName` identifies a specific action within the `.atn` file. Action files can contain many actions; pick the one to run.

### Building action files

Action files are produced in the desktop Photoshop app:
1. Open the actions panel (Window → Actions)
2. Record an action by performing operations
3. Stop recording
4. Export the action set as `.atn`

These are typically built by the customer's creative team and handed to the FDE engineer as part of the asset library. Treat them as versioned assets.

## Step 4 — Layer Visibility and Position

For dynamic compositions where layers turn on/off based on campaign rules:

```bash
curl --silent -X POST 'https://image.adobe.io/pie/psdService/documentOperations' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$PSD_URL"'", "storage": "external"}],
    "options": {
      "layers": [
        {"edit": {}, "name": "promo-badge", "visible": true},
        {"edit": {}, "name": "regular-price", "visible": false},
        {"edit": {}, "name": "logo-light", "visible": false},
        {"edit": {}, "name": "logo-dark", "visible": true}
      ]
    },
    "outputs": [{"href": "'"$OUTPUT_URL"'", "storage": "external", "type": "image/jpeg"}]
  }'
```

Layer visibility toggles are cheap (no rendering of off layers) — use liberally for variant generation from a master template.

## Step 5 — Get the Document Manifest

To know what layers exist in a template PSD before operating on it, fetch the manifest:

```bash
curl --silent -X POST 'https://image.adobe.io/pie/psdService/documentManifest' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": [{"href": "'"$PSD_URL"'", "storage": "external"}]
  }'
```

Response includes the full layer tree with names, kinds, visibility, smart-object flags. Use this to validate template integrity in CI before allowing a PSD into production.

## Production Patterns

### Pattern: Template-driven campaign assembly

```
Per campaign asset request:
  1. Load campaign config (which template, which assets, which text)
  2. Compose a documentOperations request (its layer objects accept both
     smart-object input and text blocks, so one call covers the whole edit):
       inputs = [template_psd]
       options.layers = [
         {edit: {}, name: "hero", input: {hero_image_url}},
         {edit: {}, name: "logo", input: {brand_logo_url}},
         {edit: {}, name: "headline", text: {campaign_headline}}
       ]
       outputs = [{href: output_url, type: "image/jpeg"}]
  3. Submit, poll, persist output
```

Note: the `/smartObject` endpoint's layer objects accept only `input` (no `text` property), so a single `/smartObject` call cannot also replace a text layer. Either combine everything in one `POST /pie/psdService/documentOperations` call as above, or make two calls — `/smartObject` for the image slots, then `/text` for the headline.

At enterprise campaign scale, this runs through SQS → Lambda. One template + one config = one rendered output. A full campaign run is the orchestration of this base operation thousands of times.

### Pattern: Per-customer template library

Templates are versioned by customer + use case + variant:

```
templates/
  customer-a/
    key-art-banner-1920x1080.psd       v3
    title-card-1080x1080.psd           v2
  customer-b/
    campaign-template-16x9.psd         v1
    campaign-template-1x1.psd          v1
```

Each version's manifest (layer structure) is cached so requests can validate against the right shape before being submitted.

### Pattern: Pre-flight manifest validation

Before submitting a smart-object replacement, fetch the manifest and verify:

| Check | Why |
|---|---|
| All `options.layers[].name` exist in the manifest | Avoid silent failures when a layer was renamed |
| Smart-object layers are flagged as smart objects | Plain layers can't accept smart-object replacement |
| Text layers are flagged as text | Same |
| Required system fonts are supported | See SupportedFonts.md |

This pre-flight catches 90% of failures before the API call, where they would otherwise surface mid-pipeline.

## Validate

A Photoshop API pipeline is production-ready when:

1. Source PSDs are uploaded once, referenced by stable storage URLs (or a manifest cache)
2. Layer naming is consistent within and across templates
3. Pre-flight manifest validation runs in CI for every template change
4. Outputs land in your own bucket with predictable keys
5. Job IDs are logged per request for downstream audit
6. Pre-signed URLs are generated just-in-time (see `firefly-services-storage-refs`)

## Troubleshooting & Edge Cases

- **Layer not found:** Manifest is out of sync with template. Refetch with `documentManifest` and audit names.
- **Text layer changes ignored:** The layer is not actually a text layer (flagged as raster in the manifest). Convert in desktop Photoshop and re-export.
- **Font fallback used silently:** Font name doesn't match supported list, and `manageMissingFonts` was left at its `useDefault` setting (ArialMT substitution). Set `options.manageMissingFonts: "fail"` to surface the error, or supply the font via `options.fonts`. See [SupportedFonts.md](https://github.com/AdobeDocs/photoshop-api-docs/blob/main/SupportedFonts.md).
- **Output is corrupted:** Output URL was generated as GET, not PUT. Regenerate as PUT.
- **Smart-object replacement preserves the old content:** The named layer is not a smart object. Convert in desktop Photoshop.
- **Action plays but does nothing visible:** Action name in the .atn file doesn't match `actionName` field. Re-open the .atn in desktop Photoshop to find the exact name.
- **Job stuck on `running` for >5 minutes:** Most operations complete in 5-30 seconds. Long stalls usually indicate an issue with the input PSD (corruption, unsupported color mode). Cancel and resubmit with a known-good template.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Input/output URL generation
- `firefly-services-auth` — Token retrieval
- `photoshop-api-composition` — Multi-layer composition workflows
- `firefly-expand-fill` — Generate fill content before compositing into PSD
- `firefly-services-rate-limits` — Photoshop API has separate rate limits from Firefly

## References

- [Photoshop API Documentation](https://developer.adobe.com/firefly-services/docs/photoshop/)
- [Photoshop API General Workflow](https://developer.adobe.com/firefly-services/docs/photoshop/general-workflow/)
- [Supported Fonts list](https://github.com/AdobeDocs/photoshop-api-docs/blob/main/SupportedFonts.md)
- [OAuth Sample App](https://github.com/AdobeDocs/photoshop-api-docs/tree/main/sample_code/oauth-sample-app)
