---
name: firefly-generate-similar
description: Generate variations of an existing image using Adobe Firefly's Generate Similar API — how it differs from Generate Image with a style reference, when to use it for campaign variation generation, controlling variation diversity, multi-variation batches, and the production pattern for "give me 50 variations of this hero asset". Use whenever the user wants "variations", "more like this", "similar images", "generate-similar", "give me 10 versions of this", or runs campaigns that need many derivatives of a single approved hero. Encodes the variation-generation pattern used in production for enterprise campaign asset multiplication.
license: Apache-2.0
compatibility: Requires `firefly_api`, `ff_apis` scopes. Endpoint: `firefly-api.adobe.io/v3/images/generate-similar-async`. Source images passed as storage refs.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: image-generation
---

# Firefly Generate Similar

Generate variations of a source image. This is the workhorse API for campaign asset multiplication — one approved hero becomes 10, 50, or 200 variations for A/B testing, channel adaptation, and creative iteration.

## When to Use This Skill

Use this skill when:
- The user has an approved source image and wants variations of it
- A campaign needs many derivatives from a single hero asset
- A/B testing requires multiple options from the same concept
- The user mentions "variations", "more like this", "similar but different"

Do **NOT** use this skill when:
- The user wants a completely new image — use `firefly-generate-image-v3-async`
- The user wants to *extend* the canvas — use `firefly-expand-fill`
- The user wants the same image with a different background — use `firefly-expand-fill` (Fill)
- The variations need to match a *style* learned from many images — use `firefly-custom-models`

## Generate Similar vs Generate with Style Reference

A subtle but important distinction:

| Need | API |
|---|---|
| Variations of *this specific image* | **Generate Similar** |
| New images inspired by *this style* | Generate Image with `style.imageReference` |

Generate Similar treats the source as an anchor — outputs are recognizable derivatives. Style reference treats the source as inspiration — outputs share aesthetic but not subject.

For campaign variation generation (hero-asset variants for a single approved concept), Generate Similar is correct. For applying brand style to *new* subjects across a campaign creator, use generate-with-style-reference.

## Step 1 — Submit the Generate Similar Job

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate-similar-async' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "image": {"source": {"uploadId": "$SOURCE_UPLOAD_ID"}},
    "numVariations": 4,
    "size": {"width": 1024, "height": 1024}
  }'
```

Returns the async job pattern — poll the same way as other async endpoints.

## Step 2 — Request Shape

```json
{
  "image": {"source": {"uploadId": "abc-123"}},
  "numVariations": 4,
  "size": {"width": 1024, "height": 1024},
  "seeds": [12345, 67890, 11111, 22222]
}
```

| Field | Notes |
|---|---|
| `image.source` | Storage reference — `uploadId` or pre-signed `url` |
| `numVariations` | 1-4 per job. For more, submit multiple jobs |
| `size` | Same constraints as Generate Image — pick from supported list |
| `seeds` | Optional array; one seed per variation. Same seeds = reproducible outputs |

## Step 3 — Controlling Variation Diversity

Generate Similar's diversity is implicit — the API decides how far to deviate from the source. There is no `strength` parameter, unlike style reference.

To get **more diversity**, run multiple jobs with different seeds. The variation between *jobs* is larger than the variation *within* a job.

To get **less diversity** (keep variations very close to source), generate fewer variations per job (1-2) — Firefly tends to make stronger deviations in larger variation sets.

## Step 4 — The Variation Pipeline Pattern

For a typical "50 variations of one key-art" workload:

```js
async function generateNVariations({ sourceUploadId, n }) {
  const variationsPerJob = 4;
  const numJobs = Math.ceil(n / variationsPerJob);

  const jobPromises = Array.from({ length: numJobs }, (_, i) =>
    submitGenerateSimilar({
      sourceUploadId,
      numVariations: variationsPerJob,
      seeds: [
        Math.floor(Math.random() * 1_000_000),
        Math.floor(Math.random() * 1_000_000),
        Math.floor(Math.random() * 1_000_000),
        Math.floor(Math.random() * 1_000_000),
      ],
    }),
  );

  const results = await Promise.all(jobPromises);
  return results.flatMap(r => r.result.outputs);
}
```

Each job runs in parallel (limited by token-bucket — see `firefly-services-rate-limits`). 50 variations = 13 parallel jobs. With a provisioned higher RPM (typical for enterprise contracts), this completes in roughly 30 seconds end-to-end.

## Production Patterns

### Pattern: Hero → variation funnel

```
Approved hero asset (uploaded to your bucket once)
  ↓ Generate Similar × N (each job 2-4 variations)
50 candidate variations
  ↓ Human selection (or automated quality scoring)
Top 10 chosen
  ↓ Auto-resize via Expand (multiple aspect ratios)
40 final assets (10 variations × 4 aspects)
```

This is the multiplication pattern that turns a manual "create N variants" effort (weeks of designer work) into a "submit one source, pick the best ten" workflow (hours of work).

### Pattern: A/B with deterministic seeds

For experiments where you need reproducibility:

```js
const seeds = await db.assignSeedsForExperiment(experimentId);
// Same experiment + same seeds = same outputs every time
const variations = await submitGenerateSimilar({
  sourceUploadId: HERO_ID,
  numVariations: seeds.length,
  seeds,
});
```

Store seeds with the experiment record. Re-running the experiment will produce identical outputs, which is what reproducibility requires.

## Validate

A Generate Similar pipeline is production-ready when:

1. Source assets are uploaded once and reused across many variation jobs (don't re-upload per job)
2. Variation count is appropriate to the use case (3-4 per job, multiple jobs for more)
3. Seeds are explicitly set when reproducibility matters
4. Output URLs are downloaded immediately and re-hosted in your own bucket
5. Variation jobs run in parallel within rate limits, not serially

## Troubleshooting & Edge Cases

- **All variations look identical:** Seeds are the same. Randomize seeds across the job.
- **Variations are too far from the source:** Submit smaller variation batches (1-2 per job). Larger batches push more diversity.
- **Output is the same as the source:** Source is being read but the model decided minimum deviation was appropriate. Try a different source — heavily-processed photos confuse the model.
- **Aspect ratio of output differs from source:** Set `size` explicitly. Default is the largest supported aspect that matches the source.
- **Source image returns 400312:** Storage reference is stale or expired. See `firefly-services-storage-refs`.

## Chaining with Other Skills

- `firefly-services-storage-refs` — Source asset upload
- `firefly-generate-image-v3-async` — Same async pattern
- `firefly-expand-fill` — Aspect-ratio expansion of selected variations
- `firefly-services-rate-limits` — Batch parallelism

## References

- [Generate Similar API Reference](https://developer.adobe.com/firefly-services/docs/firefly-api/api/)
- [Image Upload Concept](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/image-upload/)
- [Seeds Concept](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/seeds/)
