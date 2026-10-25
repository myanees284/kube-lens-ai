import { useEffect, useRef, useState } from "react";
import type { InvestigationResponse } from "@kube-lens/contracts";
import { ApiRequestError, type InvestigationClient } from "../lib/api.ts";
import { upsertTimeline, type TimelineEntry } from "../lib/present.ts";

export type StreamState = "idle" | "live" | "reconnecting" | "closed" | "unavailable";

export function useInvestigation(client: InvestigationClient, id: string | null, onSettled?: () => void) {
  const [investigation, setInvestigation] = useState<InvestigationResponse | null>(null);
  const [events, setEvents] = useState<TimelineEntry[]>([]);
  const [stream, setStream] = useState<StreamState>("idle");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    if (!id) {
      setInvestigation(null);
      setEvents([]);
      setStream("idle");
      setStreamError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setInvestigation(null);
    setEvents([]);
    setStream("live");
    setStreamError(null);
    setLoading(true);

    const run = async () => {
      try {
        const snapshot = await client.getInvestigation(id);
        if (!active) return;
        setInvestigation(snapshot);
        setLoading(false);
        await client.watch(id, {
          signal: controller.signal,
          onEvent: (entry) => {
            if (!active) return;
            setEvents((current) => upsertTimeline(current, entry));
          },
          onLive: () => {
            if (active) setStream("live");
          },
          onReconnect: () => {
            if (active) setStream("reconnecting");
          },
        });
        if (!active) return;
        setStream("closed");
        const latest = await client.getInvestigation(id);
        if (!active) return;
        setInvestigation(latest);
        settledRef.current?.();
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setStream("unavailable");
        setStreamError(error instanceof ApiRequestError ? error.message : "The progress stream stopped.");
        try {
          const latest = await client.getInvestigation(id);
          if (active) setInvestigation(latest);
        } catch (loadError) {
          if (active && loadError instanceof ApiRequestError) setStreamError(loadError.message);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void run();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, id]);

  const replaceInvestigation = (value: InvestigationResponse) => {
    setInvestigation(value);
  };

  return { investigation, events, stream, streamError, loading, replaceInvestigation };
}
