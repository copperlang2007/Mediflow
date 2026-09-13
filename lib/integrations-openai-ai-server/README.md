# @workspace/integrations-openai-ai-server

Server-side AI client for the Mediflow platform. Supports two providers:

- **OpenAI direct** (`api.openai.com`) — convenient for dev/staging.
- **Azure OpenAI** — the HIPAA-eligible production path.

OpenAI's direct `api.openai.com` endpoint is **not** in their default BAA
scope, so any environment that touches PHI (i.e. production) must point
at Azure OpenAI, which is HIPAA-eligible out of the box. Dev and staging
can keep using OpenAI direct.

## Provider switch

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AI_INTEGRATIONS_PROVIDER` | no | `openai` | `openai` or `azure`. Set to `azure` in prod. |
| `AI_INTEGRATIONS_BEDROCK_API_KEY` | yes | — | API key for whichever provider is selected. |

### OpenAI direct (`AI_INTEGRATIONS_PROVIDER=openai`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | yes | — | e.g. `https://api.openai.com/v1`. |

### Azure OpenAI (`AI_INTEGRATIONS_PROVIDER=azure`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AI_INTEGRATIONS_AZURE_RESOURCE` | yes\* | — | Resource name; URL becomes `https://<resource>.openai.azure.com`. Alternative: set `AI_INTEGRATIONS_OPENAI_BASE_URL` directly. |
| `AI_INTEGRATIONS_AZURE_API_VERSION` | no | `2024-02-15-preview` | Azure REST API version. |
| `AI_INTEGRATIONS_AZURE_DEPLOYMENT` | no | falls back to `FEATURE_BUILDER_MODEL` for the Feature Builder | Azure deployment name. Note: when set on the client, the `model` field sent in the request body is ignored by Azure — the deployment in the URL determines the model. |

\* Either `AI_INTEGRATIONS_AZURE_RESOURCE` or `AI_INTEGRATIONS_OPENAI_BASE_URL`
must be provided when `AI_INTEGRATIONS_PROVIDER=azure`.

## How it works

The exported `openai` client is constructed from the official `openai`
npm SDK. For Azure we use the SDK's built-in `AzureOpenAI` class, which
handles the differences from OpenAI direct transparently:

- `api-key` header instead of `Authorization: Bearer ...`
- `?api-version=...` query string on every request
- Deployment-name-in-URL (`/openai/deployments/<name>/chat/completions`)

Callers keep using the same `client.chat.completions.create(...)` API
regardless of provider.
