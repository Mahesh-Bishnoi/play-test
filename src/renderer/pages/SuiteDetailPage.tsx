import ConfirmDialog from "../components/ConfirmDialog.js";
import CaseMembershipCard from "./suite-detail/CaseMembershipCard.js";
import RunSuiteDialog from "./suite-detail/RunSuiteDialog.js";
import SuiteListCard from "./suite-detail/SuiteListCard.js";
import { useSuiteDetail } from "./suite-detail/use-suite-detail.js";

interface Props {
  projectId: string;
  /** WS3 hook: open a case in the workflow editor (CaseDetailPage). */
  onOpenCase?: (caseId: string, name?: string) => void;
  /** IDE shell: prune the editor tab when its case is deleted here. */
  onCaseDeleted?: (caseId: string) => void;
  /** WS6 hook: open a suite-run report (RunReportPage). */
  onViewReport?: (suiteRunId: string) => void;
  /** IDE shell: suite focused in the Project explorer (controlled). */
  focusedSuiteId?: string | null;
  onSuiteFocus?: (suiteId: string | null) => void;
  /** IDE shell: bumped by sidebar CRUD so the main column reloads. */
  refreshToken?: number;
  /** IDE shell: notify the explorer to reload after CRUD. */
  onChanged?: () => void;
}

/**
 * Suite detail: membership + runs. Creation lives in the sidebar
 * (ProjectExplorer) so there is exactly one place to add suites/cases;
 * deletes stay here behind confirms, next to the membership they affect.
 */
export default function SuiteDetailPage({
  projectId,
  onOpenCase,
  onCaseDeleted,
  onViewReport,
  focusedSuiteId,
  onSuiteFocus,
  refreshToken,
  onChanged,
}: Props): React.JSX.Element {
  const s = useSuiteDetail({
    projectId,
    focusedSuiteId,
    refreshToken,
    onSuiteFocus,
    onCaseDeleted,
    onChanged,
  });

  const { selectedSuite } = s;

  return (
    <section aria-label="Suites and cases" className="pt-page">
      <div className="pt-topbar">
        <h2>Suites &amp; cases</h2>
        <span className="pt-badge">
          <span className="pt-badge-dot" aria-hidden="true" />
          {s.suites.length} suites
        </span>
        <span className="pt-badge pt-badge-mute">{s.cases.length} cases</span>
        {selectedSuite !== null && (
          <span className="pt-badge pt-badge-run">{s.memberIds.length} selected</span>
        )}
        {s.dirty && <span className="pt-badge pt-badge-fail">unsaved changes</span>}
        <span className="pt-spacer" />
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={s.exportProject}
          disabled={s.transferBusy}
          title="Export the whole project (suites, cases, steps, test data) to a .playtest.json file"
        >
          Export project
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={s.importSuiteFile}
          disabled={s.transferBusy}
          title="Import a suite file into this project (fresh ids, this project's base URL applies)"
        >
          Import suite…
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={s.importCaseFile}
          disabled={s.transferBusy}
          title={
            selectedSuite === null
              ? "Import a case file into this project"
              : `Import a case file into this project and add it to “${selectedSuite.name}”`
          }
        >
          Import cases…
        </button>
        {selectedSuite !== null && (
          <button
            type="button"
            className="pt-btn pt-btn-ghost pt-btn-sm"
            onClick={s.exportSelectedSuite}
            disabled={s.transferBusy}
            title={`Export suite “${selectedSuite.name}” (members, steps, test data) to a .playtest.json file`}
          >
            Export suite
          </button>
        )}
      </div>
      {s.error !== null && (
        <p role="alert" className="pt-alert pt-alert-error">
          {s.error}
        </p>
      )}
      {s.notice !== null && (
        <p role="status" className="pt-alert pt-alert-ok">
          {s.notice}
        </p>
      )}

      <SuiteListCard
        suites={s.suites}
        suiteId={s.suiteId}
        onSelect={s.selectSuite}
        onRequestDelete={s.requestDeleteSuite}
      />

      <div className="pt-section-head pt-mb-0">
        <h3 className="pt-toolbar-title">Cases</h3>
        <span className="pt-count">{s.cases.length} in project</span>
        <span className="pt-spacer" />
        <span className="pt-hint">
          New cases are added from the sidebar (per-suite “+ Add case”).
        </span>
      </div>
      {s.cases.length === 0 && (
        <p className="pt-empty">No cases yet — use “+ Add case” under a suite in the sidebar.</p>
      )}

      {s.cases.length > 0 && (
        <CaseMembershipCard
          selectedSuite={selectedSuite}
          memberCount={s.memberIds.length}
          visibleCases={s.visibleCases}
          search={s.search}
          onSearch={s.setSearch}
          checked={s.checked}
          allVisibleChecked={s.allVisibleChecked}
          filterActive={s.filterActive}
          filteredCheckedCount={s.filteredCheckedCount}
          dirty={s.dirty}
          rerunBusy={s.rerunBusy}
          onSelectAll={s.selectAll}
          onSelectNone={s.selectNone}
          onToggle={s.toggle}
          onSaveSelection={s.saveSelection}
          onRunChecked={s.runChecked}
          onRunFiltered={s.runFiltered}
          onRerunFailed={s.rerunLastFailed}
          onOpenCase={onOpenCase}
          onRequestDeleteCase={s.requestDeleteCase}
          lastSuiteRunId={s.lastSuiteRunId}
          onViewReport={onViewReport}
        />
      )}

      {s.runDialogOpen && selectedSuite !== null && (
        <RunSuiteDialog
          suiteName={selectedSuite.name}
          cases={s.runDialogCases}
          busy={s.runBusy}
          onCancel={s.closeRunDialog}
          onConfirm={s.confirmRunSuite}
        />
      )}

      {s.pendingDeleteSuite !== null && (
        <ConfirmDialog
          title={`Delete suite “${s.pendingDeleteSuite.name}”?`}
          body="The suite is removed. Its cases stay in the project and can join other suites."
          confirmLabel={`Delete ${s.pendingDeleteSuite.name}`}
          busy={s.deleteBusy}
          onConfirm={s.confirmDeleteSuite}
          onCancel={s.cancelDeleteSuite}
        />
      )}
      {s.pendingDeleteCase !== null && (
        <ConfirmDialog
          title={`Delete case “${s.pendingDeleteCase.name}”?`}
          body="This permanently deletes the case, its steps and its test data. Suite memberships update automatically. This cannot be undone."
          confirmLabel={`Delete ${s.pendingDeleteCase.name}`}
          busy={s.deleteBusy}
          onConfirm={s.confirmDeleteCase}
          onCancel={s.cancelDeleteCase}
        />
      )}
    </section>
  );
}
