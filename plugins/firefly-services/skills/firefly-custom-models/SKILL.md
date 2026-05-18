---
name: firefly-custom-models
description: Train, manage, and invoke Adobe Firefly Custom Models — subject vs style models, training data preparation (10-30 reference images), training submission and polling, asset ID management, generation with `customModelId` and `x-model-version: image3_custom`, retraining cadence, and brand-aligned generation at scale. Use whenever the user mentions "custom model", "brand model", "train a model", "fine-tune Firefly", "subject model", "style model", "Custom Models API", `customModelId`, or describes iconography / brand-asset / character generation that requires consistency. Encodes the production pattern for brand iconography workflows where custom-model output dramatically reduces design cycle time.
license: Apache-2.0
compatibility: Requires `firefly_enterprise` scope on the access token. Customer must hold a Custom Models entitlement (sold separately, typically as a bundle of 100 model slots). All endpoints under `firefly-api.adobe.io/v3/*`.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: custom-models
---

# Firefly Custom Models

Train and use brand-aligned generative models. Custom Models capture distinctive aesthetics, characters, objects, or compositional patterns from 10-30 reference images and apply them to new generations via `customModelId`. This is the production pattern for brand-guardrail generative workflows.

## When to Use This Skill

Use this skill when:
- The user needs brand-consistent output that base Firefly cannot achieve
- A specific subject (mascot, product, character) must appear consistently
- A specific visual style (icon set, illustration style, brand voice) must be enforced
- The user mentions training data, reference images, or fine-tuning
- Iconography, brand assets, or character generation is the use case

Do **NOT** use this skill when:
- A style preset or style image reference will do the job — start there, only train when those are insufficient
- The customer has not purchased Custom Models entitlement — confirm SKU first
- The reference set is < 10 images or > 1000 — too few yields noise, too many is wasteful

## Subject vs Style Models — Pick Correctly

| Model type | Captures | Use for |
|---|---|---|
| **Subject** | A specific character, product, or object | "Generate our brand mascot in different scenarios" |
| **Style** | Color palette, brush technique, composition language | "Generate any image in our brand's icon style" |

You cannot mix — a model is either subject or style. For a workflow that needs both (specific character in specific style), train two models and use them together via the reference parameters.

### The iconography pattern

For enterprise brand iconography, **style models** (not subject) are the right choice. Train one style model per distinct icon treatment your brand uses — typical sets include light, dark, and functional variants. Each model is trained on 10-30 examples that share the visual treatment. Workflow:

1. User prompt: "an icon of a key"
2. Generate with the appropriate style custom model
3. Output is in the brand icon style automatically — no human styling needed
4. Last-mile edit in Adobe Express if needed

Result: icon production cycle time can be reduced dramatically — from days or weeks of design work down to a single review-and-polish session.

## Step 1 — Prepare Training Data

Quality of training data is the dominant factor in output quality. The single biggest mistake is uploading bad data.

### Subject models

10-30 images of the same subject from varied angles, lighting, and contexts. The model needs to learn what is *consistent* about the subject — uniform images teach nothing about variation.

### Style models

10-30 images that share the visual style you want to capture. They should NOT all be the same subject — different subjects rendered in the same style is what teaches the model to apply the style independent of content.

### Quality checklist

| Property | Requirement |
|---|---|
| Resolution | At least 1024×1024 for each image |
| Format | JPEG or PNG |
| File size | Under 8MB per file |
| Subject framing (subject models) | Subject prominent, varied background, varied angle |
| Style consistency (style models) | All examples truly in target style — exclude outliers |
| Diversity (style models) | Different subjects across examples |
| Quantity | 10 (minimum useful), 20-30 (sweet spot), beyond 30 (diminishing returns) |

Filter aggressively. A 15-image set of strong examples beats a 30-image set with 5 weak ones.

## Step 2 — Upload Reference Images to Storage

Custom Model training reads images from pre-signed URLs you provide. Upload to your own bucket first. See `firefly-services-storage-refs`.

```bash
# Example: upload a set to S3
for f in ./training-set/*.png; do
  aws s3 cp "$f" s3://my-bucket/cm-training/$(basename "$f")
done

# Generate pre-signed URLs valid for 24 hours (training is async, can take hours)
for f in ./training-set/*.png; do
  aws s3 presign s3://my-bucket/cm-training/$(basename "$f") --expires-in 86400
done > training-urls.txt
```

## Step 3 — Submit a Training Job

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/custom-models' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "brand-light-icon-style",
    "type": "style",
    "trainingImages": [
      {"source": {"url": "https://my-bucket.s3...?<sig>"}, "caption": "key icon, light style"},
      {"source": {"url": "https://my-bucket.s3...?<sig>"}, "caption": "lock icon, light style"},
      // ... 10-30 entries
    ]
  }'
```

Response includes the asset ID and a `statusUrl` for tracking:

```json
{
  "customModelId": "00000000-0000-0000-0000-000000000000",
  "statusUrl": "https://firefly-api.adobe.io/v3/custom-models/.../status",
  "status": "training"
}
```

**Captions matter.** Each training image should have a short caption describing what is in it. This teaches the model what each image is depicting — without captions, training quality drops significantly.

### Naming convention

| Pattern | Example |
|---|---|
| `<customer>-<purpose>-<variant>` | `brand-light-icon-style` |
| Use kebab-case, no spaces, no special chars | |
| Keep under 50 chars | |
| Include version if iterating | `brand-light-icon-style-v2` |

Names appear in logs, audit trails, and downstream dashboards. Good names save weeks of "which model was that?".

## Step 4 — Poll for Training Completion

Training is async and can take **1-6 hours** depending on dataset size and queue depth. Plan accordingly — do not block deployments on training.

```bash
while true; do
  RESPONSE=$(curl --silent "$STATUS_URL" \
    -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
    -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID")
  STATUS=$(echo "$RESPONSE" | jq -r .status)
  echo "Status: $STATUS"
  case "$STATUS" in
    succeeded|failed) break ;;
    *) sleep 300 ;;  # 5-minute poll cadence
  esac
done
```

Status values: `pending` → `training` → `succeeded` | `failed`. The 5-minute cadence is appropriate for training; sub-minute polling provides no value.

**Concurrency: 1 per org.** Custom Model training is single-threaded per IMS org. Submitting a second job while one is training will queue, not parallelize. Plan training batches sequentially.

## Step 5 — Generate With the Custom Model

Once training succeeds, generate with the model by including `customModelId` and the `x-model-version: image3_custom` header:

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate-async' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'x-model-version: image3_custom' \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "an icon of a key",
    "customModelId": "00000000-0000-0000-0000-000000000000",
    "contentClass": "art",
    "size": {"width": 1024, "height": 1024}
  }'
```

The `x-model-version: image3_custom` header is **required** — without it, the request runs against the base Firefly model and ignores `customModelId`. This is the #1 silent failure mode in custom-model workflows.

## Step 6 — Manage Models

### List models

```bash
curl --silent 'https://firefly-api.adobe.io/v3/custom-models' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID"
```

### Get a single model

```bash
curl --silent "https://firefly-api.adobe.io/v3/custom-models/$MODEL_ID" \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID"
```

### Delete a model

```bash
curl --silent -X DELETE "https://firefly-api.adobe.io/v3/custom-models/$MODEL_ID" \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID"
```

Deleted models cannot be recovered. Treat asset IDs as long-lived and don't delete without confirmation from the customer.

## Step 7 — Retraining Cadence

Models capture a moment-in-time of brand aesthetics. When the brand evolves, the model must too.

| Trigger | Action |
|---|---|
| Brand refresh (logo, color, typography change) | Retrain all related models |
| New product launches | Train new subject model; keep old for legacy assets |
| Adobe releases a new base model version | Test existing custom models against it; some require re-training |
| Output quality has visibly drifted | Audit training data, retrain with refreshed examples |

Version models explicitly: `<name>-v2`, `<name>-v3`. Maintain a registry of which version is in production. The registry can live in Catalyst.

## Production Patterns

### Pattern: Per-customer model library

Multi-customer FDE deployments maintain a separate model library per customer. Models are not shared across customers — both for IP-protection reasons and because brand styles do not transfer.

| Customer | Models |
|---|---|
| Customer A | `a-product-subject`, `a-marketing-style` |
| Customer B | `b-icon-light-style`, `b-icon-dark-style`, `b-icon-functional-style` |

Each customer's model IDs are stored in their config (or in Catalyst account profile). The serving layer looks up the right ID per-request.

### Pattern: Style + structure with custom model

Custom models combine with reference images:

```json
{
  "prompt": "an icon of a key",
  "customModelId": "brand-light-icon-style-id",
  "structure": {
    "imageReference": {"source": {"uploadId": "abc-123"}},
    "strength": 60
  }
}
```

The custom model dictates *style*; the structure reference dictates *composition*. Powerful for icon generation where consistent style + specific shape is needed.

## Validate

A custom-model workflow is production-ready when:

1. Training data is curated (10-30 high-quality examples, captioned)
2. Training jobs are tracked by `customModelId` in a model registry
3. Generation calls include `x-model-version: image3_custom` (this is the silent failure)
4. Output samples are reviewed against brand guidelines before generation goes live
5. A retraining cadence is documented (typically quarterly or on brand updates)
6. Model IDs are stored in customer-specific config, not hardcoded

## Troubleshooting & Edge Cases

- **`x-model-version` header missing:** Generation silently uses the base model. Custom output looks generic. Add the header.
- **Training fails immediately:** Almost always bad training URLs — pre-signed URLs expired, or images return 403. Re-sign with 24-hour expiry minimum.
- **Output looks nothing like the training data:** Training set was too uniform (subject model) or too varied (style model). Audit and re-curate.
- **Generation rate-limited:** Custom-model generation shares Firefly generation quota. See `firefly-services-rate-limits`.
- **Model ID returns 404:** Confirm the credential's IMS org matches the org that trained the model. Custom models are scoped to the training org.
- **Training queued for hours, no progress:** Another training job from the same org is in flight. Queue is sequential per org.
- **Output quality degraded after Adobe model update:** The base model under the custom layer was updated. Retrain to align with the new base.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Required for training data upload
- `firefly-generate-image-v3-async` — Generation pipeline
- `firefly-services-troubleshoot` — When generation fails

## References

- [Firefly Custom Models Overview](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/)
- [Custom Models — Generate Image guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/cm-generate-image/)
- [Custom Models — Share Model guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/cm-share-model/)
