# kube-lens-ai

Local, single-user Kubernetes troubleshooting assistant. The approved design is in [Architecture.md](Architecture.md). Implementation follows that document phase by phase.

## Status

Phase 0 is in place: pnpm workspace, shared contracts, Fastify API with configuration checks, API-key protection, structured logs, `/healthz`, a React dashboard shell, tests, and GitHub Actions CI.

Phase 1 collects read-only Kubernetes evidence from one namespace, then normalizes, bounds, and redacts it.

Phase 2 stores investigations, incidents, and Kubernetes notes in the `k8s_KBase` database. Incidents are retrieved with Atlas keyword and vector search. On this cluster, Kubernetes notes use a text index and local similarity because the Atlas search-index limit is already full. The historical-match threshold stays unset until it is calibrated.

Phase 3 runs the investigation workflow. A historical incident match returns the stored RCA and does not call Groq. Otherwise Groq generates a new RCA from the sanitized evidence and any retrieved notes. Kubernetes, retrieval, and Groq failures stay distinct. Investigation HTTP routes are still later work.

Phase 4 exposes the investigation API: create, read, list, the progress stream, ingestion, and incident lookup. Reconnecting clients replay events after `Last-Event-ID`.

Later phases add the full dashboard.

## Run locally

See [docs/local-development.md](docs/local-development.md).

```bash
pnpm install
cp .env.example .env
pnpm dev
```
