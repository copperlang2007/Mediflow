# agencyBRIDGE — Medicare Sales Agency Platform

## Overview
agencyBRIDGE is a production-grade Medicare agency management platform designed to replace disparate systems like Monday.com and GoHighLevel. It aims to support 25-100 agents by providing a comprehensive suite of tools including AI integrations, automations, two-way SMS/email communication, and retention features. The platform is built with a strong emphasis on HIPAA and SOC 2 compliance, ensuring secure and efficient operations for Medicare sales agencies.

## Conventions
- Prefer clear and concise explanations.
- Ask for confirmation before implementing major changes or complex features.
- Keep the codebase modular and maintainable.
- Avoid making changes to the `lib/api-zod/src/index.ts` file directly, except for the explicit `export * from "./generated/api"` fix after codegen.
- When generating API hooks and Zod schemas from the OpenAPI spec, ensure the `lib/api-zod/src/index.ts` file only contains `export * from "./generated/api"` afterward.

## System Architecture

### UI/UX Decisions
The frontend is a React 19 application using Vite, Tailwind v4, shadcn/ui, and wouter for routing. Key UI/UX features include:
- **Error Handling**: Global and page-level React Error Boundaries with skeleton fallbacks for lazy-loaded components.
- **Theming**: A distinct color palette featuring a navy sidebar (`221 50% 18%`), Medicare blue primary (`221 83% 43%`), and cyan accent (`199 89% 48%`).
- **AI Assistant Panel**: A floating "Bot" button opens a right-side SSE chat drawer with slash commands, providing context-aware AI interactions based on the current page.

### Technical Implementations
The project is structured as a pnpm monorepo using Node.js 24 and TypeScript 5.9.
- **API**: Built with Express 5, PostgreSQL, and Drizzle ORM.
- **Authentication**: Handled by Clerk, with a proxy at `/api/__clerk`.
- **Validation**: Zod v4 with drizzle-zod for schema validation.
- **API Codegen**: Orval generates API client hooks (React Query v5) and Zod validation schemas from an OpenAPI specification (`lib/api-spec/openapi.yaml`).
- **Storage**: Google Cloud Storage for file management, using signed URLs. GCS is the BAA-covered path for PHI, and `assertStorageBackendHipaaCompliant()` enforces it at boot. There is no S3 or MinIO code path. See `artifacts/api-server/src/lib/objectStorage.ts`.
- **Background Jobs**: `pg-boss` (PostgreSQL-backed job queue) handles scheduled and ad-hoc tasks.
- **Email**: Resend is integrated for transactional email services.
- **SMS**: Twilio powers two-way SMS communication.
- **Build**: `esbuild` is used for CJS bundle generation for the API.

### Feature Specifications
- **Role-Based Access Control (RBAC)**: Centralized permission matrix in `lib/permissions.ts` enforcing `super_admin`, `agency_admin`, `compliance_manager`, `agent_support`, `viewer`, and `agent` roles.
- **HIPAA/SOC 2 Compliance**: Implemented through `auditMiddleware` for automatic PHI audit logging, private storage with ACLs, and a `admin/baa-checklist` endpoint.
- **Agent Lifecycle Management**: Comprehensive tracking of agents from onboarding to offboarding, including state licenses, carrier certifications, and AHIP records. Automated checklist creation on agent onboarding.
- **CRM Capabilities**: Contact, lead, pipeline, deal, and activity management with advanced filtering and bulk actions.
- **Communication Hub**: Two-way SMS and email threads integrated with contact management, supporting templates and an unread message inbox.
- **AI Integrations**:
    - **Context-aware Chat**: SSE streaming chat (`/ai/chat`) with system prompts dynamically injected with live database data.
    - **Drafting**: AI-powered drafting of SMS and emails (`/ai/draft`).
    - **Compliance Reporting**: SSE streaming agency-wide compliance intelligence reports (`/ai/compliance-report`).
- **Automation Engine**: Rules engine (`automation_rules` table) allows defining triggers (e.g., `lead_created`, `license_expiring_soon`), conditions, and actions (e.g., `create_task`, `send_email`).
- **Reporting & Analytics**: Dashboards and reports for agent performance, pipeline analytics, lead sources, compliance matrix, communication volume, and retention metrics.
- **Import Wizards**: Dedicated wizards for migrating data from Monday.com and GoHighLevel, as well as a generic CSV contact import, with progress tracking and error reporting.

## External Dependencies
- **Clerk**: User authentication and authorization service.
- **PostgreSQL**: Primary database for all application data, including background job queue data (`pg-boss`).
- **Google Cloud Storage**: Cloud storage for application assets and documents, accessed via signed URLs.
- **Resend**: Email sending service.
- **Twilio**: SMS messaging service.
- **OpenAI**: AI model services for chat, drafting, and compliance reporting. Azure OpenAI is used in production as the HIPAA BAA-covered provider; the standard OpenAI API is used only in development. A single provider is configured via `AI_INTEGRATIONS_PROVIDER` (see `lib/integrations-openai-ai-server/src/buildClient.ts`).
- **Vite**: Frontend build tool.
- **Tailwind CSS**: Utility-first CSS framework.
- **shadcn/ui**: Reusable UI components.
- **React Query**: Data fetching and caching library for React.
