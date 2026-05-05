/**
 * In-process SSE subscriber registry.
 *
 * Centralised here so both route handlers and background workers can broadcast
 * without importing from the routes layer.
 */

import type { Response } from "express";

// userId → set of open SSE Response objects
const subscribers = new Map<string, Set<Response>>();

/** Register an SSE response for a user. */
export function addSseSubscriber(userId: string, res: Response): void {
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  subscribers.get(userId)!.add(res);
}

/** Deregister an SSE response when the client disconnects. */
export function removeSseSubscriber(userId: string, res: Response): void {
  const set = subscribers.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) subscribers.delete(userId);
}

/**
 * Push a JSON event to all open SSE connections for a user.
 * Silently skips if the user has no open connections.
 */
export function broadcastToUser(
  userId: string,
  payload: Record<string, unknown>,
): void {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      // Connection gone — will be cleaned up on "close" event
    }
  }
}

/**
 * Push a notification event to a list of user IDs.
 * Each user receives their own copy of the payload.
 */
export function broadcastToUsers(
  userIds: string[],
  payload: Record<string, unknown>,
): void {
  for (const userId of userIds) {
    broadcastToUser(userId, payload);
  }
}
