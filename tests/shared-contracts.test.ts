import { describe, expect, it } from "vitest";

import {
  IPC_CHANNELS,
  IPC_PAYLOADS,
  StepMovePayload,
  SuiteSetCasesPayload,
  TestDataSetPayload,
} from "../src/shared/ipc-contract.js";
import {
  MissingTestDataKeyError,
  STEP_ACTIONS,
  TestStepSchema,
  listTestDataKeys,
  substituteTestDataValue,
} from "../src/shared/step-types.js";

describe("step-types substitution (PLAN §10)", () => {
  it("replaces {{key}} placeholders from KV data", () => {
    expect(substituteTestDataValue("hello {{name}}!", { name: "Ada" })).toBe("hello Ada!");
  });

  it("leaves templates without placeholders untouched", () => {
    expect(substituteTestDataValue("plain text", {})).toBe("plain text");
  });

  it("fails a step with a clear error on a missing key", () => {
    try {
      substituteTestDataValue("hi {{missing}}", {});
      expect.unreachable("must throw MissingTestDataKeyError");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTestDataKeyError);
      expect((err as Error).message).toBe("missing test-data key: missing");
    }
  });

  it("lists referenced keys for editor hints", () => {
    expect(listTestDataKeys("{{a}} and {{b}} and {{a}}").sort()).toEqual(["a", "b"]);
  });

  it("rejects unknown actions at the boundary", () => {
    expect(() => TestStepSchema.parse({ order: 0, action: "drag-and-drop" })).toThrow();
  });

  it("lists 33 actions including the M15 vocabulary", () => {
    expect(STEP_ACTIONS).toHaveLength(33);
    for (const action of [
      "assert-text-exact",
      "assert-attribute",
      "assert-attached",
      "reload",
      "go-back",
      "go-forward",
      "upload",
      "drag",
    ] as const) {
      expect(STEP_ACTIONS).toContain(action);
    }
  });
});

describe("frozen IPC contract v1 (PLAN §5)", () => {
  it("exposes every channel WS2–WS6 code against", () => {
    for (const channel of [
      "project:create",
      "suite:setCases",
      "step:upsert",
      "testdata:set",
      "recorder:start",
      "recorder:stop",
      "runner:runSingle",
      "runner:runSuite",
      "runner:resumeFromStep",
      "runner:rerunFailed",
      "runner:rerunLastFailed",
      "runner:cancel",
      "report:getHtml",
      "report:exportPdf",
      "report:openTrace",
      "transfer:exportProject",
      "transfer:exportSuite",
      "transfer:exportCase",
      "transfer:importProject",
      "transfer:importSuite",
      "transfer:importCase",
      "sync:init",
      "sync:commit",
      "sync:push",
      "sync:pull",
      "sync:status",
      "sync:branch",
      "sync:resolve",
      "sync:clone",
      "system:browserStatus",
      "system:installBrowser",
      "run:step-update",
      "run:log",
      "run:finished",
    ] as const) {
      expect(IPC_CHANNELS).toContain(channel);
    }
  });

  it("validates suite membership and step payloads", () => {
    expect(() =>
      SuiteSetCasesPayload.parse({ suiteId: "s1", caseIds: ["c1", "c2"] }),
    ).not.toThrow();
    expect(() => StepMovePayload.parse({ caseId: "c", id: "s", toOrder: -1 })).toThrow();
  });

  it("rejects test-data keys outside \\w+", () => {
    expect(() => TestDataSetPayload.parse({ caseId: "c", data: { "has-dash": "x" } })).toThrow();
  });

  it("has a payload schema for every request channel", () => {
    for (const channel of IPC_CHANNELS) {
      if (channel.startsWith("run:")) {
        continue;
      }
      expect(IPC_PAYLOADS[channel], channel).toBeDefined();
    }
  });
});
