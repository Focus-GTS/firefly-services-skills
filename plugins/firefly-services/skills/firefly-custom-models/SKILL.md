---
name: firefly-custom-models
description: Train, manage, and invoke Adobe Firefly Custom Models — subject vs style models, training data preparation (10-30 reference images), training submission and polling, asset ID management, generation with `customModelId` and `x-model-version: image3_custom`, retraining cadence, and brand-aligned generation at scale. Use whenever the user mentions "custom model", "brand model", "train a model", "fine-tune Firefly", "subject model", "style model", "Custom Models API", `customModelId`, or describes iconography / brand-asset / character generation that requires consistency. Encodes the production pattern for brand iconography workflows where custom-model output dramatically reduces design cycle time.
license: Apache-2.0
compatibility: Requires `firefly_enterprise` scope on the access token. Customer must hold a Custom Models entitlement (sold separately, typically as a bundle of 100 model slots). Models are trained in the Firefly web app; generation consumes them via `firefly-api.adobe.io/v3/images/generate` with `customModelId` and `x-model-version: image3_custom`.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: custom-models
---

# Firefly Custom Models

Use brand-aligned generative models. Custom Models capture distinctive aesthetics, characters, objects, or compositional patterns from 10-30 reference images and apply them to new generations via `customModelId`. This is the production pattern for brand-guardrail generative workflows.

> **Important — training happens in the Firefly web UI, not the API.** There is no public REST API for training, listing, or deleting custom models. Models are **trained interactively in the Firefly web app** (firefly.adobe.com). The Firefly Services API only **consumes** a trained model at generation time via `customModelId` plus the `x-model-version: image3_custom` header. This skill covers preparing data, training in the web UI, finding the model's asset ID, and generating with it.

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

## Step 2 — Train the Model in the Firefly Web App

Custom Models are trained interactively in the Firefly web app (firefly.adobe.com) by a user with a Custom Models entitlement — **not via a REST call.** The workflow:

1. In the Firefly web app, start a new custom model and choose **Subject** or **Style**.
2. Upload the curated 10-30 reference images prepared in Step 1.
3. Add a short caption to each image describing what it depicts. **Captions matter** — they teach the model what each image is depicting, and training quality drops significantly without them.
4. Name the model using a consistent convention (see below) and start training.
5. Training runs server-side and can take a while (often an hour or more, depending on dataset size and queue depth). The web app shows progress; you do not poll an API.

### Naming convention

| Pattern | Example |
|---|---|
| `<brand>-<purpose>-<variant>` | `brand-light-icon-style` |
| Use kebab-case, no spaces, no special chars | |
| Keep under 50 chars | |
| Include version if iterating | `brand-light-icon-style-v2` |

Names appear in the web app, audit trails, and downstream dashboards. Good names save weeks of "which model was that?".

## Step 3 — Find the Model's Asset ID

When training completes, the model exists as an **asset** in your Firefly account. Open the model in the Firefly web app and copy its **asset ID** (`assetId`). That asset ID is exactly the value you pass as `customModelId` in generation requests — they are the same identifier. Record it in your model registry alongside the model name and version.

## Step 4 — Generate With the Custom Model

Generate with the model by passing its asset ID as `customModelId` and sending the `x-model-version: image3_custom` header:

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate' \
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

## Step 5 — Manage Models

Listing, inspecting, retraining, and deleting custom models is done in the Firefly web app — there is no public management REST API. Maintain your own registry mapping model name → asset ID (`customModelId`) → version so generation services can look up the right ID. Treat asset IDs as long-lived; deleting a model in the web app cannot be undone, so confirm before removing one that is in production.

## Step 6 — Retraining Cadence

Models capture a moment-in-time of brand aesthetics. When the brand evolves, the model must too.

| Trigger | Action |
|---|---|
| Brand refresh (logo, color, typography change) | Retrain all related models |
| New product launches | Train new subject model; keep old for legacy assets |
| Adobe releases a new base model version | Test existing custom models against it; some require re-training |
| Output quality has visibly drifted | Audit training data, retrain with refreshed examples |

Version models explicitly: `<name>-v2`, `<name>-v3`. Maintain a registry of which version is in production. The registry can live in your own configuration or asset-management system.

## Production Patterns

### Pattern: Per-customer model library

Multi-customer FDE deployments maintain a separate model library per customer. Models are not shared across customers — both for IP-protection reasons and because brand styles do not transfer.

| Customer | Models |
|---|---|
| Customer A | `a-product-subject`, `a-marketing-style` |
| Customer B | `b-icon-light-style`, `b-icon-dark-style`, `b-icon-functional-style` |

Each customer's model IDs are stored in their config (or in a per-account profile). The serving layer looks up the right ID per-request.

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
2. Trained models are tracked by `customModelId` (asset ID) in a model registry
3. Generation calls include `x-model-version: image3_custom` (this is the silent failure)
4. Output samples are reviewed against brand guidelines before generation goes live
5. A retraining cadence is documented (typically quarterly or on brand updates)
6. Model IDs are stored in customer-specific config, not hardcoded

## Troubleshooting & Edge Cases

- **`x-model-version` header missing:** Generation silently uses the base model. Custom output looks generic. Add the header.
- **Training fails or is rejected in the web app:** Almost always bad training data — too few images, low resolution, or inconsistent style. Re-curate and retrain.
- **Output looks nothing like the training data:** Training set was too uniform (subject model) or too varied (style model). Audit and re-curate.
- **Generation rate-limited:** Custom-model generation shares Firefly generation quota. See `firefly-services-rate-limits`.
- **`customModelId` returns 404:** Confirm the credential's IMS org matches the org that trained the model. Custom models are scoped to the training org. Also confirm the asset ID was copied correctly.
- **Output quality degraded after Adobe model update:** The base model under the custom layer was updated. Retrain to align with the new base.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Storage references for reference images used at generation time
- `firefly-generate-image-v3-async` — Generation pipeline
- `firefly-services-troubleshoot` — When generation fails

## References

- [Firefly Custom Models Overview](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/)
- [Custom Models — Generate Image guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/cm-generate-image/)
- [Custom Models — Share Model guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/cm-share-model/)
