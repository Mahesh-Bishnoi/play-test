import type { Suite, TestCase } from "../../../shared/schema.js";

interface Props {
  selectedSuite: Suite | null;
  memberCount: number;
  visibleCases: TestCase[];
  search: string;
  onSearch: (value: string) => void;
  checked: Set<string>;
  allVisibleChecked: boolean;
  filterActive: boolean;
  filteredCheckedCount: number;
  dirty: boolean;
  rerunBusy: boolean;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onToggle: (id: string) => void;
  onSaveSelection: () => void;
  onRunChecked: () => void;
  onRunFiltered: () => void;
  onRerunFailed: () => void;
  onOpenCase?: (caseId: string, name?: string) => void;
  onRequestDeleteCase: (testCase: TestCase) => void;
  lastSuiteRunId: string | null;
  onViewReport?: (suiteRunId: string) => void;
}

/**
 * The cases card: search + select-all helpers, the membership table, and the
 * suite-run entry points. Membership edits are staged in `checked` and only
 * persisted by `onSaveSelection` (dirty until then).
 */
export default function CaseMembershipCard({
  selectedSuite,
  memberCount,
  visibleCases,
  search,
  onSearch,
  checked,
  allVisibleChecked,
  filterActive,
  filteredCheckedCount,
  dirty,
  rerunBusy,
  onSelectAll,
  onSelectNone,
  onToggle,
  onSaveSelection,
  onRunChecked,
  onRunFiltered,
  onRerunFailed,
  onOpenCase,
  onRequestDeleteCase,
  lastSuiteRunId,
  onViewReport,
}: Props): React.JSX.Element {
  return (
    <div className="pt-card">
      <div className="pt-section-head">
        <h3 className="pt-toolbar-title">
          {selectedSuite === null ? "All cases" : selectedSuite.name}
        </h3>
        {selectedSuite !== null && <span className="pt-count">{memberCount} in suite</span>}
      </div>
      <div className="pt-row pt-mb-12">
        <input
          aria-label="Search cases"
          className="pt-input pt-w-220"
          value={search}
          onChange={(e) => {
            onSearch(e.target.value);
          }}
          placeholder="Search cases"
        />
        <button type="button" className="pt-btn pt-btn-sm" onClick={onSelectAll}>
          Select all
        </button>
        <button type="button" className="pt-btn pt-btn-sm" onClick={onSelectNone}>
          Select none
        </button>
        {selectedSuite === null ? (
          <span className="pt-hint">Select a suite above to build membership.</span>
        ) : (
          <>
            <button
              type="button"
              className="pt-btn pt-btn-primary pt-btn-sm"
              onClick={onSaveSelection}
              disabled={!dirty}
            >
              Save selection
            </button>
            <button
              type="button"
              className="pt-btn pt-btn-sm"
              onClick={onRunChecked}
              disabled={checked.size === 0}
            >
              Run suite…
            </button>
            {filterActive && (
              <button
                type="button"
                className="pt-btn pt-btn-sm"
                onClick={onRunFiltered}
                disabled={filteredCheckedCount === 0}
                title="Run only the checked cases matching the current search filter"
              >
                Run filtered ({filteredCheckedCount})…
              </button>
            )}
            <button
              type="button"
              className="pt-btn pt-btn-sm"
              onClick={onRerunFailed}
              disabled={rerunBusy}
              title="Start a new run with the failed cases of this suite's latest finished run"
            >
              {rerunBusy ? "Starting…" : "Re-run last failed"}
            </button>
          </>
        )}
      </div>
      {visibleCases.length === 0 ? (
        <p className="pt-empty">No cases match the search.</p>
      ) : (
        <div className="pt-table-wrap">
          <table className="pt-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    className="pt-checkbox"
                    aria-label={
                      selectedSuite === null
                        ? "Select a suite above to build membership"
                        : allVisibleChecked
                          ? "Deselect all visible cases"
                          : "Select all visible cases"
                    }
                    title={
                      selectedSuite === null
                        ? "Select a suite above to build membership"
                        : undefined
                    }
                    checked={allVisibleChecked}
                    disabled={selectedSuite === null}
                    onChange={() => {
                      if (allVisibleChecked) {
                        onSelectNone();
                      } else {
                        onSelectAll();
                      }
                    }}
                  />
                </th>
                <th>Name</th>
                <th className="pt-text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleCases.map((c) => (
                <tr key={c.id} className={checked.has(c.id) ? "pt-row-selected" : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      className="pt-checkbox"
                      aria-label={`Include case ${c.name} in ${selectedSuite?.name ?? "suite"}`}
                      title={
                        selectedSuite === null
                          ? "Select a suite above to build membership"
                          : `Include case ${c.name} in ${selectedSuite.name}`
                      }
                      checked={checked.has(c.id)}
                      disabled={selectedSuite === null}
                      onChange={() => {
                        onToggle(c.id);
                      }}
                    />
                  </td>
                  <td>{c.name}</td>
                  <td className="pt-text-end">
                    <span className="pt-table-actions">
                      {onOpenCase !== undefined && (
                        <button
                          type="button"
                          className="pt-btn pt-btn-sm"
                          onClick={() => {
                            onOpenCase(c.id, c.name);
                          }}
                          aria-label={`Open case ${c.name} in workflow editor`}
                        >
                          Open
                        </button>
                      )}
                      <button
                        type="button"
                        className="pt-btn pt-btn-danger-ghost pt-btn-sm"
                        title={`Delete case ${c.name} (asks first)`}
                        aria-label={`Delete case ${c.name}`}
                        onClick={() => {
                          onRequestDeleteCase(c);
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastSuiteRunId !== null && onViewReport !== undefined && (
        <div className="pt-mt-12">
          <button
            type="button"
            className="pt-btn pt-btn-sm"
            onClick={() => {
              onViewReport(lastSuiteRunId);
            }}
          >
            View last report
          </button>
        </div>
      )}
    </div>
  );
}
