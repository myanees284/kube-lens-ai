import type { InvestigationStatus } from "../persistence/types.ts";

const allowed: Record<InvestigationStatus, InvestigationStatus[]> = {
  queued: ["running", "failed"],
  running: ["completed", "partial", "failed"],
  completed: [],
  partial: [],
  failed: [],
};

export function assertStatusTransition(from: InvestigationStatus, to: InvestigationStatus): void {
  if (!allowed[from].includes(to)) {
    throw new Error(`Investigation status cannot change from ${from} to ${to}.`);
  }
}
