# Skill validation record

**Last full pass: 2026-08-10.** Method: three stages — (1) static validation of every technical claim in all 19 skills against the OpenAPI specs bundled in the official Adobe SDKs (`@adobe/firefly-apis`, `@adobe/photoshop-apis`, `@adobe/lightroom-apis` v2.0.1) and the live-validated tool implementations of [`@focusgts/firefly-services-mcp`](https://github.com/Focus-GTS/firefly-services-mcp); (2) verified repair of all 68 drift items found (60 fixes applied, each re-verified against its cited source before editing); (3) **live proof against the production Adobe Firefly Services API** — 60+ serialized calls exercising the skills' claims end-to-end, including deliberate error probes. Where live behavior contradicted the specs, the live behavior won and the skills were corrected again.

## Verdicts

| Skill | Status | Live evidence highlights |
|---|---|---|
| `firefly-services-bootstrap` | ✅ Proven | Scope behaviors live-tested (incl. IMS silently ignoring unknown scopes); `aio` CLI command surface verified against the real CLI; token round-trip confirmed |
| `firefly-services-auth` | ✅ Proven | SDK `ServerToServerTokenProvider` executed three ways — throws without `autoRefresh`, works with it, returns the cached token after forced expiry (all as documented); `invalid_client`, HEAD→405 confirmed |
| `firefly-services-troubleshoot` | ✅ Proven | Full error map captured live: 401 `401013` (bad token), 403 `403000` (missing API key), 400 `bad_request` + `validation_errors[]` (schema), 422 `prompt_unsafe` / `validation_error` (safety/reference); status-URL pattern confirmed |
| `firefly-services-storage-refs` | ✅ Proven | generate-similar old shape 400-rejected / fixed shape 200; GCS rejected on the Firefly allowlist; upload endpoint round-trip; PS/LR `storage: "external"` asymmetry consistent with June MCP validation |
| `firefly-services-rate-limits` | ✅ Proven | 8-call burst: zero 429s, zero rate-limit headers → limits are org-specific and header-invisible; guidance updated to 429-reactive backoff |
| `firefly-generate-image-v3-async` | ✅ Proven | `generate-async` 202 with jobId/statusUrl/cancelUrl, polled to `succeeded`; seeds-must-equal-numVariations, size, and strength rules captured with exact live error bodies; valid-size list captured verbatim |
| `firefly-expand-fill` | ✅ Proven | `expand-async` and `fill-async` exist (202); wrong mask shape 422-rejected, fixed shape correct; placement alignment+inset accepted |
| `firefly-generate-similar` | ✅ Proven | Fixed request shape 200 (default output 2048×2048 from a 1024 source); UUID validation on uploadId captured |
| `firefly-video-model` | ✅ Proven | Image-to-video with `image.conditions[]` + `x-model-version: video1_standard` submitted, polled, **succeeded with video URL**; size flexibility live-tested (1080×1080 accepted and completed) |
| `firefly-cost-optimization` | ✅ Proven (claim corrected) | Seed determinism refuted by live hash comparison — skill now teaches archive-the-artifact; immediate output-URL fetch confirmed |
| `firefly-skills-catalog` | ✅ Validated (static + its own CI) | Meta-skill; no API claims. Regenerates via scheduled GitHub Action |
| `firefly-project-planner` | ✅ Validated (static) | Meta-skill; no API claims; all cross-references verified |
| `photoshop-api-actions` | 🟡 Pending fixture pass | Static-validated + quality/enum probes; full proof needs the PSD/.atn fixture suite (multi-action selection, duplicate layer names, font fallback) |
| `photoshop-api-composition` | 🟡 Pending fixture pass | `sensei/mask` V1 EOL confirmed live (502); async `notify` block accepted at submission; full state-machine run needs fixtures |
| `lightroom-api-batch` | 🟡 Pending fixture pass | TIFF-output rejection confirmed live; raw-file ingestion and multi-output proof needs fixtures |
| `firefly-custom-models` | ⏸ Held (entitlement) | `GET /v3/custom-models` confirmed live (skill corrected); generation proof requires a trained model, which this org does not have |
| `firefly-brand-guardrails` | ⏸ Held (entitlement) | Layer-1 proof depends on custom-model access |
| `firefly-batch-pipeline` | ⏸ Held (infrastructure) | Architecture pattern; full proof requires deploying the AWS reference stack |
| `genstudio-extensibility-scaffold` | ⏸ Held (environment) | Requires an App Builder environment |

**Marketplace submission policy:** only ✅ skills are submitted. 🟡 skills join after the fixture pass. ⏸ skills stay in this repository until they can be fully proven.

Raw evidence (request/response logs with status codes, bodies, and headers) is retained internally; identifiers and org-specific values are not published here.
