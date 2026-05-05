import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import organizationsRouter from "./organizations";
import dashboardRouter from "./dashboard";
import agentsRouter from "./agents";
import notificationsRouter from "./notifications";
import auditRouter from "./audit";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(organizationsRouter);
router.use(dashboardRouter);
router.use(agentsRouter);
router.use(notificationsRouter);
router.use(auditRouter);
router.use(storageRouter);

export default router;
