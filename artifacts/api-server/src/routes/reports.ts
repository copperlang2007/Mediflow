import { Router, type IRouter } from "express";

import agentPerformanceRouter from "./reports/agent-performance";
import pipelineRouter from "./reports/pipeline";
import leadsRouter from "./reports/leads";
import complianceMatrixRouter from "./reports/compliance-matrix";
import communicationsRouter from "./reports/communications";
import retentionRouter from "./reports/retention";
import executiveRouter from "./reports/executive";

const router: IRouter = Router();

router.use(agentPerformanceRouter);
router.use(pipelineRouter);
router.use(leadsRouter);
router.use(complianceMatrixRouter);
router.use(communicationsRouter);
router.use(retentionRouter);
router.use(executiveRouter);

export default router;
