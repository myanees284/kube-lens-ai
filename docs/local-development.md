# Local development

Phase 0 runs the frontend and backend as two local processes. Kubernetes collection, MongoDB, retrieval, and Groq calls are later phases. The backend still validates those settings at startup so a bad environment fails before the process listens.

## Decisions for this workspace

- Package manager: pnpm workspaces. The lockfile is `pnpm-lock.yaml`.
- Node.js: the approved architecture names Node.js 24 LTS. This machine has Node.js 22.20.0, so the toolchain accepts Node.js 22 or newer and CI uses Node.js 22. Move CI and `engines` to 24 when that runtime is installed.
- Ports: API `127.0.0.1:3001`, Vite `127.0.0.1:5173`. Vite proxies `/healthz` and `/api` to the API.
- CI: GitHub Actions workflow `.github/workflows/ci.yml`.

## Setup

1. Use Node.js 22 or newer.
2. Enable pnpm through Corepack if `pnpm` is not on your path: `corepack enable`.
3. Install locked dependencies: `pnpm install`.
4. Copy `.env.example` to `.env` and replace every `replace-with-*` value. Do not commit `.env`.
5. Start the API: `pnpm dev:api`.
6. Start the dashboard: `pnpm dev:web`.
7. Open `http://127.0.0.1:5173`. The page calls `/healthz` through the Vite proxy.

`pnpm dev` starts both after building shared contracts.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`/healthz` is unauthenticated and returns `{ "status": "ok" }`. Every `/api/...` route requires the `X-API-Key` header. The key is compared with a SHA-256 digest and `timingSafeEqual`. The dashboard does not ask for the key. The Vite dev server reads `APP_API_KEY` from `.env` and adds the header while proxying `/api`. The key is not written into the browser bundle, local storage, session storage, or the URL.

A wrong or missing key returns `401` with `UNAUTHORIZED`. The response does not echo the configured key.

## Phase 1 evidence collection

The collector reads pods, services, events, and bounded log excerpts from one namespace. It does not list every namespace, and it does not create, update, delete, or exec into resources.

```bash
pnpm --filter @kube-lens/api collect-evidence -- --namespace book-prod --check
```

`--check` confirms the local `book-prod` sample: a running catalog pod, an image-pull failure, a liveness failure, and an OOM kill. Omit `--check` to print the evidence JSON only. `DEFAULT_NAMESPACE` is used later by the API when a request omits scope; the script still requires `--namespace`.

## Phase 2 knowledge base

The application database is `k8s_KBase` on the configured Atlas cluster. Do not point `MONGODB_DATABASE` at `sample_mflix`.

```bash
pnpm --filter @kube-lens/api setup-mongodb
pnpm --filter @kube-lens/api seed-knowledge
pnpm --filter @kube-lens/api retrieve-check
```

`setup-mongodb` creates validators, regular indexes, and Atlas Search indexes. This cluster allows three search indexes, and `sample_mflix` already uses one. Incident keyword and vector indexes use the other two. Kubernetes docs then use a normal text index plus in-process cosine similarity over the stored 384-dimension embeddings. If both `kubernetes_docs_text` and `kubernetes_docs_vector` are later queryable, retrieval uses those Atlas indexes instead. `seed-knowledge` embeds a small curated set with the local `all-MiniLM-L6-v2` model, waits until the incident search indexes are queryable, and waits until the seeded incidents show up in keyword search. `@huggingface/transformers` stays on 3.8.1 so the ONNX runtime includes an Intel macOS build. If a fresh install reports a missing `onnxruntime_binding.node`, run `pnpm approve-builds` and allow `onnxruntime-node`. `RAG_INCIDENT_MIN_SCORE` stays empty. A stored incident is still used when its failure token agrees with the evidence, such as `OOMKilled` or `ImagePullBackOff`. `CrashLoopBackOff` by itself does not select one. When the threshold is set, the incident must also clear that score.

## Phase 3 investigation workflow

The workflow collects evidence, retrieves knowledge, and either returns a stored incident RCA or asks Groq for a new one. Routine tests mock Groq. A stored incident is selected when its failure token agrees with the evidence, even while `RAG_INCIDENT_MIN_SCORE` is empty.

## Phase 4 investigation API

`POST /api/v1/investigations` accepts a question and a namespace, returns `202`, and runs the workflow in process. `GET /api/v1/investigations/:id` returns the current status and, when finished, the evidence, retrieval decision, and RCA. `GET /api/v1/investigations/:id/events` streams progress and replays events after the `Last-Event-ID` header. A namespace is required on create unless `DEFAULT_NAMESPACE` is set.

Import the Phase 4 Postman collection in `collections/`. Set `apiKey` to `APP_API_KEY`.

## Phase 5 dashboard

Open `http://127.0.0.1:5173` while `pnpm dev` is running. The top of the page lists kubeconfig clusters and marks a reachable cluster with a green dot. Choose a cluster to open the investigation workspace. The workspace starts a question in that cluster and follows `GET /api/v1/investigations/:id/events`. When the stream closes, it reads the saved investigation and shows evidence, the retrieval decision, and the RCA source. A stored incident and a Groq result use different labels. A retrieval failure says the knowledge check is unavailable. Save to knowledge base is shown only after a usable RCA, and only a click writes an incident.

## Phase 6 ingestion check

Saving is still a click in the dashboard or `POST /api/v1/investigations/:id/ingest`. The API redacts secrets in the question and RCA, embeds the sanitized text, and inserts one incident. A second save returns `200` with the same incident id. `pnpm --filter @kube-lens/api ingest-check` saves a temporary OOM incident, confirms a repeated save does not duplicate it, confirms a later query retrieves it, and then deletes that temporary incident.

## Postman

Import `collections/kube-lens-ai.postman_collection.json` and `collections/Local.postman_environment.json`. Set `apiKey` to the same value as `APP_API_KEY`. The collection covers `/healthz`, API-key checks, and the Phase 4 investigation routes.
