# Mediflow Demo Video Evidence — Quick Start

Capture audit-grade demo videos for each Mediflow role (agent, supervisor, admin, compliance, commission, licensing, CRM, executive). Full-session videos with per-step screenshots, Playwright traces, and signed evidence manifests.

## 1. Validate Setup (30 sec)

```bash
bash scripts/validate_evidence_setup.sh
```

## 2. Configure Environment

```bash
cp .env.evidence.example .env.evidence
# Edit with your target URL + test accounts.
# Targeting the auth-bypassed DEMO_MODE deploy (render.yaml)? Set
# EVIDENCE_ASSUME_SIGNED_IN=1 — it has no login form, so login steps
# are skipped and recorded as such.
nano .env.evidence
source .env.evidence
```

## 3. Run Demos

**Single journey (5 min):**
```bash
./scripts/capture_demo_videos.sh journeys/01-agent-enrollment-aep.journey.ts
```

**All 8 roles (serial, ~45 min):**
```bash
./scripts/capture_demo_videos.sh
```

**With browser visible (debugging):**
```bash
EVIDENCE_HEADED=1 ./scripts/capture_demo_videos.sh journeys/01-agent-enrollment-aep.journey.ts
```

## 4. Review Output

```
evidence/01-agent-enrollment-aep-<timestamp>/
├── journey.webm          (full video)
├── evidence.json         (manifest)
├── trace.zip            (debugging)
└── steps/               (per-step screenshots)
```

## Journeys

| # | Role | Workflow |
|---|------|----------|
| 1 | Agent | CRM search → AEP enrollment → documentation |
| 2 | Supervisor | Queue wallboard → agent monitoring → metrics |
| 3 | Compliance Admin | Licensing verification → audit → export |
| 4 | Commission Specialist | Commission review → reconciliation → export |
| 5 | Licensing Manager | Agent licenses → verify → flag renewals |
| 6 | CRM Specialist | Member search → enrollment history → updates |
| 7 | FMO Executive | Dashboard → KPIs → enrollment trends |
| 8 | Renewals Specialist | Renewal queue → outreach → document outcome |

## Troubleshooting

See `journeys/README.md` for full details, or copy from IntelBRIDGE (same system).

---

**Status:** Ready. Set `.env.evidence` and run.
