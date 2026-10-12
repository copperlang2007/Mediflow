import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import organizationsRouter from "./organizations";
import dashboardRouter from "./dashboard";
import agentsRouter from "./agents";
import agentReadinessRouter from "./agentReadiness";
import agentLeaderboardRouter from "./agentLeaderboard";
import notificationsRouter from "./notifications";
import auditRouter from "./audit";
import storageRouter from "./storage";
import licensesRouter from "./licenses";
import certificationsRouter from "./certifications";
import ahipRouter from "./ahip";
import carriersRouter from "./carriers";
import checklistsRouter from "./checklists";
import techstackRouter from "./techstack";
import tasksRouter from "./tasks";
import agentDocumentsRouter from "./agentDocuments";
import renewalsRouter from "./renewals";
import orgSettingsRouter from "./orgSettings";
import contactsRouter from "./contacts";
import leadsRouter from "./leads";
import queueRouter from "./queue";
import pipelinesRouter from "./pipelines";
import communicationsRouter from "./communications";
import templatesRouter from "./templates";
import sequencesRouter from "./sequences";
import retentionCrmRouter from "./retentionCrm";
import automationsRouter from "./automations";
import aiRouter from "./ai";
import reportsRouter from "./reports";
import adminRouter from "./admin";
import adminHealthRouter from "./adminHealth";
import importsRouter from "./imports";
import ghlSyncRouter from "./ghlSync";
import enrollmentApplicationsRouter from "./enrollmentApplications";
import integrationPayloadsRouter from "./integrationPayloads";
import commissionsRouter from "./commissions";
import statementIngestRouter from "./statementIngest";
import onboardingRouter from "./onboarding";
import esignRouter from "./esign";
import complaintsRouter from "./complaints";
import aepCockpitRouter from "./aepCockpit";
import marketingRouter from "./marketing";
import churnScoresRouter from "./churnScores";
import clawbacksRouter from "./clawbacks";
import enrollmentsRouter from "./enrollments";
import billingRouter from "./billing";
import invitationsRouter from "./invitations";
import campaignsRouter from "./campaigns";
import devRouter from "./dev";
// --- stage2/portal-dialer ---
import clientPortalRouter from "./clientPortal";
import softphoneRouter from "./softphone";
import supervisorRouter from "./supervisor";
import quotingRouter from "./quoting";
// --- stage2/new-pages-core ---
import knowledgeBaseRouter from "./knowledgeBase";
import reconciliationRouter from "./reconciliation";
import agentBackofficeRouter from "./agentBackoffice";
import agentClientsRouter from "./agentClients";
import dataExportsRouter from "./dataExports";
// --- stage2/calendar-branding ---
import appointmentsRouter from "./appointments";
import brandingRouter from "./branding";
import workspacesRouter from "./workspaces";
import callScoringRouter from "./callScoring";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(organizationsRouter);
router.use(dashboardRouter);
// Mounted BEFORE agentsRouter so the static `/agents/readiness` path is matched
// before agentsRouter's `/agents/:id` wildcard (which would treat "readiness"
// as an agent id and 404).
router.use(agentReadinessRouter);
// Mounted BEFORE agentsRouter for the same reason as agentReadinessRouter: the
// static `/agents/leaderboard` path must match before agentsRouter's
// `/agents/:id` wildcard (which would treat "leaderboard" as an agent id).
router.use(agentLeaderboardRouter);
router.use(agentsRouter);
router.use(notificationsRouter);
router.use(auditRouter);
router.use(storageRouter);
router.use(licensesRouter);
router.use(certificationsRouter);
router.use(ahipRouter);
router.use(carriersRouter);
router.use(checklistsRouter);
router.use(techstackRouter);
router.use(tasksRouter);
router.use(agentDocumentsRouter);
router.use(renewalsRouter);
router.use(orgSettingsRouter);
router.use(contactsRouter);
router.use(leadsRouter);
router.use(queueRouter);
router.use(pipelinesRouter);
router.use(communicationsRouter);
router.use(templatesRouter);
router.use(sequencesRouter);
router.use(retentionCrmRouter);
router.use(automationsRouter);
router.use(aiRouter);
router.use(reportsRouter);
router.use(adminRouter);
router.use(adminHealthRouter);
router.use(importsRouter);
router.use(ghlSyncRouter);
router.use(enrollmentApplicationsRouter);
router.use(integrationPayloadsRouter);
router.use(commissionsRouter);
router.use(statementIngestRouter);
router.use(onboardingRouter);
router.use(esignRouter);
router.use(complaintsRouter);
router.use(aepCockpitRouter);
router.use(marketingRouter);
router.use(churnScoresRouter);
router.use(clawbacksRouter);
router.use(enrollmentsRouter);
router.use(billingRouter);
router.use(invitationsRouter);
// --- stage2/portal-dialer ---
router.use(clientPortalRouter);
router.use(softphoneRouter);
router.use(supervisorRouter);
router.use(quotingRouter);
// --- stage2/new-pages-core ---
router.use(knowledgeBaseRouter);
router.use(reconciliationRouter);
router.use(agentBackofficeRouter);
router.use(agentClientsRouter);
router.use(dataExportsRouter);
// --- stage2/calendar-branding ---
router.use(appointmentsRouter);
router.use(brandingRouter);
router.use(workspacesRouter);
router.use(campaignsRouter);
router.use(callScoringRouter);

// Dev console is mounted only when the env var is set. The router itself
// also applies the `devOnly` middleware, so even if this guard were
// bypassed the routes would 404. Keeping the mount conditional means the
// router (and its DB-introspection imports) is never even constructed in
// production builds where the env var is unset.
if (process.env.ENABLE_DEV_CONSOLE === "true") {
  router.use(devRouter);
}

export default router;
