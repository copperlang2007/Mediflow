# agencyBRIDGE AI workspace: product design

_Written 2026-11-20. Status: proposed, waiting for the owner's review. Nothing
in the application or in any cloud account was changed to produce this._

## What the product is

A HIPAA-covered AI workspace for Medicare and insurance agencies. General HIPAA
chat tools already sell for about $20 to $47 per user per month with a BAA
included, so plain chat is not the offer. The offer is an assistant built for
this industry that does the work inside the agency's own systems, under one BAA.

Owner decisions this design works within (2026-11-19 and 2026-11-20):

- Open-weight models served through Amazon Bedrock, paid per use.
- PHI lives only in AWS services under the AWS BAA and in HIPAA-enabled Neon projects.
- Multi-tenant. INSUREitALL is the first tenant, outside agencies follow.
- Idle cost as close to zero as possible.
- Learning in three stages; pooled training on customer data stays blocked (section 4).
- Version 1 is finished when the first outside agency is paying.
- Target price $75 to $100 per user per month. Target date: first outside
  agency paying within 60 days (by 2027-01-19).
- No legal or compliance reviewer is engaged yet.

## 1. Current state

Verified on 2026-11-20 by reading both repositories at their latest commit and
listing the Neon organization. **AWS was not inspected: this session had no AWS
credentials.**

| Item | What is true | How it was checked |
| --- | --- | --- |
| agencyBRIDGE production | Runs on Google Cloud Run + Cloud SQL. `docs/STATE.md` says real PHI is **not allowed yet**. | `docs/STATE.md`, main at `8e26ea6` (2026-11-09) |
| Move to AWS + Neon | **Not started.** No `docs/GO_LIVE_LEDGER.md`, no AWS deploy script, no ADR. `AGENTS.md` still lists Google Cloud as decided direction. | Repo contents |
| Sign-in | Clerk to Google Identity Platform switch is merged but waits on owner setup. MFA is mandatory. | `docs/STATE.md` |
| AI in agencyBRIDGE | Claude on Bedrock through the Anthropic Messages API only (ADR 0005). Four call sites. A boot guard refuses non-BAA providers in production. | `lib/aiProvider.ts`, ADR 0005 |
| Feature builder | A developer-only "AI Feature Builder" already exists: it plans a change, writes files, typechecks and opens a draft PR. | `routes/dev/feature-builder.ts` |
| Call scoring | **Two implementations.** agencyBRIDGE has its own (transcripts, recordings, do-not-contact queue). myCALL is a separate app with a richer engine (phrase rules, AI reviewer, human review, calibration, live coaching). | `docs/call-scoring.md`, myCALL `README.md` |
| myCALL | One shared access token, no user accounts. SQLite on local disk. Audio goes to Deepgram, transcripts to the direct Anthropic API (default model `claude-opus-5-5`). Only a Google Cloud deploy script. Main at `c7a2f0b` (2026-11-11). | myCALL `README.md`, `package.json` |
| Billing | Stripe is built. Pricing is **per agency**: Starter free, Growth $297/month, Agency $997/month. | ADR 0001 |
| Neon | HIPAA-enabled projects exist: `agencybridge` (us-west-2), `mediflow-canonical`, `iia-workspace`, `iia-retention` (us-east-2). The two `iia-*` projects were created 2026-11-19. All report zero stored data. | Neon project list |
| Known PHI gap | Contact reads that decrypt PHI are not audit-logged. | `docs/STATE.md` |

**What this means.** The product sits on top of a move to AWS and Neon that has
not begun. That move, and the PHI gates in the go-live plan, are the first
phase of the build plan and the largest schedule risk.

## 2. Architecture

Simplest design that meets the rules: keep agencyBRIDGE as the workspace, and
make everything else a module inside it.

```
 Browser ── agencyBRIDGE web app (the workspace shell)
              ├─ Assistant panel (chat, documents, agent)
              ├─ CRM, onboarding, commissions, compliance (existing)
              └─ Call review (myCALL engine, mounted as a module)
                        │
              agencyBRIDGE API (AWS, scale-to-zero containers)
              ├─ Auth: one login, mandatory MFA
              ├─ Model gateway ── Amazon Bedrock (open-weight models)
              ├─ Agent tool layer ── existing API routes, as the signed-in user
              ├─ Retrieval ── Neon (pgvector), filtered by tenant
              ├─ Audit log ── every PHI read, every agent action
              └─ Jobs ── Amazon Transcribe (batch), call grading, imports
                        │
              Neon Postgres (HIPAA project) + S3 (documents, recordings)
```

- **Workspace shell.** The agencyBRIDGE web app. No new front end.
- **myCALL inside it.** myCALL keeps its own repository and engine but moves to
  Neon and S3, drops the shared token, and accepts the same sign-in session.
  It appears as "Call review" in the sidebar. Its Chrome extension keeps
  working against the same server.
- **One call-scoring engine.** Two engines grading the same calls will disagree.
  Recommendation: myCALL's engine becomes the only grader; agencyBRIDGE's
  call-scoring screens read myCALL results. agencyBRIDGE's do-not-contact queue
  is kept. This needs the owner's decision (assumption A3).
- **Single sign-on with MFA.** One identity system for both apps, hosted under
  the AWS BAA. Which one is decided in the go-live work, not here.
- **Tenant isolation.** Every query, file path and retrieval call carries the
  caller's organization id. The existing static guard stays. Add Postgres
  row-level security before a second agency is onboarded, so one missed filter
  cannot leak across agencies. Each cross-tenant path gets a test that tries to
  cross and must fail.
- **Agent tool layer.** The agent never touches the database. Each tool is a
  thin wrapper over an existing API route and runs with the signed-in user's
  permissions, so the agent can do nothing the user could not do by hand.
  Read tools run freely. Write tools show the user what will change and wait
  for a click. Bulk or irreversible actions are not offered as tools in v1.
- **Audit.** One append-only record per PHI read and per agent action: who,
  which tenant, which tool, which record, when. This also closes the existing
  contact-read gap.
- **Documents and retrieval.** Files in S3 under a per-tenant prefix, encrypted.
  Text chunks and embeddings in Neon with pgvector, each row tagged with the
  tenant. No separate vector database: one less vendor and one less bill.
- **PHI and prompts.** The existing rule in `AGENTS.md` section 5 stands: no
  Medicare ID, SSN, date of birth, diagnosis or recording content in an AI
  prompt, log or error report, and those fields are removed structurally
  before a prompt is built (pick the safe fields; never interpolate a record).
  The assistant and agent tools are designed to that rule: tools return masked
  records to the model, and the user sees the full record in the app, not in
  the model's context.
- **Where the product collides with that rule.** Call review sends call
  transcripts, which are recording content, to a model. myCALL removes
  Medicare IDs, SSNs, phone numbers, card numbers, emails and dates first, but
  spoken health details remain. The code comment in `lib/aiProvider.ts` also
  says today's AI features send contact Medicare profiles in the system
  prompt. This design does not relax the rule. Either call grading runs on
  redacted transcripts that meet it, or the owner changes the rule by ADR
  with a compliance advisor (assumption A6). No workspace feature ships on
  real data until that is settled.

## 3. Model plan

**Not done in this run:** the open-weight catalog was not listed live from the
owner's AWS account and no evaluations were run, because this session had no
AWS credentials. Prices below are from public listings checked 2026-11-20 and
must be re-read from the AWS console in Phase 1.

Candidate open-weight models on Bedrock (US regions, price per million tokens,
input / output):

| Model | Price | Candidate for |
| --- | --- | --- |
| OpenAI gpt-oss-20b | $0.07 / $0.30 | Routing, short extraction, PHI redaction pass |
| OpenAI gpt-oss-120b | $0.15 / $0.60 | Default chat, agent tool use, call grading |
| Meta Llama 4 Scout 17B | $0.17 / $0.66 | Alternative default, long documents |
| Qwen3 235B | $0.22 / $0.88 | Harder reasoning |
| Qwen3 Coder Next | $0.50 / $1.20 | Internal coding agent |
| DeepSeek v3.2 | $0.62 / $1.85 | Fallback for tasks the cheaper models fail |

Two things to confirm before any PHI reaches one of these:

1. **HIPAA eligibility is per model.** Amazon Bedrock is on AWS's HIPAA
   Eligible Services list (last updated 2026-10-15), but that list carries
   exclusions and secondary sources say not every third-party model is
   covered. Read the Bedrock line on AWS's page and confirm each chosen model
   in writing with AWS. Until then, open models see synthetic data only.
2. **A new adapter is required.** Today's code speaks only the Anthropic
   Messages API (ADR 0005). Open models on Bedrock use a different interface.
   The model gateway hides that difference behind one internal call. See ADR 0008.

**Evaluation set (to build in Phase 1, synthetic data only).** About 40 cases
per job, each with a pass/fail check that a script can run:

| Job | What a pass looks like |
| --- | --- |
| Agency questions (chat) | Answer matches a reference; no invented CMS rule |
| Document extraction | Fields match exactly on carrier statements and applications |
| Agent tool use | Right tool, right arguments, stops for confirmation on writes |
| Call grading | Agrees with myCALL's existing scoring tests and its human-reviewed calls; every finding cites real transcript text |
| Code changes | Feature-builder plans that typecheck and pass tests |

A model is chosen per job on quality first, then cost. **Call grading:** myCALL
grades with Claude today. If no open model passes its scoring tests, the design
does not silently keep Claude: the result and the cost difference come back to
the owner to decide.

**Own GPU servers.** At gpt-oss-120b prices a typical user's month costs about
$0.21 per million tokens blended. A single always-on GPU server at roughly
$730 a month (estimate, not checked against AWS) only breaks even near 3.5
billion tokens a month, about 300 typical users. Do not revisit before then.

## 4. Improvement pipeline

| Stage | What learns | What is stored | Release rule |
| --- | --- | --- | --- |
| 1. Per-tenant memory | Each agency's documents, preferences, corrections | In that tenant's rows only | Live from v1 |
| 2. Product-wide tuning | Prompts, tool definitions, model routing | Evaluation results; no customer content | Ships only if it beats the current version on the evaluation set; previous version kept for one-click rollback |
| 3. Pooled fine-tuning | A shared model trained on de-identified data from all tenants | **Blocked** | See below |

Stage 2 is what "constantly improving" means in v1. Every thumbs-down and every
human override of a call grade becomes a candidate evaluation case after a
person rewrites it with synthetic details. The evaluation set grows; customer
content never leaves its tenant.

Stage 3 stays blocked until all three exist (ADR 0009):

1. A de-identification method that meets HIPAA (Safe Harbor or expert
   determination), tested on call transcripts, which are hard to scrub.
2. Customer BAA wording that permits it.
3. Written sign-off from a HIPAA attorney. **None is engaged yet; hiring one is
   an owner task.**

## 5. Feature development

- **Internal first.** The existing developer-only feature builder already
  produces draft PRs for human review. Point it at the model gateway (Qwen3
  Coder Next as first candidate), keep it developer-only, keep "a person
  merges" as the rule. Its context bundle reads source files only, never data.
- **Customer-facing builder: after v1.** Before an agency can build inside its
  own tenant, these must be true: generated tools run in a sandbox with no
  network and no cross-tenant access; they can only call the same permissioned
  tool layer as the agent; each has a human approval step at the agency; and
  there is a kill switch per tenant. Start with configuration (custom fields,
  checklists, report templates) before any generated code.

## 6. Commercial layer

- **Pricing.** Move from per-agency tiers to per-user pricing, or add a
  per-user AI workspace plan beside the existing tiers. Stripe and the
  entitlement code are already in place (ADR 0001); this is a catalog change
  plus seat counting.
- **Onboarding a new agency.** Sign the customer BAA, create the organization,
  invite users (MFA on first sign-in), import contacts and agents with a
  reconciled count, connect call recordings, 30-minute walkthrough.
- **Customer BAA.** The owner becomes a business associate to each agency and
  AWS and Neon become subcontractors. That requires a customer BAA template,
  a named security contact, a breach-notification procedure, a risk
  assessment on file and workforce training records. An attorney should draft
  the template. This is an owner task and it gates the first outside sale.
- **Medicare-specific duties.** CMS requires agencies to retain marketing and
  enrollment call recordings for years. Retention settings must be per tenant
  and deletion must be deliberate. Confirm the current period with the attorney.
- **Support.** A shared inbox and a status page are enough for the first
  three customers.

## 7. Unit economics

Cost to serve one user for one month. The usage figures are assumptions, not
measurements; replace them with INSUREitALL's real numbers after two weeks of use.

| | Light | Typical | Heavy |
| --- | --- | --- | --- |
| Assistant tokens (in / out) | 2M / 0.3M | 10M / 1.5M | 40M / 6M |
| Call minutes reviewed | 500 | 2,000 | 5,000 |
| Assistant, gpt-oss-120b | $0.48 | $2.40 | $9.60 |
| Transcription, batch at $0.006/min | $3.00 | $12.00 | $30.00 |
| Call grading, gpt-oss-120b | $0.17 | $0.69 | $1.72 |
| **Total** | **$3.65** | **$15.09** | **$41.33** |
| Total if the assistant needs DeepSeek v3.2 | $4.97 | $21.67 | $67.62 |

Against a price of $75 to $100 per user:

- Typical use leaves roughly 70 to 85 percent of the price after model costs.
- Heavy use on the cheaper model still fits. Heavy use on the dearer model
  ($67.62) does not fit a $75 price. Set a fair-use limit on reviewed call
  minutes (for example 3,000 per user, then a per-minute charge) or price call
  review as an add-on.
- **Transcription, not the AI model, is the largest cost.** Two sources quote
  $0.024 per minute instead of AWS's own $0.006. At $0.024 a heavy user's
  transcription alone is $120. Read the exact rate for the chosen region on the
  AWS pricing page before setting the price.
- Fixed platform cost (containers, Neon, S3, logs) is not in the table. It
  should be small with scale-to-zero, and must be measured during go-live.

## 8. Risks, ranked

| # | Risk | Control |
| --- | --- | --- |
| 1 | The AWS + Neon move and PHI gates have not started; 60 days assumes they finish in the first three weeks | Phase 0 comes first; weekly check against the plan; cut scope (section 9) before cutting gates |
| 2 | Selling under a BAA with no attorney, no customer BAA template and no documented risk assessment | Engage a HIPAA attorney in week 1; no outside PHI until the template and risk assessment exist |
| 3 | A chosen open model turns out not to be HIPAA-eligible on Bedrock, or fails the evaluations | Confirm eligibility in writing in Phase 1; gateway makes models swappable; owner decides on any fallback |
| 4 | Data crossing between agencies | Tenant filter on every path, row-level security before tenant two, cross-tenant tests in CI |
| 5 | The agent takes a wrong action on real records | Tools act with the user's permissions, writes need a click, no bulk tools in v1, full audit |
| 6 | Call review cost exceeds the price for heavy users | Fair-use limit or add-on pricing; batch transcription only |
| 7 | Two call-scoring engines give different grades | Consolidate on one engine (assumption A3) |
| 8 | Call review needs recording content in prompts, which `AGENTS.md` forbids | Decide A6 by ADR before Phase 4; redaction pass and synthetic data until then |
| 9 | Parallel agent sessions collide in this repo | `AGENTS.md` rules: state ledger, migration numbering, PR checks |

## Assumptions to confirm

- **A1.** The go-live plan (AWS + Neon, Transcribe, per-user sign-in for myCALL)
  runs first and this design builds on its result.
- **A2.** Price is per user per month, replacing or sitting beside the current
  per-agency tiers.
- **A3.** myCALL's engine becomes the only call grader.
- **A4.** The customer-facing builder and pooled training are after v1.
- **A6.** Whether transcripts (recording content) may be sent to a
  BAA-covered model for call grading. `AGENTS.md` forbids it today; changing
  that needs an ADR and a compliance advisor. Until decided, grading uses
  redacted transcripts or synthetic data only.
- **A5.** us-east-2 is the home region (the newest HIPAA Neon projects are there).
