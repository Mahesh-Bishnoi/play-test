import { describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import {
  CaseCreatePayload,
  CaseUpdatePayload,
  ProjectCreatePayload,
  ProjectUpdatePayload,
} from "../src/shared/ipc-contract.js";
import { ExportFileSchema } from "../src/shared/export-format.js";
import { HttpUrlSchema } from "../src/shared/schema.js";
import { SnapshotCaseSchema, SnapshotProjectSchema } from "../src/main/git-sync/snapshot.js";
import { buildCodegenArgs } from "../src/main/recorder/codegen-args.js";
import { createDatabase } from "../src/main/db.js";
import { createCase, updateCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { resolveRecorderStartOptions } from "../src/main/ipc/recorder.js";

const BAD_URLS = [
  "--save-storage=/tmp/steal.json",
  "--proxy-server=http://evil.test:8080",
  "file:///etc/passwd",
  "/login",
  "//evil.test",
  "not a url",
];

describe("HTTP URL validation (review F2)", () => {
  it("accepts http(s) URLs (including query strings) and the empty value", () => {
    for (const value of [
      "https://example.com",
      "http://localhost:4137/login?a=1&b=2",
      "HTTPS://EXAMPLE.COM/x",
      "",
    ]) {
      expect(HttpUrlSchema.parse(value)).toBe(value.trim());
    }
  });

  it("rejects flags, non-http schemes and relative paths", () => {
    for (const value of BAD_URLS) {
      expect(() => HttpUrlSchema.parse(value)).toThrow();
    }
  });

  it("applies at every write boundary", () => {
    expect(() =>
      ProjectCreatePayload.parse({ name: "P", baseUrl: "--save-storage=/tmp/x" }),
    ).toThrow();
    expect(() => ProjectUpdatePayload.parse({ id: "p1", baseUrl: "file:///tmp/x" })).toThrow();
    expect(() =>
      CaseCreatePayload.parse({ projectId: "p1", name: "C", url: "--proxy-server=x" }),
    ).toThrow();
    expect(() => CaseUpdatePayload.parse({ id: "c1", url: "/relative" })).toThrow();
    // Clearing stays possible.
    expect(CaseUpdatePayload.parse({ id: "c1", url: null }).url).toBeNull();
    expect(CaseUpdatePayload.parse({ id: "c1", url: "  " }).url).toBe("");
  });

  it("applies to export files and sync snapshots", () => {
    const file = {
      format: "playtest-export",
      version: 1,
      exportedAt: 1,
      scope: "case",
      suites: [],
      cases: [
        {
          name: "C",
          url: "--save-storage=/tmp/x",
          steps: [],
          testData: {},
        },
      ],
    };
    expect(() => ExportFileSchema.parse(file)).toThrow();
    expect(() =>
      SnapshotCaseSchema.parse({
        id: "c1",
        name: "C",
        url: "file:///tmp/x",
        steps: [],
      }),
    ).toThrow();
    expect(() =>
      SnapshotProjectSchema.parse({ id: "p1", name: "P", baseUrl: "--proxy-server=x" }),
    ).toThrow();
  });

  it("rejects a flag-shaped URL in the codegen argv builder", () => {
    expect(() => buildCodegenArgs("--save-storage=/tmp/x", "/tmp/out.js", {})).toThrow(
      /http\(s\) URL/,
    );
    expect(() => buildCodegenArgs("", "/tmp/out.js", {})).toThrow(/codegen URL is required/);
    expect(() => buildCodegenArgs("file:///tmp/page.html", "/tmp/out.js", {})).toThrow(
      /http\(s\) URL/,
    );
    // A URL with a query string stays one argv element (no shell involved).
    expect(buildCodegenArgs("http://localhost:4137/?a=1&b=2", "/tmp/out.js", {})).toEqual([
      "http://localhost:4137/?a=1&b=2",
      "--output",
      "/tmp/out.js",
    ]);
  });

  it("rejects legacy bad URLs at recorder start, before any spawn", () => {
    const handle = createDatabase(":memory:");
    try {
      const project = createProject(handle.db, { name: "P", baseUrl: "https://project.test" });
      const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
      // Simulate a row written before validation existed.
      handle.db.run(
        sql`UPDATE test_cases SET url = ${"--save-storage=/tmp/x"} WHERE id = ${testCase.id}`,
      );
      expect(() => resolveRecorderStartOptions(handle.db, "/tmp/playtest", testCase.id)).toThrow(
        /http\(s\) URL/,
      );
      updateCase(handle.db, { id: testCase.id, url: "https://case.test/login" });
      expect(resolveRecorderStartOptions(handle.db, "/tmp/playtest", testCase.id).baseUrl).toBe(
        "https://case.test/login",
      );
    } finally {
      handle.close();
    }
  });
});
