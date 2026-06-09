# CMS Blue Button 2.0 API Integration

This document describes the Blue Button 2.0 API integration for the benefitGUARDIAN application.

## Overview

The CMS Blue Button 2.0 API enables Medicare beneficiaries to connect their claims data to our application. It uses OAuth 2.0 for authorization and HL7 FHIR for data exchange.

## Registered Application

| Field | Value |
|---|---|
| **App Name** | benefitGUARDIAN |
| **App ID** | 4395 |
| **Environment** | Sandbox |
| **Registered** | 2026-06-09 |
| **Client Type** | Confidential |
| **Grant Type** | Authorization Code |
| **Redirect URI** | `https://guardian.myhealthapps.com/auth/callback` |
| **Demographic Data** | Yes (name, DOB, race, sex) |

## API Endpoints (Sandbox)

| Endpoint | Description |
|---|---|
| `https://sandbox.bluebutton.cms.gov/v2/fhir/Patient/` | Patient demographics |
| `https://sandbox.bluebutton.cms.gov/v2/fhir/Coverage/` | Coverage information |
| `https://sandbox.bluebutton.cms.gov/v2/fhir/ExplanationOfBenefit/` | Claims data |

## OAuth 2.0 Flow

1. User clicks "Connect Medicare Data" in the app
2. Redirect to Blue Button authorization screen (`https://sandbox.bluebutton.cms.gov/v1/o/authorize/`)
3. User logs in with Medicare.gov credentials and grants access
4. Blue Button redirects to `https://guardian.myhealthapps.com/auth/callback` with authorization code
5. Exchange authorization code for access token at `https://sandbox.bluebutton.cms.gov/v1/o/token/`
6. Use access token to call FHIR endpoints

## Credentials

Credentials are stored in `.env.bluebutton` (gitignored) and referenced from `.env.bluebutton.example`.

- **Client ID**: `BLUEBUTTON_CLIENT_ID`
- **Client Secret**: `BLUEBUTTON_CLIENT_SECRET`

## Test Users (Sandbox)

Use synthetic sandbox users for testing:
- Username: `BBUser00000` through `BBUser09999`
- Password: `PW00000!` through `PW09999!`

## Sample API Call

```bash
export TOKEN="<access_token>"
curl -H "Authorization: Bearer $TOKEN" \
  "https://sandbox.bluebutton.cms.gov/v2/fhir/ExplanationOfBenefit/"
```

## Production Access

To request production access:
1. Complete Terms of Service at https://bluebutton.cms.gov/terms/
2. Develop and test fully in sandbox
3. Draft privacy policy and terms of service
4. Email BlueButtonAPI@cms.hhs.gov
5. Complete 1-hour Zoom demo
6. Receive production credentials

## Resources

- [API Documentation](https://bluebutton.cms.gov/api-documentation/)
- [Sandbox Dashboard](https://sandbox.bluebutton.cms.gov/home)
- [Developer Google Group](https://groups.google.com/g/Developer-group-for-cms-blue-button-api)
- [Production Access Guide](https://bluebutton.cms.gov/production-access/)
- [Node SDK](https://www.npmjs.com/package/cms-bluebutton-sdk)
- [Python SDK](https://pypi.org/project/cms-bluebutton-sdk/)
