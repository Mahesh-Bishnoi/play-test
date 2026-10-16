import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import type { TestStep } from "../shared/step-types.js";
import type {
  StepDeletePayload,
  StepMovePayload,
  StepReorderPayload,
  StepUpsertPayload,
  TestDataGetPayload,
  TestDataSetPayload,
} from "../shared/ipc-contract.js";
import {
  StepDeletePayload as StepDeleteSchema,
  StepMovePayload as StepMoveSchema,
  StepReorderPayload as StepReorderSchema,
  StepUpsertPayload as StepUpsertSchema,
  TestDataGetPayload as TestDataGetSchema,
  TestDataSetPayload as TestDataSetSchema,
} from "../shared/ipc-contract.js";
import type { StepRow } from "../shared/schema.js";
import { StepRowSchema } from "../shared/schema.js";
import type { AppDatabase } from "./db.js";
import { CaseNotFoundError } from "./ipc-cases.js";
import { testCases, testData, testSteps } from "./schema.js";

/** Thrown when a step id has no row in the given case. */
export class StepNotFoundError extends Error {
  readonly stepId: string;
  constructor(stepId: string) {
    super(`step not found: ${stepId}`);
    this.name = "StepNotFoundError";
    this.stepId = stepId;
  }
}

interface StepDbRow {
  id: string;
  caseId: string;
  order: number;
  action: string;
  selector: string | null;
  value: string | null;
  timeoutMs: number | null;
  editedAt: number;
}

function toStepRow(row: StepDbRow): StepRow {
  return StepRowSchema.parse(
    row.selector === null && row.value === null && row.timeoutMs === null
      ? {
          id: row.id,
          caseId: row.caseId,
          order: row.order,
          action: row.action,
          editedAt: row.editedAt,
        }
      : {
          id: row.id,
          caseId: row.caseId,
          order: row.order,
          action: row.action,
          ...(row.selector !== null ? { selector: row.selector } : {}),
          ...(row.value !== null ? { value: row.value } : {}),
          ...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
          editedAt: row.editedAt,
        },
  );
}

function requireCase(db: AppDatabase, caseId: string): void {
  const rows = db
    .select({ id: testCases.id })
    .from(testCases)
    .where(eq(testCases.id, caseId))
    .all();
  if (rows[0] === undefined) {
    throw new CaseNotFoundError(caseId);
  }
}

function loadOrdered(db: AppDatabase, caseId: string): StepDbRow[] {
  return db
    .select()
    .from(testSteps)
    .where(eq(testSteps.caseId, caseId))
    .orderBy(asc(testSteps.order))
    .all();
}

function persistOrder(
  db: AppDatabase,
  rows: StepDbRow[],
  editedId?: string,
  editedAt?: number,
): void {
  rows.forEach((row, index) => {
    const patch: { order: number; editedAt?: number } = { order: index };
    if (row.id === editedId && editedAt !== undefined) {
      patch.editedAt = editedAt;
    }
    db.update(testSteps).set(patch).where(eq(testSteps.id, row.id)).run();
  });
}

/** All steps of a case in execution order. Used by case:get envelopes + WS5 spec-gen. */
export function listSteps(db: AppDatabase, caseId: string): StepRow[] {
  requireCase(db, caseId);
  return loadOrdered(db, caseId).map(toStepRow);
}

/**
 * Create or update a step. New steps (or order changes) shift existing steps
 * at/after the target order down so `order` stays dense (0..n-1).
 */
export function upsertStep(db: AppDatabase, input: StepUpsertPayload): StepRow {
  const parsed = StepUpsertSchema.parse(input);
  requireCase(db, parsed.caseId);
  const step: TestStep = parsed.step;
  const now = Date.now();

  if (step.id !== undefined) {
    const existing = db.select().from(testSteps).where(eq(testSteps.id, step.id)).all()[0];
    if (existing !== undefined) {
      if (existing.caseId !== parsed.caseId) {
        throw new Error(`step belongs to a different case: ${step.id}`);
      }
      if (step.order === existing.order) {
        db.update(testSteps)
          .set({
            action: step.action,
            selector: step.selector ?? null,
            value: step.value ?? null,
            timeoutMs: step.timeoutMs ?? null,
            editedAt: now,
          })
          .where(eq(testSteps.id, existing.id))
          .run();
        const updated = db.select().from(testSteps).where(eq(testSteps.id, existing.id)).all()[0];
        if (updated === undefined) {
          throw new StepNotFoundError(existing.id);
        }
        return toStepRow(updated);
      }
      // Order changed: delete then reinsert at the new position (same id).
      db.delete(testSteps).where(eq(testSteps.id, existing.id)).run();
      insertStepAt(db, parsed.caseId, step.id, step, step.order, now);
      return readStep(db, step.id);
    }
    insertStepAt(db, parsed.caseId, step.id, step, step.order, now);
    return readStep(db, step.id);
  }

  const id = randomUUID();
  insertStepAt(db, parsed.caseId, id, step, step.order, now);
  return readStep(db, id);
}

/** Shift successors down, then insert the row at the clamped target order. */
function insertStepAt(
  db: AppDatabase,
  caseId: string,
  id: string,
  step: TestStep,
  order: number,
  now: number,
): void {
  const rows = loadOrdered(db, caseId);
  const target = Math.min(Math.max(order, 0), rows.length);
  for (let i = rows.length - 1; i >= target; i--) {
    const row = rows[i] as StepDbRow;
    db.update(testSteps)
      .set({ order: i + 1 })
      .where(eq(testSteps.id, row.id))
      .run();
  }
  db.insert(testSteps)
    .values({
      id,
      caseId,
      order: target,
      action: step.action,
      selector: step.selector ?? null,
      value: step.value ?? null,
      timeoutMs: step.timeoutMs ?? null,
      editedAt: now,
    })
    .run();
}

function readStep(db: AppDatabase, id: string): StepRow {
  const row = db.select().from(testSteps).where(eq(testSteps.id, id)).all()[0];
  if (row === undefined) {
    throw new StepNotFoundError(id);
  }
  return toStepRow(row);
}

/** Move a step to `toOrder`, shifting the range between. Returns the moved step. */
export function moveStep(db: AppDatabase, input: StepMovePayload): StepRow {
  const parsed = StepMoveSchema.parse(input);
  requireCase(db, parsed.caseId);
  const rows = loadOrdered(db, parsed.caseId);
  const from = rows.findIndex((r) => r.id === parsed.id);
  if (from === -1) {
    throw new StepNotFoundError(parsed.id);
  }
  const target = Math.min(Math.max(parsed.toOrder, 0), rows.length - 1);
  const now = Date.now();
  if (from !== target) {
    const [moving] = rows.splice(from, 1);
    if (moving === undefined) {
      throw new StepNotFoundError(parsed.id);
    }
    rows.splice(target, 0, moving);
    persistOrder(db, rows, moving.id, now);
  }
  const moved = db.select().from(testSteps).where(eq(testSteps.id, parsed.id)).all()[0];
  if (moved === undefined) {
    throw new StepNotFoundError(parsed.id);
  }
  return toStepRow(moved);
}

/** Delete a step and compact the remaining orders to 0..n-1. */
export function deleteStep(db: AppDatabase, input: StepDeletePayload): void {
  const parsed = StepDeleteSchema.parse(input);
  requireCase(db, parsed.caseId);
  const existing = db.select().from(testSteps).where(eq(testSteps.id, parsed.id)).all()[0];
  if (existing === undefined || existing.caseId !== parsed.caseId) {
    throw new StepNotFoundError(parsed.id);
  }
  db.delete(testSteps).where(eq(testSteps.id, parsed.id)).run();
  persistOrder(db, loadOrdered(db, parsed.caseId));
}

/**
 * Replace the full order from the UI drag-reorder. The id set must match
 * exactly — no drops, no foreign ids. Returns the reordered rows.
 */
export function reorderSteps(db: AppDatabase, input: StepReorderPayload): StepRow[] {
  const parsed = StepReorderSchema.parse(input);
  requireCase(db, parsed.caseId);
  const rows = loadOrdered(db, parsed.caseId);
  const known = new Set(rows.map((r) => r.id));
  if (parsed.orderedIds.length !== rows.length || !parsed.orderedIds.every((id) => known.has(id))) {
    throw new Error("orderedIds must match the case's step ids exactly");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = parsed.orderedIds.map((id) => byId.get(id) as StepDbRow);
  persistOrder(db, next);
  return loadOrdered(db, parsed.caseId).map(toStepRow);
}

/** KV test data for a case as a plain record (PLAN §10). */
export function getTestData(db: AppDatabase, input: TestDataGetPayload): Record<string, string> {
  const parsed = TestDataGetSchema.parse(input);
  requireCase(db, parsed.caseId);
  const rows = db.select().from(testData).where(eq(testData.caseId, parsed.caseId)).all();
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.key] = r.value;
  }
  return out;
}

/** Replace all KV rows for a case (source='kv' in MVP). Returns the stored record. */
export function setTestData(db: AppDatabase, input: TestDataSetPayload): Record<string, string> {
  const parsed = TestDataSetSchema.parse(input);
  requireCase(db, parsed.caseId);
  db.delete(testData).where(eq(testData.caseId, parsed.caseId)).run();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    db.insert(testData).values({ caseId: parsed.caseId, key, value, source: "kv" }).run();
    out[key] = value;
  }
  return out;
}
