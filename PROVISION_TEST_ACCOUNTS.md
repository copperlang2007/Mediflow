# Provisioning Test Accounts for Demo Video Capture

This guide walks you through creating the 16 test accounts needed to capture demo videos for IntelBRIDGE and Mediflow.

> **Important — which IdP does each product use?**
> - **IntelBRIDGE** authenticates via **AWS Cognito** — the script below applies.
> - **Mediflow** authenticates via **Clerk**, not Cognito. Create Mediflow test
>   accounts in the Clerk Dashboard (Users -> Create user) or via the Clerk
>   Backend API, using the same emails listed below and the password you choose.
>   The Cognito script sections apply to IntelBRIDGE pools only.

## Prerequisites

- **AWS Account** with access to Cognito
- **AWS CLI** installed and configured with credentials
- **User Pool IDs** for both preview apps (find in AWS Console → Cognito → User Pools)

## Quick Start

### 1. Get Your Cognito User Pool IDs

Log in to **AWS Console** → **Cognito** → **User Pools**

Find the user pools for your preview deployments:
- **Mediflow preview**: Copy the User Pool ID
- **IntelBRIDGE preview**: Copy the User Pool ID

### 2. Run the Provisioning Script

From the repo root:

```bash
# For Mediflow
# Mediflow uses Clerk — see the note above; this script is for IntelBRIDGE

# For IntelBRIDGE
./scripts/provision-test-accounts.sh <INTELBRIDGE_USER_POOL_ID> 'YourStrongPassword123!'
```

**Example:**
```bash
./scripts/provision-test-accounts.sh us-east-1_abc123def456 'YourStrongPassword123!'
```

### 3. Verify in AWS Console

Go to **Cognito** → **User Pools** → **Users and groups**

You should see 8 new users:
- `agent.demo@{product}.local`
- `supervisor.demo@{product}.local` / `lead.demo@{product}.local`
- `compliance.demo@{product}.local`
- ... etc (one per role)

### 4. Assign Roles/Groups (If Required)

If your app uses Cognito groups for RBAC:

1. Go to **Cognito** → **User Pools** → **Groups**
2. For each role (Agent, Supervisor, Compliance, etc.):
   - Create a group if it doesn't exist
   - Click the group
   - **Add users to group** → select the corresponding demo user

If your app uses custom attributes or role assignment logic, configure that now.

### 5. Run Demo Video Capture

```bash
cd Mediflow
source .env.evidence
./scripts/capture_demo_videos.sh

# or single journey
./scripts/capture_demo_videos.sh journeys/01-agent-enrollment-aep.journey.ts
```

Videos will be saved to `./evidence/{journey}-{timestamp}/`

---

## Test Account Details

### Mediflow (8 roles)

| Email | Role | Purpose |
|-------|------|---------|
| `agent.demo@mediflow.local` | Agent | CRM search → AEP enrollment |
| `supervisor.demo@mediflow.local` | Supervisor | Queue wallboard → call metrics |
| `compliance.demo@mediflow.local` | Compliance Admin | Licensing verification → audit |
| `commission.demo@mediflow.local` | Commission Specialist | Statement reconciliation |
| `licensing.demo@mediflow.local` | Licensing Manager | Agent license tracking |
| `crm.demo@mediflow.local` | CRM Specialist | Lead management |
| `executive.demo@mediflow.local` | FMO Executive | Dashboard KPIs |
| `renewals.demo@mediflow.local` | Renewals Specialist | Renewal campaigns |

### IntelBRIDGE (8 roles)

| Email | Role | Purpose |
|-------|------|---------|
| `agent.demo@intelbridge.local` | Agent | Lead intake → enrollment via dialer |
| `lead.demo@intelbridge.local` | Team Lead | Team board → call monitoring |
| `manager.demo@intelbridge.local` | Sales Manager | PE metrics → member drill-down |
| `director.demo@intelbridge.local` | Sales Director | Cross-manager analytics |
| `retention.demo@intelbridge.local` | Retention Specialist | Member outreach → disposition |
| `compliance.demo@intelbridge.local` | Compliance Manager | Audit log → gate enforcement |
| `owner.demo@intelbridge.local` | Agency Owner | Team provisioning → roles |
| `viewer.demo@intelbridge.local` | Viewer | Read-only dashboard |

**All passwords:** the `ACCOUNT_PASSWORD` you pass to the script — update `TEST_*_PASSWORD` in `.env.evidence` to match

---

## Troubleshooting

### "User already exists"
The script will skip existing users and update their passwords. Safe to re-run.

### "Invalid User Pool ID"
Check that:
- User Pool ID is correct (from AWS Console)
- AWS region matches (default: `us-east-1`, override with `AWS_REGION=us-west-2`)
- Your AWS credentials have `cognito-idp` permissions

### "UnauthorizedOperation"
Your AWS credentials need these IAM permissions:
```json
{
  "Effect": "Allow",
  "Action": [
    "cognito-idp:AdminCreateUser",
    "cognito-idp:AdminSetUserPassword",
    "cognito-idp:AdminAddUserToGroup"
  ],
  "Resource": "arn:aws:cognito-idp:*:*:userpool/*"
}
```

### Login fails in app
After running the script, check:
1. ✅ User exists in Cognito (AWS Console)
2. ✅ User is in correct group/role (if app requires it)
3. ✅ `.env.evidence` has correct email + password
4. ✅ App preview instance is running and reachable

---

## Manual Account Creation (Alternative)

If you prefer to create accounts manually in AWS Console:

1. Go to **Cognito** → **User Pools** → **Users and groups**
2. Click **Create user**
3. For each role, create:
   - Email: `{role}.demo@{product}.local`
   - Password: your chosen account password (mark as **Permanent**)
   - Email verified: ✅ (check the box)
4. Assign to appropriate group/role

---

## What Happens Next

Once accounts are provisioned and the app is configured:

1. **Video capture runs automatically:**
   ```bash
   ./scripts/capture_demo_videos.sh
   ```

2. **Evidence is generated:**
   - `./evidence/{journey}-{timestamp}/journey.webm` — full 1280×720@30fps video
   - `./evidence/{journey}-{timestamp}/evidence.json` — SHA256-verified manifest
   - `./evidence/{journey}-{timestamp}/steps/` — per-step screenshots
   - `./evidence/{journey}-{timestamp}/trace.zip` — Playwright debug trace

3. **Landing page gets videos:**
   - Copy videos to web server or CDN
   - Update `demo-landing.html` video container `src` attributes
   - Share landing page as proof-of-concept for investors/partners

---

## Support

For issues provisioning accounts, check:
- AWS IAM permissions (see Troubleshooting)
- User Pool ID (verify in AWS Console)
- AWS region (must match preview app region)

For demo video capture issues, see `Mediflow/DEMO_VIDEO_QUICKSTART.md` or `IntelBRIDGE/journeys/README.md`.
