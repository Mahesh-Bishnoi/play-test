import type { Suite } from "../../../shared/schema.js";

interface Props {
  suites: Suite[];
  suiteId: string | null;
  onSelect: (id: string) => void;
  onRequestDelete: (suite: Suite) => void;
}

/** Suite pills: pick one for membership/run work, or delete it (confirm first). */
export default function SuiteListCard({
  suites,
  suiteId,
  onSelect,
  onRequestDelete,
}: Props): React.JSX.Element {
  return (
    <div className="pt-card">
      <div className="pt-section-head">
        <h3 className="pt-toolbar-title">Suites</h3>
        <span className="pt-count">{suites.length} in project</span>
      </div>
      {suites.length === 0 ? (
        <p className="pt-empty">No suites yet — press + in the sidebar to create one.</p>
      ) : (
        <div className="pt-suite-pills">
          {suites.map((s) => (
            <span
              key={s.id}
              className={`pt-list-item pt-suite-pill${suiteId === s.id ? " pt-suite-pill-active" : ""}`}
            >
              <button
                type="button"
                className="pt-btn pt-btn-ghost pt-btn-sm"
                onClick={() => {
                  onSelect(s.id);
                }}
                aria-pressed={suiteId === s.id}
              >
                {s.name}
              </button>
              <button
                type="button"
                className="pt-btn pt-btn-danger-ghost pt-btn-sm"
                onClick={() => {
                  onRequestDelete(s);
                }}
                title={`Delete suite ${s.name} (asks first)`}
                aria-label={`Delete suite ${s.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="pt-hint pt-mt-8">
        New suites are created from the sidebar + — they appear here for membership and runs.
      </p>
    </div>
  );
}
