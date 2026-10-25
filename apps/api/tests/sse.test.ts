import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, formatSse, parseLastEventId, selectReplay } from "../src/modules/investigation/sse.ts";

describe("sse replay", () => {
  it("parses an event id for the same investigation", () => {
    expect(parseLastEventId("abc:4", "abc")).toBe(4);
    expect(parseLastEventId("other:4", "abc")).toBeNull();
    expect(parseLastEventId(undefined, "abc")).toBeNull();
  });

  it("replays only newer events and reports a gap when older events were dropped", () => {
    const events = [
      { sequence: 4, eventType: "step.completed", timestamp: "2026-10-25T06:00:00.000Z", message: "collecting_evidence completed." },
      { sequence: 5, eventType: "investigation.completed", timestamp: "2026-10-25T06:00:01.000Z", message: "Investigation completed." },
    ];

    expect(selectReplay(events, 4).events.map((event) => event.sequence)).toEqual([5]);
    expect(selectReplay(events, 1)).toMatchObject({ gap: true });
    expect(selectReplay(events, null).gap).toBe(false);
  });

  it("writes the event id, name, and envelope", () => {
    const wire = formatSse("abc", {
      sequence: 2,
      eventType: "evidence.summary",
      timestamp: "2026-10-25T06:00:00.000Z",
      message: "Evidence summary is ready.",
      payload: { summary: "Image pull is failing." },
    });

    expect(wire).toContain("id: abc:2");
    expect(wire).toContain("event: evidence.summary");
    expect(wire).toContain("\"schemaVersion\":1");
    expect(wire).not.toContain("embedding");
  });

  it("round-trips a list cursor", () => {
    const createdAt = new Date("2026-10-25T06:00:00.000Z");
    const id = new ObjectId().toHexString();
    expect(decodeCursor(encodeCursor(createdAt, id))).toEqual({ createdAt, id });
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
});
