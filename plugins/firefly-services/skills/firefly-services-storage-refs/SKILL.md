---
name: firefly-services-storage-refs
description: Asset storage and reference patterns for Adobe Firefly Services — Upload Endpoint, pre-signed URLs (S3/Azure/Dropbox/GCS), input source references for generative-fill / expand / similar / Photoshop / Lightroom, output destination references, pre-signed URL expiry, and the producer/consumer split for storage refs in queue-fronted workloads. Use whenever the user mentions "storage reference", "uploadId", "image ID", "pre-signed URL", "InvalidStorageReference", "how do I pass an image to Firefly", "S3 bucket", "Azure blob", or hits a 400312 error. Covers both the Firefly Upload Endpoint (returns an image ID) and the pre-signed-URL pattern (read from your own bucket).
license: Apache-2.0
compatibility: Works with all Firefly Services endpoints that accept image references — Generate Similar, Expand, Fill, Photoshop API (input/output), Lightroom API. Cloud storage support: AWS S3, Azure Blob, Dropbox, Google Cloud Storage (via signed URLs).
allowed-tools: Bash(curl:*) Bash(aws:*) Bash(az:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: storage
---

# Firefly Services Storage References

Pass images into Firefly endpoints and capture results out of them. Almost every generative or editing API requires an image to be **referenced**, not passed inline — and the rules differ by endpoint family. This skill is the canonical reference for the patterns.

## When to Use This Skill

Use this skill when:
- An API call needs an image as input (style ref, content ref, source image)
- A user is hitting `InvalidStorageReference` (error code 400312)
- Designing the storage layer for a pipeline that ingests customer assets and produces generative output
- Wiring Photoshop API input/output destinations
- The user asks "how do I get an image into Firefly" or "where does the output go"

Do **NOT** use this skill when:
- The endpoint only needs a text prompt (basic Generate Image) and the user hasn't asked about ingesting reference images
- The user is uploading bulk training data for Custom Models — see `firefly-custom-models` for that workflow

## The Two Storage Patterns

Firefly Services accepts image references in **two formats**. Pick one per workflow — do not mix.

### Pattern A — Firefly Upload Endpoint (returns image ID)

The Firefly API has its own image-storage endpoint. You POST raw bytes, get back a short-lived image ID, and pass that ID to subsequent calls.

```
POST /v2/storage/image
  ↓ returns: {"images": [{"id": "abc-123..."}]}
Use: {"source": {"uploadId": "abc-123..."}}
```

**Use this pattern when:**
- The source image is in local storage (filesystem, in-memory)
- You want Firefly to handle storage entirely
- You don't have an existing CDN / bucket with the assets

**Limitations:**
- Image IDs are short-lived (Adobe doesn't publish the exact TTL — design for 1 hour)
- Cannot be retrieved later; one-shot input ID
- No control over storage location (Adobe-managed)

### Pattern B — Pre-signed URL (read from your own bucket)

You upload to your own bucket, generate a pre-signed URL that grants read access, and Firefly fetches from it.

```
Upload to S3/Azure/GCS (your storage)
  ↓
Generate pre-signed URL (your code)
  ↓
Pass to Firefly: {"source": {"url": "https://your-bucket.s3..."}}
```

**Use this pattern when:**
- Assets already live in customer storage (typical FDE scenario)
- You want auditability of which assets were used
- The same asset will be referenced by multiple Firefly calls (don't re-upload)
- You need long-term retention of the source asset

**Supported sources:** AWS S3, Azure Blob, Dropbox, Google Cloud Storage (with appropriate signing).

## Pattern A — Upload Endpoint Workflow

### Step 1 — Upload the image

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v2/storage/image' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H "Content-Type: image/png" \
  --data-binary "@./input.png"
```

Response:

```json
{"images": [{"id": "abc-123-def-456-...."}]}
```

Node example (using axios):

```js
import axios from 'axios';
import fs from 'node:fs';

async function uploadToFirefly({ filePath, mimeType, accessToken, clientId }) {
  const stream = fs.createReadStream(filePath);
  const stats = fs.statSync(filePath);

  const res = await axios.post(
    'https://firefly-api.adobe.io/v2/storage/image',
    stream,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-API-Key': clientId,
        'Content-Type': mimeType,
        'Content-Length': stats.size,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  );

  return res.data.images[0].id;
}
```

### Step 2 — Reference the image in subsequent calls

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate-similar' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": {"uploadId": "abc-123-def-456-..."},
    "numVariations": 3
  }'
```

### Supported formats

| Format | MIME |
|---|---|
| JPEG | `image/jpeg` |
| PNG | `image/png` |
| WebP | `image/webp` |

Max dimensions and file size vary by endpoint. Generate operations typically accept up to ~8MB. Larger assets need pre-processing (downscale, re-encode).

## Pattern B — Pre-signed URL Workflow

### Step 1 — Upload to your own bucket

```bash
# AWS S3 — upload
aws s3 cp ./input.png s3://my-bucket/sources/input.png \
  --acl private \
  --content-type image/png

# Azure Blob
az storage blob upload \
  --account-name myaccount \
  --container-name sources \
  --name input.png \
  --file ./input.png

# Google Cloud Storage
gcloud storage cp ./input.png gs://my-bucket/sources/input.png
```

### Step 2 — Generate a pre-signed URL

The URL must grant **GET** access to Firefly's backend. Expiry should be just long enough to cover the job duration (1-3 hours is typical; for V3 async jobs, 2 hours minimum).

```bash
# AWS S3 — sign for 2 hours
aws s3 presign s3://my-bucket/sources/input.png --expires-in 7200

# Azure Blob — SAS token, 2 hours
az storage blob generate-sas \
  --account-name myaccount \
  --container-name sources \
  --name input.png \
  --permissions r \
  --expiry $(date -u -d '+2 hours' +'%Y-%m-%dT%H:%MZ') \
  --https-only \
  --full-uri
```

Node S3 example:

```js
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: 'us-east-1' });

async function signedSourceUrl(bucket, key) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 7200 },
  );
}
```

### Step 3 — Reference in the Firefly call

```bash
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate-similar' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{
    "source": {"url": "https://my-bucket.s3.amazonaws.com/sources/input.png?X-Amz-..."},
    "numVariations": 3
  }'
```

## Output Destinations (Photoshop API and Friends)

Photoshop API and Lightroom API write **outputs back to a pre-signed URL** you provide. The pattern:

1. Generate a pre-signed **PUT** URL on your own bucket
2. Pass it as the `output.destination.url` field in the request
3. Adobe PUTs the result to your bucket
4. Your code reads from your own bucket — Firefly never holds the output

Example for Photoshop smart-object replacement:

```bash
# Generate signed PUT URL
OUTPUT_URL=$(aws s3 presign s3://my-bucket/outputs/result.psd \
  --expires-in 7200 \
  --method PUT)

curl --silent -X POST 'https://pscx.adobe.io/v2/smartObject' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-API-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d "{
    \"inputs\": [{\"href\": \"$SOURCE_URL\", \"storage\": \"external\"}],
    \"options\": {\"layers\": [...]},
    \"outputs\": [{\"href\": \"$OUTPUT_URL\", \"storage\": \"external\", \"type\": \"vnd.adobe.photoshop\"}]
  }"
```

The `storage` field distinguishes the location type:

| Value | Meaning |
|---|---|
| `external` | Pre-signed URL on your bucket |
| `adobe` | Adobe-managed (rarely needed) |
| `aws` | AWS S3 (synonym for external in most APIs) |
| `azure` | Azure Blob |
| `dropbox` | Dropbox |
| `gdrive` | Google Drive |

## Pre-signed URL Expiry — The #1 Production Gotcha

Pre-signed URLs expire. For long-running async jobs this is a real failure mode.

**Rule:** Generate the URL **just before** the Firefly call, not at job-creation time.

Wrong (causes intermittent 400312 errors):

```js
// User submits job
const sourceUrl = await signUrl(bucket, key, 3600);  // signed for 1 hour
await db.put({ jobId, sourceUrl, status: 'pending' });

// Worker picks up the job 50 minutes later
const job = await db.get(jobId);
await firefly.generate({ source: { url: job.sourceUrl } });  // URL has 10 min left — flaky
```

Right:

```js
// User submits job — store the *key*, not a signed URL
await db.put({ jobId, sourceBucket: bucket, sourceKey: key, status: 'pending' });

// Worker re-signs just before the call
const job = await db.get(jobId);
const sourceUrl = await signUrl(job.sourceBucket, job.sourceKey, 7200);
await firefly.generate({ source: { url: sourceUrl } });
```

This pattern eliminates an entire class of intermittent failure that almost always surfaces when scaling a generative pipeline from UAT to production.

## Bucket / Container Configuration

For pre-signed URL pattern, the bucket must allow GET (and PUT for outputs) from Adobe IP ranges. Don't try to lock down by IP — Adobe's backend hits change. Rely on the pre-signed URL itself as the authentication mechanism.

| Setting | Value |
|---|---|
| Bucket policy | Default — no public access |
| CORS | Not required (Firefly is server-to-server) |
| Encryption | SSE-S3 / SSE-KMS — works fine with pre-signed URLs |
| Versioning | Recommended for source asset auditability |
| Lifecycle | Move sources to Glacier after 30 days; keep outputs hot |

## Multi-Source Inputs

Some endpoints accept multiple image inputs (e.g., style reference + content reference). The shape is consistent:

```json
{
  "prompt": "a cat in the style of the reference",
  "style": {"imageReference": {"source": {"url": "https://..."}}},
  "structure": {"imageReference": {"source": {"url": "https://..."}}}
}
```

Each reference is independent — you can mix Pattern A (Upload Endpoint) and Pattern B (pre-signed URL) within the same request:

```json
{
  "style": {"imageReference": {"source": {"uploadId": "abc-123"}}},
  "structure": {"imageReference": {"source": {"url": "https://..."}}}
}
```

## Validate

Storage references are correctly wired when:

1. Source upload + reference completes in `<2s` for typical 4MB images
2. Pre-signed URLs are generated just-in-time, not stored long-term
3. `InvalidStorageReference` errors do not occur in production
4. Outputs land in your own bucket with predictable keys
5. Source asset audit trail is preserved (versioning or separate audit log)

## Troubleshooting & Edge Cases

- **`InvalidStorageReference` (400312):** Either the `uploadId` is stale (>1 hour old) or the pre-signed URL is expired / returns non-200 / returns wrong content-type. Re-sign just before the call.
- **Upload returns 413 Payload Too Large:** Image exceeds endpoint limit (~8MB for most generate endpoints). Downscale before uploading.
- **Upload returns 415 Unsupported Media Type:** `Content-Type` is missing or wrong. Must match the actual format (`image/jpeg`, `image/png`, `image/webp`).
- **Adobe can't fetch the pre-signed URL:** Test by `curl -I <url>` from anywhere. If you get a 200, Adobe can too. If 403, the signing failed; regenerate.
- **Pre-signed URL works for input but Photoshop API can't write to output:** PUT URL needs `--method PUT` when generating. GET URLs cannot be used as PUT destinations.
- **Different cloud (GCS or Azure) returns 403 to Firefly:** Pre-signing parameters differ from AWS. Use the cloud's own signing tool — not S3-style query parameters.

## Chaining with Other Skills

- `firefly-services-bootstrap` — Has to run before any storage work
- `firefly-generate-image-v3-async` — Most common storage-ref consumer
- `firefly-generate-similar` — Pure source-reference workflow
- `firefly-expand-fill` — Source + mask reference workflow
- `photoshop-api-actions` — Input + output destination pattern

## References

- [Firefly Image Upload Guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/image-upload/)
- [Firefly Storage Reference Concepts](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/)
- [Photoshop API Storage](https://developer.adobe.com/firefly-services/docs/photoshop/general-workflow/)
- [AWS S3 Presigning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html)
- [Azure Blob SAS Tokens](https://learn.microsoft.com/en-us/azure/storage/common/storage-sas-overview)
