import { z } from "zod";

// Single source for step actions (PLAN §4). WS3/WS4/WS5 code against this.
export const STEP_ACTIONS = [
  "goto",
  "click",
  "dblclick",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "hover",
  "focus",
  "press",
  "assert-visible",
  "assert-hidden",
  "assert-text",
  "assert-value",
  "assert-checked",
  "assert-unchecked",
  "assert-enabled",
  "assert-disabled",
  "assert-editable",
  "assert-focused",
  "assert-count",
  "assert-url",
  "assert-title",
  "wait",
  // M15 additions (25 → 33): exact-match text, attributes, attachment, history
  // navigation, file upload, and drag-to-target.
  "assert-text-exact",
  "assert-attribute",
  "assert-attached",
  "reload",
  "go-back",
  "go-forward",
  "upload",
  "drag",
  // M17 additions (33 → 35): glob navigation wait and manual scroll.
  "wait-url",
  "scroll-into-view",
] as const;

export const StepActionSchema = z.enum(STEP_ACTIONS);
export type StepAction = z.infer<typeof StepActionSchema>;

// Node color mapping (PLAN §2): green=pass, red=fail, grey=skipped, blue=running.
export const STEP_STATUSES = ["pass", "fail", "skipped", "running"] as const;

export const StepStatusSchema = z.enum(STEP_STATUSES);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const TestStepSchema = z.object({
  id: z.string().min(1).optional(),
  caseId: z.string().min(1).optional(),
  order: z.number().int().min(0),
  action: StepActionSchema,
  selector: z.string().max(2000).optional(),
  value: z.string().max(10000).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

export type TestStep = z.infer<typeof TestStepSchema>;

/** Thrown at spec-gen time when a `{{key}}` has no entry in test_data (PLAN §10). */
export class MissingTestDataKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`missing test-data key: ${key}`);
    this.name = "MissingTestDataKeyError";
    this.key = key;
  }
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/**
 * Substitute `{{key}}` placeholders from test_data KV.
 * Pure: no IO, throws MissingTestDataKeyError on unknown key.
 */
export function substituteTestDataValue(template: string, data: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const found: string | undefined = data[key];
    if (found === undefined) {
      throw new MissingTestDataKeyError(key);
    }
    return found;
  });
}

/** All `{{key}}` names referenced by a template (for `{{key}}` hint UI in WS3). */
export function listTestDataKeys(template: string): string[] {
  const keys = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const key: string | undefined = match[1];
    if (key !== undefined) {
      keys.add(key);
    }
  }
  return [...keys];
}
