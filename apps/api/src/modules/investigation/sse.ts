export interface StoredEvent {
  sequence: number;
  eventType: string;
  timestamp: string;
  message: string;
  step?: string;
  status?: string;
  payload?: Record<string, unknown>;
  error?: { code: string; safeMessage: string };
}

const terminalEvents = new Set(["investigation.completed", "investigation.partial", "investigation.failed"]);

export function parseLastEventId(header: string | undefined, investigationId: string): number | null {
  if (!header) return null;
  const separator = header.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = header.slice(0, separator);
  const sequence = Number(header.slice(separator + 1));
  if (id !== investigationId || !Number.isInteger(sequence) || sequence < 0) return null;
  return sequence;
}

export function selectReplay(events: StoredEvent[], lastSequence: number | null): { events: StoredEvent[]; gap: boolean } {
  if (lastSequence === null) return { events, gap: false };
  const oldest = events[0]?.sequence;
  const gap = oldest !== undefined && lastSequence + 1 < oldest;
  return { events: events.filter((event) => event.sequence > lastSequence), gap };
}

export function isTerminalEvent(eventType: string): boolean {
  return terminalEvents.has(eventType);
}

export function formatSse(investigationId: string, event: StoredEvent): string {
  const data = {
    schemaVersion: 1 as const,
    investigationId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    ...(event.step ? { step: event.step } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.payload ? { payload: event.payload } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
  return `id: ${investigationId}:${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatHistoryGap(): string {
  return ": earlier events are no longer retained. Read the investigation for the current result.\n\n";
}

export function formatHeartbeat(): string {
  return ": heartbeat\n\n";
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(value: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator <= 0) return null;
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(createdAt.getTime()) || !/^[a-fA-F0-9]{24}$/.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
