import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import organizationsRouter from "./organizations";
import dashboardRouter from "./dashboard";
import agentsRouter from "./agents";
import agentReadinessRouter from "./agentReadiness";
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
import commissionsRouter from "./commissions";
import onboardingRouter from "./onboarding";
import esignRouter from "./esign";
import devRouter from "./dev";

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
router.use(commissionsRouter);
router.use(onboardingRouter);
router.use(esignRouter);

// Dev console is mounted only when the env var is set. The router itself
// also applies the `devOnly` middleware, so even if this guard were
// bypassed the routes would 404. Keeping the mount conditional means the
// router (and its DB-introspection imports) is never even constructed in
// production builds where the env var is unset.
if (process.env.ENABLE_DEV_CONSOLE === "true") {
  router.use(devRouter);
}

export default router;
