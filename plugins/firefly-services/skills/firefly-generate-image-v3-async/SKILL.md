---
name: firefly-generate-image-v3-async
description: Generate images with the Adobe Firefly V3 asynchronous API — job submission, status polling, webhook callbacks, prompt structure, content class, style and structure references, seed control, multi-variation results, and the migration from V2 sync to V3 async. Use whenever the user wants to "generate an image with Firefly", "text-to-image", "Firefly V3", "async generate", "polling", "jobId", "statusUrl", or upgrades from V2 sync. Returns the production pattern for the highest-volume Firefly workload — including the polling cadence that does not get rate-limited and the webhook pattern that scales to thousands of concurrent jobs.
license: Apache-2.0
compatibility: Requires Firefly Services credentials and `firefly_api`, `ff_apis` scopes. Async endpoints live at `firefly-api.adobe.io/v3/*-async`. Node 18+ or any HTTP client with retry support.
allowed-tools: Bash(curl:*) Bash(jq:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: generate-image
---

# Firefly Generate Image — V3 Async

The production pattern for text-to-image generation with Adobe Firefly's V3 asynchronous API. V3 async is the right shape for every workload above one-off interactive use. The synchronous V2 endpoint is still available but its 30-second timeout and per-request blocking make it unsuitable for production volume.

## When to Use This Skill

Use this skill when:
- Generating images from text prompts at any production volume
- Migrating from V2 sync (`/v2/images/generate`) to V3 async (`/v3/images/generate-async`)
- Building a campaign pipeline, banner-at-scale system, or batch generator
- Adding style or structure references to a generate call
- Designing a webhook-based generation pipeline

Do **NOT** use this skill when:
- The user wants a *variation* of an existing image — use `firefly-generate-similar`
- The user wants to *extend* an image canvas — use `firefly-expand-fill`
- The user is generating video — use `firefly-video-model`

## Sync vs Async — When to Use Which

| Property | V2 sync (`/v2/images/generate`) | V3 async (`/v3/images/generate-async`) |
|---|---|---|
| Latency to first byte | 10-30s (blocking) | ~200ms (returns jobId) |
| Time to result | Same | Same |
| Connection lifetime | Whole job | Just submission |
| Resilient to caller restarts | No — results lost on disconnect | Yes — pick up by jobId |
| Webhook callbacks | No | Yes (preferred) |
| Recommended for production | No | Yes |
| Recommended for one-shot CLI | Acceptable | Acceptable |

**Default to V3 async for everything.** The only acceptable reason to use V2 sync is a one-shot script where the user is watching the terminal.

## The Async Workflow

```
1. POST /v3/images/generate-async  →  { jobId, statusUrl, cancelUrl }
2. Either:
   a. Poll statusUrl every 1-2s until status === "succeeded" | "failed"
   b. OR provide a webhook callback URL — Firefly calls it on completion
3. On success: response includes outputs[].image.url (pre-signed)
4. Download from URL within ~1 hour or it expires
```

## Step 1 — Submit the Generation Job

Minimum required request:

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate-async' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a single red apple on a white background",
    "contentClass": "photo",
    "numVariations": 1,
    "size": {"width": 1024, "height": 1024}
  }'
```

Response:

```json
{
  "jobId": "urn:ff:jobs:eso851211:86ffe2ea-d765-4bd3-b2fd-568ca8fc36ac",
  "statusUrl": "https://firefly-api.adobe.io/v3/status/urn:ff:jobs:...",
  "cancelUrl": "https://firefly-api.adobe.io/v3/cancel/urn:ff:jobs:..."
}
```

The submission returns in ~200ms regardless of job complexity. Persist the `jobId` immediately — that is the only thing that lets you recover the result if the worker crashes mid-poll.

## Step 2 — Request Shape

Full request shape with all common fields:

```json
{
  "prompt": "string (required, 1-1024 chars)",
  "negativePrompt": "string (optional, things to avoid)",
  "contentClass": "photo | art",
  "numVariations": 1,
  "size": {"width": 1024, "height": 1024},
  "seeds": [12345],
  "visualIntensity": 6,
  "style": {
    "presets": ["bold_colors"],
    "imageReference": {"source": {"uploadId": "abc-123"}},
    "strength": 75
  },
  "structure": {
    "imageReference": {"source": {"url": "https://..."}},
    "strength": 50
  },
  "customModelId": "optional-uuid-for-custom-model"
}
```

### Supported sizes (V3)

| Aspect | Sizes |
|---|---|
| Square | 1024×1024, 2048×2048 |
| Landscape | 1408×768, 1792×1024, 2304×1280 |
| Portrait | 768×1408, 1024×1792, 1280×2304 |

Other dimensions are rejected with a 400. Pick from this list, or generate at the nearest match and crop in post.

### Content class

| Value | Use for |
|---|---|
| `photo` | Photorealistic output — products, scenes, people |
| `art` | Stylized output — illustrations, paintings, designs |

Defaults to a balanced output; setting explicitly produces sharper results in the chosen direction.

### Variations and seeds

- `numVariations`: 1-4. Production typically uses 2-4 to give downstream selection logic options.
- `seeds`: array of integers. Same seed + same prompt + same model = deterministic output. Use seeds for A/B testing or reproducibility audits.

## Step 3 — Poll for Completion

```bash
JOB_ID=$(echo "$SUBMIT_RESPONSE" | jq -r .jobId)
STATUS_URL=$(echo "$SUBMIT_RESPONSE" | jq -r .statusUrl)

while true; do
  RESPONSE=$(curl --silent "$STATUS_URL" \
    -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
    -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID")
  STATUS=$(echo "$RESPONSE" | jq -r .status)
  case "$STATUS" in
    succeeded|failed) echo "$RESPONSE"; break ;;
    *) sleep 1 ;;
  esac
done
```

Node implementation:

```js
async function pollJob(statusUrl, accessToken, clientId, { intervalMs = 1000, maxMs = 300_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(statusUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Api-Key': clientId,
      },
    });
    if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
    const data = await res.json();
    if (data.status === 'succeeded' || data.status === 'failed') return data;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Job polling timed out');
}
```

### Polling cadence

| Cadence | When to use |
|---|---|
| 1s | Interactive workloads, user is waiting |
| 2s | Background batch jobs, no user attention |
| 5s | Very large batches where polling rate matters more than latency |

Polling every 250ms or faster is wasteful — typical Firefly V3 jobs complete in 3-10 seconds. Sub-second polling will not make them complete faster.

### Polling does not consume generation quota

Status calls are billed and rate-limited separately from generation. You can poll aggressively without burning your generation rate limit. Production worry is wasted compute, not quota.

## Step 4 — Webhook Callbacks (Preferred at Scale)

For production batch workloads, webhooks beat polling. Pass a `notify` URL on submission and Firefly calls it when the job completes.

```json
{
  "prompt": "...",
  "notify": {
    "webhookUrl": "https://api.example.com/firefly/callback",
    "secretKey": "shared-secret-for-hmac-validation"
  }
}
```

Adobe POSTs to the webhook URL with the job result body. Validate the HMAC signature in the `X-Adobe-Signature` header before trusting the payload.

Webhook pattern requires:

| Component | Detail |
|---|---|
| Public URL | Reachable from Adobe IP ranges |
| HMAC validation | SHA-256 over the body with the shared secret |
| Idempotency | Adobe may retry; jobs should be keyed by `jobId` |
| Acknowledge with 2xx | Within 30s; otherwise Adobe retries |

If the webhook fails repeatedly, Adobe falls back to making the result retrievable via the original `statusUrl`. Always implement polling fallback for robustness.

## Step 5 — Read the Result

A succeeded job's response:

```json
{
  "status": "succeeded",
  "jobId": "urn:ff:jobs:...",
  "result": {
    "size": {"width": 1024, "height": 1024},
    "outputs": [
      {
        "seed": 12345,
        "image": {
          "url": "https://pre-signed-cdn-url..."
        }
      }
    ]
  }
}
```

**Download immediately.** The `image.url` is a pre-signed CDN URL that typically expires within 1 hour. For production:

```js
const result = await pollJob(statusUrl, token, clientId);
for (const output of result.result.outputs) {
  const imgRes = await fetch(output.image.url);
  const buffer = await imgRes.arrayBuffer();
  // Persist to your own bucket
  await s3.putObject({
    Bucket: 'my-outputs',
    Key: `${jobId}/${output.seed}.png`,
    Body: Buffer.from(buffer),
    ContentType: 'image/png',
  });
}
```

Never store the raw Firefly URL long-term. Always re-host in your own storage.

## Style and Structure References

Both V3 image generation supports two reference types:

| Reference | Effect |
|---|---|
| `style.imageReference` | Output matches the *visual style* of the reference |
| `style.presets` | Output matches a named style preset |
| `structure.imageReference` | Output matches the *composition* of the reference |

Combine for fine control:

```json
{
  "prompt": "a futuristic city at sunset",
  "contentClass": "art",
  "style": {
    "presets": ["bold_colors"],
    "imageReference": {"source": {"uploadId": "style-ref-id"}},
    "strength": 75
  },
  "structure": {
    "imageReference": {"source": {"uploadId": "structure-ref-id"}},
    "strength": 50
  }
}
```

`strength` 0-100. Higher = stronger influence. Start at 50 and tune.

The reference image must be a valid storage reference — see `firefly-services-storage-refs`.

## Custom Models

To generate with a custom-trained model:

```json
{
  "prompt": "an icon of a key in our brand style",
  "customModelId": "00000000-0000-0000-0000-000000000000",
  "contentClass": "art",
  "size": {"width": 1024, "height": 1024}
}
```

Custom model IDs come from the custom-model training workflow — see `firefly-custom-models`.

## Production Patterns

### Pattern: Single-job CLI

For interactive one-shot use, submit + poll in a single function. Acceptable for <50 calls.

### Pattern: Queue-fronted batch

For >50 calls, use the SQS / Lambda / Token-Bucket pattern from `firefly-services-rate-limits`. Each queue message is one `generate-async` call. Worker submits, polls (or relies on webhook), persists result.

### Pattern: Multi-variation A/B funnel

For campaigns where you want choice:

1. Submit with `numVariations: 4` and 2-4 different seeds
2. Persist all 4 outputs to your bucket
3. Downstream selection logic (human or automated) picks 1
4. Audit which combinations win for future prompt tuning

This is the standard pattern for key-art generation in enterprise campaign pipelines — variations give downstream creative teams options without re-running the pipeline.

## Validate

A correctly wired V3 async pipeline:

1. Submits jobs and persists `jobId` before any subsequent work
2. Polls with 1-2s cadence, or uses webhook callbacks
3. Honors `statusUrl` from the submission response — does not hardcode URLs
4. Downloads result URLs within 1 hour and re-hosts in your own bucket
5. Has retry-with-backoff on submission (covered by `firefly-services-rate-limits`)
6. Logs `jobId` for every submission for downstream audit

## Troubleshooting & Edge Cases

- **`numVariations` > 4 rejected:** Max is 4. Submit multiple jobs if you need more.
- **Size rejected as invalid:** Use only the published sizes (see Supported sizes table above).
- **`prompt` rejected as too long:** Max 1024 chars. Strip or rephrase.
- **Webhook never fires:** Adobe was unable to reach the URL. Test with a `curl -X POST` from outside your VPC. Fall back to polling.
- **Job stuck in `running` for >5 minutes:** Cancel via `cancelUrl` and resubmit. Adobe-side jobs almost always complete in under 30s; 5+ minutes is a sign something is wrong.
- **`outputs` array is empty on success:** Content safety filtered all variations. Rephrase the prompt — see `firefly-services-troubleshoot` §6.
- **Different output between identical requests:** Set `seeds: [<int>]` for determinism.

## Chaining with Other Skills

- `firefly-services-auth` — Token freshness before submission
- `firefly-services-storage-refs` — Required for any reference-image-based generation
- `firefly-services-rate-limits` — Production batch pipeline
- `firefly-services-troubleshoot` — When generation fails

## References

- [Firefly Async API Guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis/)
- [Generate Image V3 API Reference](https://developer.adobe.com/firefly-services/docs/firefly-api/api/)
- [Style Reference Concepts](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/style-image-reference/)
- [Structure Reference Concepts](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/structure-image-reference/)
- [Seeds Concept](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/seeds/)
