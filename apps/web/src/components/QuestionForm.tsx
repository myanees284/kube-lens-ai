import { useEffect, useState, type FormEvent } from "react";
import type { CreateInvestigationRequest } from "@kube-lens/contracts";
import { ApiRequestError, type InvestigationClient } from "../lib/api.ts";

export function QuestionForm({
  client,
  cluster,
  onCreated,
}: {
  client: InvestigationClient;
  cluster: string;
  onCreated: (investigationId: string) => void;
}) {
  const [question, setQuestion] = useState("Why is this workload failing?");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [resourceKind, setResourceKind] = useState("Pod");
  const [names, setNames] = useState<string[]>([]);
  const [resourceName, setResourceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setNamespaces([]);
    setNamespace("");
    setNames([]);
    setResourceName("");
    client
      .namespaces(cluster)
      .then((body) => {
        if (controller.signal.aborted) return;
        setNamespaces(body.namespaces);
        setNamespace(body.namespaces.includes("book-prod") ? "book-prod" : (body.namespaces[0] ?? ""));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof ApiRequestError ? cause.message : "Namespaces could not be loaded.");
      });
    return () => controller.abort();
  }, [client, cluster]);

  useEffect(() => {
    if (!namespace || !resourceKind) {
      setNames([]);
      setResourceName("");
      return;
    }
    const controller = new AbortController();
    client
      .resourceNames(cluster, namespace, resourceKind)
      .then((body) => {
        if (controller.signal.aborted) return;
        setNames(body.names);
        setResourceName((current) => (body.names.includes(current) ? current : (body.names[0] ?? "")));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof ApiRequestError ? cause.message : "Resource names could not be loaded.");
      });
    return () => controller.abort();
  }, [client, cluster, namespace, resourceKind]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length === 0) {
      setError("Enter a question.");
      return;
    }
    const scope: NonNullable<CreateInvestigationRequest["scope"]> = { context: cluster };
    if (namespace.trim()) scope.namespace = namespace.trim();
    if (resourceKind.trim()) scope.resourceKind = resourceKind.trim();
    if (resourceName.trim()) scope.resourceName = resourceName.trim();
    const body: CreateInvestigationRequest = {
      question: trimmedQuestion,
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
    };
    setPending(true);
    setError(null);
    try {
      const created = await client.create(body);
      onCreated(created.investigationId);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : "The investigation could not be started.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-medium text-teal-300">Ask</h2>
      <p className="mt-1 text-xs text-slate-500">Cluster {cluster}</p>
      <label className="mt-4 block text-sm text-slate-200" htmlFor="question">
        Question
      </label>
      <textarea
        id="question"
        value={question}
        onChange={(input) => setQuestion(input.target.value)}
        rows={3}
        maxLength={2000}
        className="mt-2 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-teal-400 focus:ring-2"
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="block min-w-0 text-sm text-slate-200">
          Namespace
          <select
            value={namespace}
            onChange={(input) => setNamespace(input.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-teal-400 focus:ring-2"
          >
            {namespaces.length === 0 ? <option value="">No namespaces</option> : null}
            {namespaces.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0 text-sm text-slate-200">
          Kind
          <select
            value={resourceKind}
            onChange={(input) => setResourceKind(input.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-teal-400 focus:ring-2"
          >
            <option value="Pod">Pod</option>
            <option value="Service">Service</option>
          </select>
        </label>
        <label className="block min-w-0 text-sm text-slate-200">
          Name
          <select
            value={resourceName}
            onChange={(input) => setResourceName(input.target.value)}
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-teal-400 focus:ring-2"
          >
            {names.length === 0 ? <option value="">No resources</option> : null}
            {names.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-4 rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-[#042f2e] disabled:opacity-60"
      >
        {pending ? "Starting" : "Start investigation"}
      </button>
    </form>
  );
}
