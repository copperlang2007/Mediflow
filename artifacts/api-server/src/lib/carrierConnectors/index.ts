/**
 * Carrier-connector registry.
 *
 * Maps `carrierId → CarrierConnector`. For v1 every carrier resolves to
 * `emailConnector` (single fire-to-appointment-desk path). Phase-2 swaps
 * carriers individually to native connectors without changing call sites.
 *
 * Registration model:
 *   - The default export `resolveCarrierConnector(carrierId)` ALWAYS
 *     returns a connector — falling back to `emailConnector` when no
 *     specific binding exists. This is intentional: we never want a carrier
 *     to silently get "no integration" — every contracting request must
 *     have some path to a desk.
 *   - Specific carriers can opt into a native connector via
 *     `registerCarrierConnector(carrierId, connector)`. The Day-6+ wiring
 *     for individual carriers (e.g. Aetna API) will call this from the
 *     module that defines their connector.
 */
import { emailConnector } from "./emailConnector";
import type { CarrierConnector } from "./types";

const REGISTRY = new Map<string, CarrierConnector>();

export function registerCarrierConnector(
  carrierId: string,
  connector: CarrierConnector,
): void {
  REGISTRY.set(carrierId, connector);
}

export function unregisterCarrierConnector(carrierId: string): void {
  REGISTRY.delete(carrierId);
}

export function resolveCarrierConnector(carrierId: string): CarrierConnector {
  return REGISTRY.get(carrierId) ?? emailConnector;
}

/**
 * For tests + admin diagnostics — list every carrier that has a native
 * (non-email) connector wired. Carriers not in this list fall back to
 * `emailConnector`.
 */
export function listRegisteredCarrierConnectors(): Array<{
  carrierId: string;
  name: string;
}> {
  return [...REGISTRY.entries()].map(([carrierId, c]) => ({
    carrierId,
    name: c.name,
  }));
}

export { emailConnector };
export type {
  CarrierConnector,
  ContractingPacket,
  ContractingRequestRef,
  CarrierResponseStatus,
  CarrierConnectorPollResult,
  AgentContractingPacketProfile,
  PacketAddress,
} from "./types";
