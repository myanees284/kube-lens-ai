import type { ListInvestigationsResponse } from "@kube-lens/contracts";
import { sourcePresentation, statusLabel } from "../lib/present.ts";

type Summary = ListInvestigationsResponse["items"][number];

export function HistoryList({
  items,
  selectedId,
  nextCursor,
  loadingMore,
  onSelect,
  onLoadMore,
}: {
  items: Summary[];
  selectedId: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-sm font-medium text-teal-300">Recent investigations</h2>
      {items.length === 0 ? <p className="mt-4 text-sm text-slate-400">No investigations yet.</p> : null}
      <ul className="mt-3 space-y-2">
        {items.map((item) => {
          const selected = item.investigationId === selectedId;
          return (
            <li key={item.investigationId}>
              <button
                type="button"
                onClick={() => onSelect(item.investigationId)}
                className={`w-full rounded-xl border px-3 py-3 text-left ${
                  selected ? "border-teal-500 bg-slate-950" : "border-slate-800 bg-slate-950/40 hover:border-slate-600"
                }`}
              >
                <span className="line-clamp-2 text-sm text-slate-100">{item.question}</span>
                <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <StatusText status={item.status} />
                  {item.rcaSource ? <span>{sourcePresentation(item.rcaSource).title}</span> : null}
                  <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {nextCursor ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-3 text-sm text-teal-300 disabled:opacity-60"
        >
          {loadingMore ? "Loading" : "Load older"}
        </button>
      ) : null}
    </section>
  );
}

export function StatusText({ status }: { status: Summary["status"] }) {
  const tone =
    status === "completed"
      ? "text-emerald-300"
      : status === "partial"
        ? "text-amber-300"
        : status === "failed"
          ? "text-rose-300"
          : status === "running"
            ? "text-teal-300"
            : "text-slate-300";
  return <span className={tone}>{statusLabel(status)}</span>;
}
