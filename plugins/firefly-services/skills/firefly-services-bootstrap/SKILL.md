---
name: firefly-services-bootstrap
description: Wire up a new Adobe Firefly Services project from scratch end-to-end — Adobe Developer Console project, OAuth Server-to-Server credentials, API subscriptions, environment variables, SDK install, and the first successful API call. Use whenever the user says "set up Firefly Services", "create a new Firefly project", "bootstrap Firefly", "I need credentials for Firefly", "starting a Firefly Services engagement", or describes a from-zero state where no `client_id` / `client_secret` exists yet. Also covers the recovery path when an existing project is partially configured — workspace exists but no API subscription, credentials issued but never tested, SDK installed but no token retrieved. Outputs a working local environment with `FIREFLY_SERVICES_CLIENT_ID`, `FIREFLY_SERVICES_CLIENT_SECRET`, and a verified first API call.
license: Apache-2.0
compatibility: Requires `aio` CLI (`npm install -g @adobe/aio-cli`) for non-interactive Developer Console operations. Node.js 18+. Adobe ID with a Firefly Services entitlement on your IMS org. Network access to `ims-na1.adobelogin.com` and `firefly-api.adobe.io`.
allowed-tools: Bash(aio:*) Bash(npm:*) Bash(curl:*) Bash(node:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: project-initialization
---

# Firefly Services Bootstrap

Gets a brand-new Firefly Services project from zero to a verified first API call in one workflow. Designed for the opening 30 minutes of an FDE engagement: console project → workspace → OAuth Server-to-Server credentials → API subscription → environment wiring → token retrieval → smoke-test call.

If the user already has working credentials and just needs to call the API, use `firefly-services-auth` directly. If credentials exist but auth is failing, use `firefly-services-troubleshoot`.

## When to Use This Skill

Use this skill when:
- The user is starting a new Firefly Services project and has no `client_id` / `client_secret` yet
- An FDE engagement is kicking off at a new customer account
- An existing Developer Console project needs Firefly Services added as a new API
- The user mentions "bootstrap", "set up", "from scratch", "new credentials", or "first API call"

Do **NOT** use this skill when:
- A valid `FIREFLY_SERVICES_ACCESS_TOKEN` already exists in the current session
- The user is debugging a 401/403/429 — use `firefly-services-troubleshoot`
- The user is migrating from JWT credentials — JWT reached end-of-life on June 30, 2025 and certificates expire by March 1, 2026; rebuild with OAuth Server-to-Server instead

## Prerequisites

| Requirement | How to verify |
|---|---|
| Adobe ID with admin access to an IMS org | `aio console org list --json` returns at least one org |
| The org has a Firefly Services entitlement | `aio console api list --json` includes a Firefly service code |
| `aio` CLI installed and authenticated | `aio --version` returns a version, `aio auth list` shows an active profile |
| Node 18+ for the SDK install step | `node --version` returns `v18.x` or higher |
| `curl` for the token round-trip smoke test | `curl --version` returns curl 7.x or higher |

If the IMS org does not have a Firefly Services entitlement, stop. The customer needs Adobe to provision it before any code path here will succeed. The product is sold separately from a base Creative Cloud subscription.

## Related Skills

- `firefly-services-auth` — Retrieve and refresh OAuth tokens once credentials exist
- `firefly-services-troubleshoot` — Decode 401/403/429 responses and IMS scope mismatches
- `firefly-services-storage-refs` — Wire up the `storage` source/destination layer required by most generate/edit endpoints
- `firefly-generate-image-v3-async` — First real workload after bootstrap

## Step 1 — Confirm or create the Developer Console project

List existing projects in the target org so you do not duplicate one:

```bash
aio console org select <orgId>
aio console project list --json
```

If a project for this customer exists, capture its name and continue to Step 2.

If no project exists, create one:

```bash
aio console project create \
  --name "<customer>-firefly-services" \
  --title "<Customer> Firefly Services" \
  --description "Firefly Services integration for <Customer>" \
  --json
```

Naming convention: `<customer-slug>-firefly-services`. Lowercase, hyphenated, no spaces. The slug is what every downstream consumer will see in tokens, dashboards, and audit logs.

## Step 2 — Create the workspace

Every Console project needs at least one non-Production workspace. `Stage` is the convention; use a more descriptive name only when several long-lived workspaces will share the project.

```bash
aio console workspace create \
  --projectName "<customer>-firefly-services" \
  --name Stage \
  --title "Stage workspace" \
  --json
```

If the workspace already exists, this fails with a clear "already exists" error. Read existing workspaces with `aio console workspace list --projectName <p> --json` and continue to Step 3.

## Step 3 — Subscribe Firefly Services APIs to the workspace

Discover the exact service code(s) available to this IMS org:

```bash
aio console api list --json
```

Firefly Services is offered as a set of related API products. For a typical FDE engagement subscribe at minimum:

| Service | Why |
|---|---|
| `FireflyAPI` / `FireflyServicesSDK` (name varies by org) | Generate / expand / fill image, generate similar, custom models |
| `PhotoshopAPI` | Smart object replacement, action runner, PSD composition |
| `LightroomAPI` | Batch image processing, preset application |
| `ContentTaggingAPI` (optional) | Asset auto-tagging for downstream brand-guardrail workflows |

Subscribe with `workspace api add`:

```bash
aio console workspace api add \
  --projectName "<customer>-firefly-services" \
  --workspaceName Stage \
  --service-code FireflyAPI \
  --json

aio console workspace api add \
  --projectName "<customer>-firefly-services" \
  --workspaceName Stage \
  --service-code PhotoshopAPI \
  --json
```

If a service code requires a product profile (the org has multiple Firefly entitlements with different licensing), `workspace api add` will return `product profile required`. Resolve with:

```bash
aio console workspace api add \
  --projectName "<customer>-firefly-services" \
  --workspaceName Stage \
  --service-code FireflyAPI \
  --license-config FireflyAPI=<ProfileName> \
  --json
```

Ask the org admin for the profile name. There is no public catalog.

## Step 4 — Provision OAuth Server-to-Server credentials

Adobe deprecated JWT credentials on June 30, 2025; all certificates expire by March 1, 2026. Use **OAuth Server-to-Server** exclusively for any new project — even when migrating an existing one. Do not maintain mixed credential types.

Issue credentials inside the workspace:

```bash
aio console workspace credentials create \
  --projectName "<customer>-firefly-services" \
  --workspaceName Stage \
  --type oauth_server_to_server \
  --name "<customer>-firefly-sts" \
  --json
```

This returns a `client_id` and `client_secret`. Capture both immediately. The secret is not retrievable later — only rotatable. Store them in the customer's secrets manager (AWS Secrets Manager, Azure Key Vault, etc.), never in source control.

## Step 5 — Wire the local environment

Export both credentials so subsequent commands can pick them up:

```bash
export FIREFLY_SERVICES_CLIENT_ID=<client_id>
export FIREFLY_SERVICES_CLIENT_SECRET=<client_secret>
```

For long-lived shells, persist to a `.env.local` (gitignored) and load with `direnv` or a project-level loader. Do **not** commit `.env*` files. Standard `.gitignore` patterns must include `.env`, `.env.*`, and `*.secret`.

## Step 6 — Retrieve the first access token

The token round-trip is the canonical smoke test for credentials. If this works, the project is correctly provisioned.

```bash
curl --location 'https://ims-na1.adobelogin.com/ims/token/v3' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$FIREFLY_SERVICES_CLIENT_ID" \
  --data-urlencode "client_secret=$FIREFLY_SERVICES_CLIENT_SECRET" \
  --data-urlencode 'scope=openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis'
```

A successful response:

```json
{"access_token": "eyJhbGc...", "token_type": "bearer", "expires_in": 86399}
```

Tokens are valid for ~24 hours. Production code must refresh proactively before expiry — see `firefly-services-auth` for the refresh pattern.

Export the token:

```bash
export FIREFLY_SERVICES_ACCESS_TOKEN=<access_token>
```

If the curl call returns `invalid_client`, the `client_secret` is wrong. If it returns `unauthorized_client`, the workspace is not subscribed to the Firefly Services API (Step 3 was skipped or incomplete). If it returns a 200 but with an empty `access_token`, the scope list is wrong — the `firefly_api` and `ff_apis` scopes are both required even though they look redundant.

## Step 7 — Install the SDK and run the smoke-test call

For Node.js / TypeScript projects:

```bash
npm install @adobe/firefly-apis @adobe/firefly-services-common-apis
```

For Photoshop / Lightroom workflows add the relevant SDKs:

```bash
npm install @adobe/photoshop-apis @adobe/lightroom-apis
```

Adobe ships JavaScript SDKs only. There is no first-party Python SDK; Python projects call the REST endpoints with `requests` plus their own typed wrappers.

Smoke-test the credentials with a minimal generate-image call:

```bash
curl -X POST 'https://firefly-api.adobe.io/v3/images/generate' \
  -H "Authorization: Bearer $FIREFLY_SERVICES_ACCESS_TOKEN" \
  -H "X-Api-Key: $FIREFLY_SERVICES_CLIENT_ID" \
  -H 'Content-Type: application/json' \
  --data-raw '{"prompt":"a single red apple on a white background","numVariations":1,"size":{"width":1024,"height":1024}}'
```

A successful response includes a `result.outputs[0].image.url` field. Open the URL in a browser to confirm the actual image was generated. If you see a presigned URL but the image is blank, that is a transient backend issue — retry once before debugging.

If you get a 403 with `Forbidden` and no detail, the most likely cause is that the workspace is subscribed but the credentials have not yet propagated. Adobe IMS takes 1-5 minutes after credential issuance before they fully work end-to-end. Wait 5 minutes and retry before investigating further.

## Step 8 — Record the bootstrap in the customer's runbook

For FDE deliveries the bootstrap step is auditable. Record at minimum:

- IMS org ID + name
- Console project name + URL
- Workspace name
- Credential name + creation date + rotation cadence
- The smoke-test response (success / asset URL captured)
- Owner of the credentials on the customer side

The `fde-customer-onboarding` skill (FocusGTS internal) captures this into Catalyst automatically.

## Validate

A bootstrap is complete when **all** of these are true:

1. `aio console workspace api list --projectName <p> --workspaceName <w> --json` shows every required service code as `ACTIVE`
2. `curl … /ims/token/v3` returns a non-empty `access_token`
3. The generate-image smoke test returns HTTP 200 with a non-empty `result.outputs[0].image.url`
4. The actual generated image renders in a browser
5. Credentials are stored in the customer's secrets manager — not in any developer's `.env`

If any of these fails, stop and resolve before declaring the engagement live. A half-bootstrapped project is the #1 cause of week-2 escalations.

## Troubleshooting & Edge Cases

- **`aio` CLI not installed:** Run `npm install -g @adobe/aio-cli`. Do not install via Homebrew — the Adobe-maintained npm package is the only supported distribution.
- **Multiple IMS orgs and the wrong one is selected:** Every `aio console *` command accepts `--orgId <id>`. Pass it explicitly when uncertain rather than relying on the default selection.
- **`workspace api add` returns "product profile required":** The Firefly entitlement is profile-gated. Get the profile name from the customer's org admin and pass `--license-config FireflyAPI=<ProfileName>`.
- **Token returns 200 but `access_token` is empty:** Almost always a scope list issue. The required scopes are `openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis`. Yes both `firefly_api` and `ff_apis` — the naming is historical.
- **Smoke test returns 401 after a successful token call:** The token is valid but does not include the Firefly Services entitlement. Check that the project's IMS org and the credential's owning org match.
- **First API call returns 403 with no detail:** Wait 5 minutes. IMS credential propagation has a tail of up to ~5 minutes after issuance.
- **JWT credentials still in use:** Migrate immediately. JWT was end-of-life on June 30, 2025 and certificates expire by March 1, 2026. Mixed credential types are unsupported.

## Chaining with Other Skills

After bootstrap, hand off to:

- `firefly-services-auth` — Production token refresh patterns
- `firefly-services-rate-limits` — Configure rate limits and queueing
- `firefly-generate-image-v3-async` — First real workload
- `firefly-services-storage-refs` — Set up the asset storage layer

## References

- [Adobe IMS OAuth Server-to-Server credentials](https://developer.adobe.com/developer-console/docs/guides/services/services-add-api-oauth-s2s/)
- [Firefly API Authentication guide](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/get-started/)
- [`@adobe/firefly-apis` SDK](https://www.npmjs.com/package/@adobe/firefly-apis)
- [JWT EOL and migration notice](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/migration/)
