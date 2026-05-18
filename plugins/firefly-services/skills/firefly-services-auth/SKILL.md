---
name: firefly-services-auth
description: Production-grade OAuth Server-to-Server authentication for Adobe Firefly Services — token retrieval, refresh-before-expiry, scope selection, multi-tenant credential isolation, and the JWT-to-OAuth migration path. Use whenever the user needs to obtain or refresh a Firefly Services access token, mentions "token expired", "401 Unauthorized", "auth", "IMS", "scopes", "client credentials", "S2S", "Server-to-Server", "JWT migration", or wires authentication into a service that calls `firefly-api.adobe.io`, `pscx.adobe.io`, or `lr.adobe.io`. Also handles JWT deprecation — JWT reached end-of-life June 30, 2025 and all certificates expire by March 1, 2026; this skill covers the migration path. Do NOT use for first-time project setup; use `firefly-services-bootstrap` instead.
license: Apache-2.0
compatibility: Requires OAuth Server-to-Server credentials issued via Adobe Developer Console. Node 18+ for the SDK path. `curl` 7.x+ for the bash path. Network access to `ims-na1.adobelogin.com`.
allowed-tools: Bash(curl:*) Bash(node:*) Bash(npm:*) Read Write Edit
metadata:
  version: "1.0.0"
  category: authentication
---

# Firefly Services Authentication

Obtains and refreshes IMS access tokens for Firefly Services using OAuth Server-to-Server credentials. Covers the token round-trip, the refresh-before-expiry pattern, scope selection per API surface, and the migration path off deprecated JWT credentials.

If credentials do not exist yet, run `firefly-services-bootstrap` first. If a 401/403 is being thrown despite a valid-looking token, use `firefly-services-troubleshoot`.

## When to Use This Skill

Use this skill when:
- A Firefly Services API call needs an `Authorization: Bearer <token>` header
- A long-running service needs to refresh tokens before they expire (~24h validity)
- The user is migrating from deprecated JWT credentials to OAuth Server-to-Server
- A new endpoint needs different scopes added to the token request
- Auth is being wired into a backend service (Node, Python, Go) calling Firefly APIs

Do **NOT** use this skill when:
- A valid `FIREFLY_SERVICES_ACCESS_TOKEN` is already in scope and not near expiry — reuse it
- The user is doing end-user delegated auth (Firefly Services is server-to-server only; there is no user-delegated path)
- Credentials do not yet exist — run `firefly-services-bootstrap` first

## Critical: JWT is Dead

Service Account (JWT) credentials reached **end-of-life on June 30, 2025**. They continue to function only until their issuing certificate expires. The final expiry deadline is **March 1, 2026**. After that date, every JWT-based integration breaks.

If you see code like this anywhere, it must be migrated:

```js
// DEAD CODE — JWT path (do not use)
const jwt = require('jsonwebtoken');
const token = jwt.sign({...}, privateKey, {algorithm: 'RS256'});
```

The migration is a one-time rebuild — you cannot incrementally upgrade JWT to OAuth. See **JWT → OAuth Migration** below.

## Prerequisites

| Requirement | How to verify |
|---|---|
| OAuth S2S credentials provisioned | `$FIREFLY_SERVICES_CLIENT_ID` and `$FIREFLY_SERVICES_CLIENT_SECRET` exist as env vars |
| Workspace subscribed to the right API | Token must include the relevant Firefly scope (see scope table below) |
| Network access to IMS | `curl -I https://ims-na1.adobelogin.com/ims/token/v3` returns 405 (POST-only) |

## Scope Selection — Pick Only What You Need

The scope string in the token request controls what the token can access. Over-scoping is a security smell — request only the scopes the calling service actually needs.

| Scope | Required for |
|---|---|
| `openid` | Always required for OAuth |
| `AdobeID` | Always required |
| `session` | Always required |
| `additional_info` | Always required |
| `read_organizations` | Always required for server-to-server |
| `firefly_api` | Firefly v1 / legacy endpoints |
| `ff_apis` | Firefly v2 / v3 endpoints (most current workloads) |
| `firefly_enterprise` | Custom Models API |
| `creative_sdk` | Photoshop API, Lightroom API |
| `AdobeID,additional_info.projectedProductContext` | Some product-profile-gated services |

**Always request both `firefly_api` and `ff_apis`** when uncertain. The naming is historical and the cost of including both is zero. Include `firefly_enterprise` only for projects using Custom Models. Include `creative_sdk` for Photoshop/Lightroom workloads.

The canonical scope string for an FDE engagement that uses Firefly + Photoshop + custom models:

```
openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis,firefly_enterprise,creative_sdk
```

## Step 1 — Retrieve an Access Token (Bash)

The IMS token endpoint accepts `application/x-www-form-urlencoded`. Tokens are valid for ~24 hours (`expires_in: 86399` seconds).

```bash
curl --silent --location 'https://ims-na1.adobelogin.com/ims/token/v3' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$FIREFLY_SERVICES_CLIENT_ID" \
  --data-urlencode "client_secret=$FIREFLY_SERVICES_CLIENT_SECRET" \
  --data-urlencode 'scope=openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis'
```

Successful response:

```json
{"access_token": "eyJhbGc...", "token_type": "bearer", "expires_in": 86399}
```

Capture the token and `expires_in` together — the refresh-before-expiry pattern depends on knowing absolute expiry time.

## Step 2 — Retrieve an Access Token (Node.js with SDK)

```js
import { ServerToServerTokenProvider } from '@adobe/firefly-services-common-apis';

const tokenProvider = new ServerToServerTokenProvider({
  clientId: process.env.FIREFLY_SERVICES_CLIENT_ID,
  clientSecret: process.env.FIREFLY_SERVICES_CLIENT_SECRET,
  scopes: [
    'openid',
    'AdobeID',
    'session',
    'additional_info',
    'read_organizations',
    'firefly_api',
    'ff_apis',
  ],
});

const accessToken = await tokenProvider.getAccessToken();
```

`ServerToServerTokenProvider` caches the token in memory and refreshes automatically when the cached token is within a safety buffer of expiry. This is the production pattern — do not reimplement.

## Step 3 — Refresh Before Expiry (Production Pattern)

Tokens are valid for ~24 hours. A production service must refresh proactively, not reactively. Reactive refresh (on 401) means in-flight requests fail at the boundary.

Pattern:

```js
class FireflyTokenCache {
  constructor({ clientId, clientSecret, scopes, safetyBufferSec = 300 }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scopes = scopes.join(',');
    this.safetyBuffer = safetyBufferSec * 1000;
    this.token = null;
    this.expiresAt = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.expiresAt - this.safetyBuffer) {
      return this.token;
    }
    await this.refresh();
    return this.token;
  }

  async refresh() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scopes,
    });
    const res = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`IMS token refresh failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    this.token = json.access_token;
    this.expiresAt = Date.now() + json.expires_in * 1000;
  }
}
```

Set `safetyBufferSec` to 5 minutes (300s) at minimum. For high-throughput services, use 15 minutes — the latency of a refresh under load is non-trivial and you do not want it on the request path.

## Step 4 — Multi-Tenant Credential Isolation

When a single service calls Firefly Services on behalf of multiple customers, do **not** share a single set of credentials. Each customer engagement should have its own OAuth S2S credential pair, scoped to that customer's IMS org.

Why: a leaked or rotated credential should not affect other customers. Logs, rate limits, and audit trails are also per-credential — sharing credentials destroys attribution.

Pattern:

```js
const tokenCaches = new Map();  // customerId → FireflyTokenCache

function getTokenCache(customerId) {
  if (!tokenCaches.has(customerId)) {
    const creds = loadCredsForCustomer(customerId); // from your secrets manager
    tokenCaches.set(customerId, new FireflyTokenCache(creds));
  }
  return tokenCaches.get(customerId);
}
```

In multi-tenant FDE deployments (multiple enterprise customers all served by the same service), this pattern is mandatory.

## JWT → OAuth Migration

If a project still uses JWT credentials, migrate before March 1, 2026 or the project breaks.

### Step A — Provision OAuth S2S credentials in the same workspace

```bash
aio console workspace credentials create \
  --projectName <existing-project> \
  --workspaceName <existing-workspace> \
  --type oauth_server_to_server \
  --name <name>-oauth \
  --json
```

You can hold both JWT and OAuth credentials in the same workspace temporarily during cutover.

### Step B — Replace JWT-signing code with OAuth client-credentials

Every place that signs a JWT and exchanges it at IMS is replaced with a single client-credentials request as shown in Step 1. The Node SDK does this for you (`ServerToServerTokenProvider`).

### Step C — Cut traffic over and decommission JWT

After the OAuth path is verified in production, revoke the JWT credentials in Developer Console. Do not leave them active — abandoned credentials are an audit liability.

## Troubleshooting & Edge Cases

- **`invalid_client`:** Wrong `client_secret`. Re-export `$FIREFLY_SERVICES_CLIENT_SECRET` from the secrets manager.
- **`unauthorized_client`:** The workspace owning these credentials is not subscribed to the API surface the scope is requesting. Re-run `aio console workspace api add` for the missing service.
- **200 OK but empty `access_token`:** Scope string is malformed or includes a scope the credential is not entitled to. Strip the scope list down to the required core set (`openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis`) and reintroduce one scope at a time.
- **Token valid but Firefly API returns 401:** The token is real but does not include `firefly_api` or `ff_apis` scope. Re-issue with the correct scope set.
- **Token valid but Firefly API returns 403:** The token has the scope but the IMS org does not have the entitlement. Customer needs Adobe to provision Firefly Services for that org.
- **Token works locally but fails in production:** Different `client_id`/`client_secret`. Multi-environment deployments need per-environment credentials — never share a credential between Stage and Prod.
- **Token works but in-flight requests sporadically 401:** Refresh-on-expiry race. Increase the safety buffer (5 → 15 minutes) and make the refresh function idempotent (only one refresh in-flight per cache instance at a time).
- **JWT certificate expired:** The project is dead until rebuilt on OAuth. There is no path to renew the JWT certificate.

## Validate

Auth is correctly configured when:

1. `curl` against `/ims/token/v3` returns a non-empty `access_token` and `expires_in: 86399`
2. The token can be used to call at least one Firefly endpoint without 401
3. The refresh-before-expiry pattern is in place — no service depends on reactive 401-and-retry
4. Credentials are loaded from a secrets manager, not from `.env` files in source control
5. Multi-tenant services have per-customer credentials

## Chaining with Other Skills

- `firefly-services-troubleshoot` — Decode auth errors deeper than this skill covers
- `firefly-generate-image-v3-async` — First workload after auth is wired
- `firefly-services-rate-limits` — Token-aware retry and backoff

## References

- [Firefly API Authentication](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/get-started/)
- [IMS OAuth Server-to-Server overview](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/)
- [JWT EOL migration guide](https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/migration/)
- [`@adobe/firefly-services-common-apis` SDK](https://www.npmjs.com/package/@adobe/firefly-services-common-apis)
