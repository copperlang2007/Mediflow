/**
 * Dev console router.
 *
 * Mounts /dev/* sub-routers behind the devOnly gate. When
 * ENABLE_DEV_CONSOLE is not "true", every route below 404s before
 * touching a handler — including the /dev/db/*, /dev/env, and
 * /dev/ops/* routes.
 *
 * Phase 1A: /dev/ops (build / queues / recent-errors / workers).
 * Phase 1B: /dev/db (schema browser) and /dev/env (masked env viewer).
 *
 * The parent routes/index.ts only `.use()`s this when
 * ENABLE_DEV_CONSOLE === "true", but we apply `devOnly` here as well as
 * defence-in-depth so the gate stays glued to the surface even if some
 * future change wires this router up elsewhere.
 */
import { Router, type IRouter } from "express";
import { devOnly } from "./middleware/devOnly";
import dbRouter from "./db";
import envRouter from "./env";
import opsRouter from "./ops";
import featureBuilderRouter from "./feature-builder";

const router: IRouter = Router();

router.use("/dev", devOnly, dbRouter);
router.use("/dev", devOnly, envRouter);
router.use("/dev/ops", devOnly, opsRouter);
router.use("/dev", devOnly, featureBuilderRouter);

export default router;
