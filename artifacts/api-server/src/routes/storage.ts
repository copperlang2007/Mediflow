/**
 * Storage routes.
 *
 * POST /storage/uploads/request-url    — get presigned PUT URL for upload
 * POST /storage/uploads/confirm        — set ACL after upload completes
 * GET  /storage/public-objects/*path   — serve public assets (no auth)
 * GET  /storage/objects/*path          — serve private files (auth + ACL)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { z } from "zod";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission, ObjectAccessGroupType } from "../lib/objectAcl";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ---- Zod schemas ----

const ConfirmUploadSchema = z.object({
  objectPath: z.string().min(1),
  visibility: z.enum(["private", "public"]).default("private"),
});

// ---- Routes ----

/**
 * POST /storage/uploads/request-url
 *
 * Returns a presigned PUT URL the client can upload directly to.
 * Caller MUST follow up with POST /storage/uploads/confirm after upload.
 */
router.post(
  "/storage/uploads/request-url",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

/**
 * POST /storage/uploads/confirm
 *
 * Sets ACL policy on an object after the client has finished uploading.
 * Must be called before the file can be accessed via GET /storage/objects/*.
 *
 * ACL policy: owner = authenticated user, aclRules = all org members may read.
 */
router.post(
  "/storage/uploads/confirm",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = ConfirmUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "objectPath is required" });
      return;
    }

    const { objectPath, visibility } = parsed.data;

    try {
      const confirmedPath = await objectStorageService.trySetObjectEntityAclPolicy(
        objectPath,
        {
          owner: authReq.userId,
          visibility,
          aclRules: [
            {
              group: {
                type: ObjectAccessGroupType.ORG_MEMBER,
                id: authReq.orgId,
              },
              permission: ObjectPermission.READ,
            },
          ],
        },
      );

      res.json({ objectPath: confirmedPath });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Object not found — upload may not have completed" });
        return;
      }
      req.log.error({ err: error }, "Error confirming upload ACL");
      res.status(500).json({ error: "Failed to confirm upload" });
    }
  },
);

/**
 * GET /storage/public-objects/*filePath
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS. No auth required.
 */
router.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const response = await objectStorageService.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, "Error serving public object");
      res.status(500).json({ error: "Failed to serve public object" });
    }
  },
);

/**
 * GET /storage/objects/*path
 *
 * Serve private object — authentication + ACL check required.
 */
router.get(
  "/storage/objects/*path",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

      const canAccess = await objectStorageService.canAccessObjectEntity({
        userId: authReq.userId,
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });

      if (!canAccess) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const response = await objectStorageService.downloadObject(objectFile);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        req.log.warn({ err: error }, "Object not found");
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving object");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default router;
