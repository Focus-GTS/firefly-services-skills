---
name: firefly-services-troubleshoot
description: Diagnose and resolve Firefly Services error responses — 401 Unauthorized, 403 Forbidden, 429 Too Many Requests, 5xx, malformed prompts, asset-storage failures, region mismatches, and silent product-profile gates. Use whenever an API call returns a non-2xx response, the user says "Firefly is broken", "I'm getting a 401", "rate limited", "this used to work", "Firefly Services error", "InvalidStorageReference", "ContentValidationError", or pastes a Firefly error body. Returns a triage tree and the specific fix for the most common 30+ failure modes our consultants hit in production at enterprise customers.
license: Apache-2.0
compatibility: Requires a Firefly Services credential pair (`FIREFLY_SERVICES_CLIENT_ID`, `FIREFLY_SERVICES_CLIENT_SECRET`) and `curl` for verification round-trips. Works against `firefly-api.adobe.io` (Firefly) and `image.adobe.io` (Photoshop API, Lightroom API).
allowed-tools: Bash(curl:*) Bash(jq:*) Read
metadata:
  version: "1.0.0"
  category: troubleshooting
---

# Firefly Services Troubleshoot

A triage tree for Firefly Services failures, grounded in the failure modes our consultants hit in production across enterprise FDE engagements. Each entry includes the exact error signature, the underlying cause, and the verified fix.

## When to Use This Skill

Use this skill when:
- A Firefly Services API call returns a 4xx or 5xx
- A call that "used to work" is now failing
- The user pastes a Firefly error body (`{"error_code":..., "message":...}`)
- An asset-storage reference is rejected
- A rate-limit response is returned despite seemingly low volume
- A content-validation rejection is unclear

Do **NOT** use this skill when:
- The user has no credentials yet — run `firefly-services-bootstrap`
- Auth wiring is the question, not an error — use `firefly-services-auth`
- The user is asking about quota planning — use `firefly-services-rate-limits`

## Triage Tree — Start Here

```
Got an error response?
├── HTTP status code is...
│   ├── 401 → Authentication problem      → §1
│   ├── 403 → Authorization / entitlement → §2
│   ├── 429 → Rate limit                  → §3 (and use firefly-services-rate-limits)
│   ├── 400 → Request body invalid        → §4
│   ├── 404 → Resource not found          → §5
│   ├── 422 → Content validation / safety → §6
│   ├── 500 → Adobe-side                  → §7
│   ├── 502/503/504 → Transient infra     → §7
│   └── timeout (no response)             → §7
└── No HTTP status (SDK threw)
    ├── "Cannot read property 'access_token'..." → §1
    ├── "InvalidStorageReference" → §8
    └── "fetch failed" / DNS / TLS → §9
```

Find the section below that matches the error code and follow the steps in order.

## §1 — 401 Unauthorized

**Symptom:**

```json
{"error_code": "401013", "message": "Oauth token is not valid"}
```

or:

```json
{"error_code": "401014", "message": "The access token provided has expired"}
```

| Step | Action | If still failing |
|---|---|---|
| 1.1 | Confirm `Authorization: Bearer <token>` header is present and not empty | Bug in calling code |
| 1.2 | Decode the JWT at jwt.io — confirm `client_id` matches, `exp` is in future | Token is wrong or expired; refresh |
| 1.3 | Re-request a fresh token (see `firefly-services-auth` §1) | Falls through to §2 — auth path works but Firefly rejects it |
| 1.4 | Check that `X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID` is also sent | Firefly requires *both* headers |
| 1.5 | Verify the token was issued with `firefly_api` AND `ff_apis` scopes | Re-issue with correct scope string |

The `X-Api-Key` header is required and easily forgotten. Firefly returns 401 (not 400) when it is missing, which is misleading.

## §2 — 403 Forbidden

**Symptom:**

```json
{"error_code": "403003", "message": "Forbidden"}
```

A 403 means the token is valid but the principal lacks entitlement to call this endpoint or operate on this resource.

| Step | Action |
|---|---|
| 2.1 | Confirm the IMS org owning the credentials has the Firefly Services entitlement (check with the customer's Adobe rep — not a self-service field) |
| 2.2 | Confirm the workspace that issued the credentials is subscribed to the specific API surface — `aio console workspace api list --json` |
| 2.3 | For Custom Models endpoints, confirm `firefly_enterprise` scope is in the token |
| 2.4 | For Photoshop/Lightroom endpoints, confirm `creative_sdk` scope is in the token |
| 2.5 | If credentials were issued in the last 5 minutes, wait — IMS propagation has a tail |

A common gotcha: the customer purchased "Firefly" but not "Firefly Services." These are different SKUs. The user-facing Firefly product (the web app at firefly.adobe.com) does not grant API access. Confirm the SKU.

## §3 — 429 Too Many Requests

**Symptom:** Response is HTTP 429, optionally with `Retry-After: <seconds>` header.

Adobe Firefly API places **default rate limits** on the volume and frequency of API calls. Production default is approximately **4 requests per minute (RPM) per credential**. This is low; production workloads must request an increase.

| Step | Action |
|---|---|
| 3.1 | Read the `Retry-After` header — sleep for that many seconds before retrying |
| 3.2 | Implement exponential backoff with jitter (see `firefly-services-rate-limits`) |
| 3.3 | Queue requests behind a token-bucket limiter set to 80% of your provisioned rate |
| 3.4 | Contact the customer's Adobe account manager to request a rate-limit increase |
| 3.5 | If the limit can't be raised, batch and async — see `firefly-generate-image-v3-async` |

High-volume V1 builds typically hit the 4-RPM ceiling within the first sprint. The production solution is an SQS-fronted queueing layer with dead-letter handling. That pattern is documented in `firefly-services-rate-limits`.

## §4 — 400 Bad Request

The request body is malformed or contains an invalid value. Firefly returns a structured error indicating what is wrong.

**Common 400 signatures:**

| Error | Cause | Fix |
|---|---|---|
| `"message": "size width must be one of [..."]"` | Width/height not in the allowed list | Use one of the supported `image3` output sizes: 2048x2048 and 1024x1024 (square 1:1), 2304x1792 (landscape 4:3), 1792x2304 (portrait 3:4), 2688x1536 (widescreen 16:9), 1344x768 (7:4), 1152x896 (9:7), 896x1152 (7:9) — see endpoint docs |
| `"message": "prompt must not be empty"` | Empty or whitespace-only prompt | Validate prompt length client-side |
| `"message": "Invalid style reference"` | Reference image was not uploaded via the storage endpoint | See `firefly-services-storage-refs` |
| `"message": "Unknown contentClass"` | `contentClass` is `photo` or `art` only (V3); `null` is not allowed | Set explicitly |

When debugging 400s, log the entire request body and compare to the latest endpoint reference. The schema evolves between V2 and V3.

## §5 — 404 Not Found

| Symptom | Cause | Fix |
|---|---|---|
| `GET /v3/jobs/<job_id>` returns 404 | Job ID is wrong, or job is older than 24 hours and was purged | Re-submit; jobs are not retained indefinitely |
| `POST /v3/images/generate` returns 404 | Wrong base URL; V2 endpoints are at `firefly-api.adobe.io/v2`, V3 at `firefly-api.adobe.io/v3` | Check version path |
| Asset URL returns 404 | Pre-signed URLs expire (typically 1 hour) | Re-fetch from the job result |

## §6 — 422 Unprocessable Entity (Content Validation)

Firefly Services has built-in content safety. A 422 means the prompt or input image was rejected by the safety system.

```json
{"error_code": "422001", "message": "Prompt has been blocked due to policy violation"}
```

| Step | Action |
|---|---|
| 6.1 | Identify the trigger phrase — public figures, copyrighted IP, restricted terms, regulated industries |
| 6.2 | Rephrase the prompt to avoid the trigger while preserving intent |
| 6.3 | For input-image safety failures, check that the image does not contain detectable faces of public figures, copyrighted characters, or NSFW content |
| 6.4 | For custom-model workflows, the safety rules apply to *generated* output too — outputs that violate safety are dropped from the result set silently |

This is the most common failure mode for enterprise creative workflows where prompts mention real products or campaigns. Build a prompt-sanitization layer client-side.

## §7 — 5xx / Timeouts

Adobe-side or network failure. Firefly's V3 async endpoints are designed for retry-friendly idempotency.

| Step | Action |
|---|---|
| 7.1 | Retry once after a short delay (1-2s) — many 5xx responses resolve on retry |
| 7.2 | If using V3 async, poll the job again; the job may still complete even if the submission appeared to fail |
| 7.3 | Check the [Adobe Status page](https://status.adobe.com/) for active incidents on Firefly Services |
| 7.4 | If sustained, file a ticket with Adobe Enterprise Support — your account rep can escalate |

Do **not** retry indefinitely on 5xx. Cap at 3 retries with exponential backoff; failing fast and surfacing to the customer is better than retry storms that mask the issue.

## §8 — InvalidStorageReference

Almost all generative endpoints accept image references via the `storage` API. A bare URL or raw bytes will be rejected.

```json
{"error_code": "400312", "message": "Invalid storage reference"}
```

| Step | Action |
|---|---|
| 8.1 | Upload the source image via the [Image Upload API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/image-upload/) to get a storage reference |
| 8.2 | Pass the returned `id` or pre-signed URL as the `source.uploadId` or `source.url` field |
| 8.3 | For Photoshop API, use the `input` and `output` storage reference patterns — see `firefly-services-storage-refs` |
| 8.4 | Input upload IDs (from `/v2/storage/image`) are valid 7 days; if older, re-upload. Your own pre-signed URLs expire on whatever TTL you set — generate just-in-time, not at job-creation time. (Distinct from *output* pre-signed result URLs, which expire ~1 hour.) |

## §9 — Network / DNS / TLS

| Symptom | Cause | Fix |
|---|---|---|
| `ENOTFOUND firefly-api.adobe.io` | DNS failure | Check VPN, corporate proxy, internal DNS |
| `ETIMEDOUT` connecting | Outbound firewall blocks `*.adobe.io` | Allowlist `firefly-api.adobe.io`, `image.adobe.io`, `image.adobe.io`, `ims-na1.adobelogin.com` |
| TLS handshake failure | Out-of-date CA bundle or MITM proxy | Update `ca-certificates`, configure corporate proxy CA correctly |
| Intermittent 502s through proxy | Idle connection timeouts in corporate proxy | Configure shorter keepalive on the HTTP client |

These are environmental, not Adobe-side. Confirm by `curl -v https://firefly-api.adobe.io` from the same machine — if curl fails, the network is the culprit.

## Quick-Reference Diagnostic Commands

```bash
# Token round-trip
curl --silent -X POST 'https://ims-na1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$FIREFLY_SERVICES_CLIENT_ID" \
  --data-urlencode "client_secret=$FIREFLY_SERVICES_CLIENT_SECRET" \
  --data-urlencode 'scope=openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis' \
  | jq .

# Decode a JWT (no signature verify, just inspect)
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Smoke test
curl --silent -X POST 'https://firefly-api.adobe.io/v3/images/generate' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"red apple","numVariations":1,"size":{"width":1024,"height":1024}}' \
  | jq .

# Check workspace API subscriptions
aio console workspace api list \
  --projectName <p> --workspaceName <w> --json | jq '.[] | .name'
```

## Patterns That Cause "It Used to Work"

A failing-but-previously-working Firefly integration usually traces to one of:

1. **Token expired silently** — service has been running >24h with the same token. Refresh.
2. **V2 endpoint deprecated** — migrate to V3 async path.
3. **Adobe model version bumped** — output shape changed; check changelog at `developer.adobe.com/firefly-services/docs/firefly-api/release-notes/`.
4. **Rate limit reduced** — Adobe reduces non-production credentials occasionally; check with account manager.
5. **JWT cert expired** — migrate to OAuth.
6. **Custom model retired** — Adobe expires custom models after periods of inactivity.
7. **Org credential rotated** — somebody on the customer side issued new credentials without telling the integration team.

## References

- [Firefly API Technical Usage Notes](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/usage-notes/)
- [Firefly API Release Notes](https://developer.adobe.com/firefly-services/docs/firefly-api/release-notes/)
- [Adobe Status Page](https://status.adobe.com/)
- `firefly-services-auth` — Auth-specific resolution
- `firefly-services-rate-limits` — Rate-limit playbook
- `firefly-services-storage-refs` — Storage reference patterns
