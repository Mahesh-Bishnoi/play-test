import { useEffect, useMemo, useState } from "react";

import type { Suite, TestCase } from "../../../shared/schema.js";
import { api, formatApiError } from "../../api.js";
import { filterCasesByKeyword } from "../../components/suite-run-filter.js";

export interface SuiteDetail {
  /** Project catalog + membership selection. */
  suites: Suite[];
  cases: TestCase[];
  memberIds: string[];
  checked: Set<string>;
  dirty: boolean;
  suiteId: string | null;
  selectedSuite: Suite | null;
  search: string;
  setSearch: (value: string) => void;
  visibleCases: TestCase[];
  allVisibleChecked: boolean;
  filterActive: boolean;
  filteredCheckedCount: number;
  error: string | null;
  notice: string | null;
  selectSuite: (id: string | null) => void;
  toggle: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  saveSelection: () => void;
  /** Delete confirms (owned here: they mutate the catalog above). */
  pendingDeleteSuite: Suite | null;
  pendingDeleteCase: TestCase | null;
  deleteBusy: boolean;
  requestDeleteSuite: (suite: Suite) => void;
  requestDeleteCase: (testCase: TestCase) => void;
  cancelDeleteSuite: () => void;
  cancelDeleteCase: () => void;
  confirmDeleteSuite: () => void;
  confirmDeleteCase: () => void;
  /** Import/export. */
  transferBusy: boolean;
  exportProject: () => void;
  exportSelectedSuite: () => void;
  importSuiteFile: () => void;
  importCaseFile: () => void;
  /** Suite runs. */
  runDialogOpen: boolean;
  runBusy: boolean;
  rerunBusy: boolean;
  runDialogCases: TestCase[];
  lastSuiteRunId: string | null;
  openRunDialog: (ids: string[]) => void;
  /** Snapshot the checked cases / the checked-and-visible ones for a run. */
  runChecked: () => void;
  runFiltered: () => void;
  closeRunDialog: () => void;
  confirmRunSuite: () => void;
  rerunLastFailed: () => void;
}

/**
 * State machine for SuiteDetailPage: the project's suites/cases, the selected
 * suite's membership edits, the import/export and run flows, and the delete
 * confirms. Kept in one hook so every mutation of the catalog lives next to the
 * loaders that refresh it — the page below is pure composition.
 */
export function useSuiteDetail(input: {
  projectId: string;
  focusedSuiteId?: string | null;
  refreshToken?: number;
  onSuiteFocus?: (suiteId: string | null) => void;
  onCaseDeleted?: (caseId: string) => void;
  onChanged?: () => void;
}): SuiteDetail {
  const { projectId, focusedSuiteId, refreshToken, onSuiteFocus, onCaseDeleted, onChanged } = input;

  const [suites, setSuites] = useState<Suite[]>([]);
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  /** Case ids snapshotted when the run dialog opens (all checked or filtered). */
  const [runCaseIds, setRunCaseIds] = useState<string[] | null>(null);
  const [lastSuiteRunId, setLastSuiteRunId] = useState<string | null>(null);
  const [pendingDeleteSuite, setPendingDeleteSuite] = useState<Suite | null>(null);
  const [pendingDeleteCase, setPendingDeleteCase] = useState<TestCase | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setSuiteId(null);
    setCases([]);
    setMemberIds([]);
    setChecked(new Set());
    setDirty(false);
    api
      .listSuites(projectId)
      .then((rows) => {
        setSuites([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
    api
      .listCases(projectId)
      .then((rows) => {
        setCases([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loadMembership = (id: string): void => {
    api
      .getSuiteDetail(id)
      .then((detail) => {
        setMemberIds(detail.caseIds);
        setChecked(new Set(detail.caseIds));
        setDirty(false);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
  };

  const selectSuite = (id: string | null): void => {
    setSuiteId(id);
    setNotice(null);
    setRunDialogOpen(false);
    setRunCaseIds(null);
    if (onSuiteFocus !== undefined) {
      onSuiteFocus(id);
    }
    if (id !== null) {
      loadMembership(id);
    } else {
      setMemberIds([]);
      setChecked(new Set());
      setDirty(false);
    }
  };

  useEffect(() => {
    if (refreshToken !== undefined && refreshToken > 0) {
      setError(null);
      api
        .listSuites(projectId)
        .then((rows) => {
          const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
          setSuites(sorted);
          if (suiteId !== null && !sorted.some((s) => s.id === suiteId)) {
            selectSuite(null);
          }
        })
        .catch((err: unknown) => {
          setError(formatApiError(err));
        });
      api
        .listCases(projectId)
        .then((rows) => {
          setCases([...rows].sort((a, b) => a.name.localeCompare(b.name)));
        })
        .catch((err: unknown) => {
          setError(formatApiError(err));
        });
      if (suiteId !== null) {
        loadMembership(suiteId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // IDE shell: explorer drives the focused suite.
  useEffect(() => {
    if (focusedSuiteId !== undefined && focusedSuiteId !== suiteId) {
      selectSuite(focusedSuiteId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSuiteId]);

  const confirmDeleteSuite = (): void => {
    if (pendingDeleteSuite === null) {
      return;
    }
    const id = pendingDeleteSuite.id;
    setDeleteBusy(true);
    api
      .deleteSuite(id)
      .then(() => {
        setSuites((prev) => prev.filter((s) => s.id !== id));
        if (suiteId === id) {
          selectSuite(null);
        }
        setPendingDeleteSuite(null);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const confirmDeleteCase = (): void => {
    if (pendingDeleteCase === null) {
      return;
    }
    const id = pendingDeleteCase.id;
    setDeleteBusy(true);
    api
      .deleteCase(id)
      .then(() => {
        setCases((prev) => prev.filter((c) => c.id !== id));
        setMemberIds((prev) => prev.filter((m) => m !== id));
        setChecked((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setPendingDeleteCase(null);
        onCaseDeleted?.(id);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const visibleCases = useMemo(() => filterCasesByKeyword(cases, search), [cases, search]);

  const allVisibleChecked = visibleCases.length > 0 && visibleCases.every((c) => checked.has(c.id));

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setDirty(true);
  };

  const selectAll = (): void => {
    setChecked((prev) => new Set([...prev, ...visibleCases.map((c) => c.id)]));
    setDirty(true);
  };

  const selectNone = (): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const c of visibleCases) {
        next.delete(c.id);
      }
      return next;
    });
    setDirty(true);
  };

  const saveSelection = (): void => {
    if (suiteId === null) {
      return;
    }
    const ids = [...checked];
    api
      .setSuiteCases(suiteId, ids)
      .then((saved) => {
        setMemberIds(saved);
        setChecked(new Set(saved));
        setDirty(false);
        setNotice(`Saved ${saved.length} case(s) in this suite.`);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
  };

  const selectedSuite = suites.find((s) => s.id === suiteId) ?? null;
  const filterActive = search.trim() !== "";
  const filteredChecked = visibleCases.filter((c) => checked.has(c.id));
  const runCaseIdSet = useMemo(() => new Set(runCaseIds ?? []), [runCaseIds]);
  const runDialogCases = cases.filter((c) => runCaseIdSet.has(c.id));

  /** Re-list everything after an import (new ids everywhere) + notify sidebar. */
  const reloadAfterTransfer = (keepSuiteId: string | null): void => {
    api
      .listSuites(projectId)
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        setSuites(sorted);
        if (keepSuiteId !== null && sorted.some((s) => s.id === keepSuiteId)) {
          loadMembership(keepSuiteId);
        }
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
    api
      .listCases(projectId)
      .then((rows) => {
        setCases([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
    onChanged?.();
  };

  const exportProject = (): void => {
    setError(null);
    setNotice(null);
    setTransferBusy(true);
    api
      .exportProject(projectId)
      .then((outcome) => {
        if (outcome.saved) {
          setNotice(`Project exported${outcome.path !== undefined ? ` to ${outcome.path}` : ""}.`);
        }
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setTransferBusy(false);
      });
  };

  const exportSelectedSuite = (): void => {
    if (selectedSuite === null) {
      return;
    }
    setError(null);
    setNotice(null);
    setTransferBusy(true);
    api
      .exportSuite(selectedSuite.id)
      .then((outcome) => {
        if (outcome.saved) {
          setNotice(
            `Suite “${selectedSuite.name}” exported${outcome.path !== undefined ? ` to ${outcome.path}` : ""}.`,
          );
        }
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setTransferBusy(false);
      });
  };

  const importSuiteFile = (): void => {
    setError(null);
    setNotice(null);
    setTransferBusy(true);
    api
      .importSuite(projectId)
      .then((outcome) => {
        if (outcome.imported && outcome.summary !== undefined) {
          const { caseCount, stepCount } = outcome.summary;
          setNotice(`Imported suite file: ${caseCount} case(s), ${stepCount} step(s).`);
          reloadAfterTransfer(suiteId);
        }
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setTransferBusy(false);
      });
  };

  const importCaseFile = (): void => {
    setError(null);
    setNotice(null);
    setTransferBusy(true);
    api
      .importCases(projectId, suiteId === null ? undefined : [suiteId])
      .then((outcome) => {
        if (outcome.imported && outcome.summary !== undefined) {
          const { caseCount, stepCount } = outcome.summary;
          setNotice(
            suiteId === null
              ? `Imported ${caseCount} case(s), ${stepCount} step(s) into the project.`
              : `Imported ${caseCount} case(s), ${stepCount} step(s) into “${selectedSuite?.name ?? "suite"}”.`,
          );
          reloadAfterTransfer(suiteId);
        }
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setTransferBusy(false);
      });
  };

  useEffect(() => {
    if (!runDialogOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !runBusy) {
        setRunDialogOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [runDialogOpen, runBusy]);

  const openRunDialog = (ids: string[]): void => {
    setRunCaseIds(ids);
    setRunDialogOpen(true);
  };

  const runChecked = (): void => {
    openRunDialog([...checked]);
  };

  const runFiltered = (): void => {
    openRunDialog(filteredChecked.map((c) => c.id));
  };

  const closeRunDialog = (): void => {
    if (!runBusy) {
      setRunDialogOpen(false);
    }
  };

  const confirmRunSuite = (): void => {
    if (selectedSuite === null || runCaseIds === null || runCaseIds.length === 0) {
      return;
    }
    setRunBusy(true);
    setNotice(null);
    api
      .runSuite(selectedSuite.id, runCaseIds)
      .then(({ suiteRunId: runId }) => {
        setLastSuiteRunId(runId);
        setRunDialogOpen(false);
        setRunCaseIds(null);
        setNotice(`Suite run started (${runCaseIds.length} case(s)). Report: ${runId}`);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  };

  const rerunLastFailed = (): void => {
    if (selectedSuite === null || rerunBusy) {
      return;
    }
    setError(null);
    setNotice(null);
    setRerunBusy(true);
    api
      .rerunLastFailed(selectedSuite.id)
      .then(({ suiteRunId: runId }) => {
        setLastSuiteRunId(runId);
        setNotice(`Re-running failed cases from the last finished run. Report: ${runId}`);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setRerunBusy(false);
      });
  };

  return {
    suites,
    cases,
    memberIds,
    checked,
    dirty,
    suiteId,
    selectedSuite,
    search,
    setSearch,
    visibleCases,
    allVisibleChecked,
    filterActive,
    filteredCheckedCount: filteredChecked.length,
    error,
    notice,
    selectSuite,
    toggle,
    selectAll,
    selectNone,
    saveSelection,
    pendingDeleteSuite,
    pendingDeleteCase,
    deleteBusy,
    requestDeleteSuite: setPendingDeleteSuite,
    requestDeleteCase: setPendingDeleteCase,
    cancelDeleteSuite: () => {
      if (!deleteBusy) {
        setPendingDeleteSuite(null);
      }
    },
    cancelDeleteCase: () => {
      if (!deleteBusy) {
        setPendingDeleteCase(null);
      }
    },
    confirmDeleteSuite,
    confirmDeleteCase,
    transferBusy,
    exportProject,
    exportSelectedSuite,
    importSuiteFile,
    importCaseFile,
    runDialogOpen,
    runBusy,
    rerunBusy,
    runDialogCases,
    lastSuiteRunId,
    openRunDialog,
    runChecked,
    runFiltered,
    closeRunDialog,
    confirmRunSuite,
    rerunLastFailed,
  };
}
