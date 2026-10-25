# kube-lens-ai

Local, single-user Kubernetes troubleshooting assistant. Ask why a workload is failing. The app reads that resource from the selected cluster, checks saved incidents, and returns a root cause with the evidence behind it.

The approved design is in [Architecture.md](Architecture.md).

## Problem summary

Kubernetes troubleshooting is manual. An engineer checks pods, services, events, and logs one command at a time. Past incidents and Kubernetes reference notes sit outside that workflow, so the same failure is investigated again from scratch. An answer that does not show the cluster evidence is hard to trust.

## Solution

Pick a cluster, namespace, kind, and name, then ask one question.

1. A read-only agent collects that resource’s status, events, and logs.
2. MongoDB is searched for a saved incident with the same failure. `CrashLoopBackOff` alone is not a match. A stored answer is reused only when the specific failure agrees, such as `OOMKilled` or `Unhealthy`.
3. When a saved incident matches, its root cause is shown and Groq is not called.
4. When nothing matches, Groq writes a new root cause from the sanitized evidence and any retrieved Kubernetes notes.
5. The run is stored in `investigations`, which is what Recent investigations shows.
6. That run becomes reusable knowledge in `incidents` only after **Save to knowledge base**.

Live cluster data stays the source of truth. The screen shows the progress, the evidence, and whether the root cause came from a stored incident or from Groq.

## How it works

```text
Question and selected resource
        ↓
Read-only cluster evidence
        ↓
Search saved incidents and Kubernetes notes
        ↓
Matching incident  →  stored root cause
No match           →  Groq root cause
        ↓
Saved investigation, with optional save to incident knowledge
```

## Status

Phase 0 is in place: pnpm workspace, shared contracts, Fastify API with configuration checks, API-key protection, structured logs, `/healthz`, a React dashboard shell, tests, and GitHub Actions CI.

Phase 1 collects read-only Kubernetes evidence from one namespace, then normalizes, bounds, and redacts it.

Phase 2 stores investigations, incidents, and Kubernetes notes in the `k8s_KBase` database. Incidents are retrieved with Atlas keyword and vector search. On this cluster, Kubernetes notes use a text index and local similarity because the Atlas search-index limit is already full. A stored incident is used when its failure token agrees with the evidence. The numeric match threshold stays unset.

Phase 3 runs the investigation workflow. A historical incident match returns the stored RCA and does not call Groq. Otherwise Groq generates a new RCA from the sanitized evidence and any retrieved notes. Kubernetes, retrieval, and Groq failures stay distinct. Investigation HTTP routes are still later work.

Phase 4 exposes the investigation API: create, read, list, the progress stream, ingestion, and incident lookup. Reconnecting clients replay events after `Last-Event-ID`.

Phase 5 is the investigation dashboard. It lists kubeconfig clusters, submits a question for the selected resource, streams progress, and renders evidence, RCA provenance, history, and the optional save action. The browser does not ask for or store the API key. The Vite dev server adds that header when it proxies to the API.

Phase 6 checks that save. The RCA is sanitized, embedded, and stored once. A repeated save returns the same incident, and a later question can retrieve it when the failure token agrees.

## Run locally

See [docs/local-development.md](docs/local-development.md).

```bash
pnpm install
cp .env.example .env
pnpm dev
```
