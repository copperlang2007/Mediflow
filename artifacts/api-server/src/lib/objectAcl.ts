/**
 * Object storage access control.
 *
 * ACL policies are stored as GCS object custom metadata under
 * `custom:aclPolicy` (JSON). The only implemented access group type is
 * ORG_MEMBER, which grants access to all active members of an organisation.
 *
 * Policy shape:
 *   { owner: userId, visibility: "public" | "private", aclRules?: [...] }
 *
 * Access is granted when:
 *   1. File is public + READ is requested, OR
 *   2. Requesting user is the owner, OR
 *   3. User is a member of any group that grants the requested permission.
 */

import type { File } from "@google-cloud/storage";
import { eq, and } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const ACL_POLICY_METADATA_KEY = "custom:aclPolicy";

export enum ObjectAccessGroupType {
  /** All active members of the organisation identified by the group id. */
  ORG_MEMBER = "ORG_MEMBER",
}

export interface ObjectAccessGroup {
  type: ObjectAccessGroupType;
  /** Logical identifier for the group. For ORG_MEMBER this is the orgId. */
  id: string;
}

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclRule {
  group: ObjectAccessGroup;
  permission: ObjectPermission;
}

export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  aclRules?: ObjectAclRule[];
}

// ---- Access group implementations ----

abstract class BaseObjectAccessGroup implements ObjectAccessGroup {
  constructor(
    public readonly type: ObjectAccessGroupType,
    public readonly id: string,
  ) {}
  abstract hasMember(userId: string): Promise<boolean>;
}

class OrgMemberAccessGroup extends BaseObjectAccessGroup {
  async hasMember(userId: string): Promise<boolean> {
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, userId),
          eq(usersTable.orgId, this.id),
          eq(usersTable.isActive, true),
        ),
      )
      .limit(1);
    return !!user;
  }
}

function createAccessGroup(group: ObjectAccessGroup): BaseObjectAccessGroup {
  switch (group.type) {
    case ObjectAccessGroupType.ORG_MEMBER:
      return new OrgMemberAccessGroup(group.type, group.id);
    default: {
      const _exhaustive: never = group.type;
      throw new Error(`Unknown access group type: ${_exhaustive}`);
    }
  }
}

function isPermissionAllowed(
  requested: ObjectPermission,
  granted: ObjectPermission,
): boolean {
  if (requested === ObjectPermission.READ) {
    return granted === ObjectPermission.READ || granted === ObjectPermission.WRITE;
  }
  return granted === ObjectPermission.WRITE;
}

// ---- Policy read/write helpers ----

export async function setObjectAclPolicy(
  objectFile: File,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  const [exists] = await objectFile.exists();
  if (!exists) throw new Error(`Object not found: ${objectFile.name}`);

  await objectFile.setMetadata({
    metadata: { [ACL_POLICY_METADATA_KEY]: JSON.stringify(aclPolicy) },
  });
}

export async function getObjectAclPolicy(
  objectFile: File,
): Promise<ObjectAclPolicy | null> {
  const [metadata] = await objectFile.getMetadata();
  const raw = metadata?.metadata?.[ACL_POLICY_METADATA_KEY];
  if (!raw) return null;
  return JSON.parse(raw as string) as ObjectAclPolicy;
}

// ---- Access check ----

export async function canAccessObject({
  userId,
  objectFile,
  requestedPermission,
}: {
  userId?: string;
  objectFile: File;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const policy = await getObjectAclPolicy(objectFile);

  // No policy → deny
  if (!policy) return false;

  // Public read
  if (
    policy.visibility === "public" &&
    requestedPermission === ObjectPermission.READ
  ) {
    return true;
  }

  if (!userId) return false;

  // Owner has full access
  if (policy.owner === userId) return true;

  // ACL rules
  for (const rule of policy.aclRules ?? []) {
    const group = createAccessGroup(rule.group);
    if (
      isPermissionAllowed(requestedPermission, rule.permission) &&
      (await group.hasMember(userId))
    ) {
      return true;
    }
  }

  return false;
}
