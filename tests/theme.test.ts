import { afterEach, describe, expect, it } from "vitest";

import { applyTheme, getInitialTheme, isAppTheme } from "../src/renderer/theme.js";

function stubStorage(value: string | null, throwing = false): void {
  const store = {
    getItem: (): string | null => {
      if (throwing) {
        throw new Error("storage blocked");
      }
      return value;
    },
    setItem: (): void => {
      if (throwing) {
        throw new Error("storage blocked");
      }
    },
  };
  (globalThis as unknown as { window: { localStorage: unknown } }).window = {
    localStorage: store,
  };
  (
    globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }
  ).document = {
    documentElement: { dataset: {} },
  };
}

function dataset(): Record<string, string> {
  return (
    globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }
  ).document.documentElement.dataset;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

describe("theme persistence (syntax-light opt-in, dark stays default)", () => {
  it("accepts only the two known themes", () => {
    expect(isAppTheme("intellij-dark")).toBe(true);
    expect(isAppTheme("syntax-light")).toBe(true);
    expect(isAppTheme("dracula")).toBe(false);
    expect(isAppTheme(null)).toBe(false);
  });

  it("defaults to intellij-dark when nothing is stored", () => {
    stubStorage(null);
    expect(getInitialTheme()).toBe("intellij-dark");
  });

  it("restores a stored syntax-light choice", () => {
    stubStorage("syntax-light");
    expect(getInitialTheme()).toBe("syntax-light");
  });

  it("falls back to dark on unknown values and blocked storage", () => {
    stubStorage("midnight");
    expect(getInitialTheme()).toBe("intellij-dark");
    stubStorage("syntax-light", true);
    expect(getInitialTheme()).toBe("intellij-dark");
  });

  it("applies the theme to <html> and persists it", () => {
    stubStorage(null);
    applyTheme("syntax-light");
    expect(dataset().theme).toBe("syntax-light");
  });

  it("applyTheme never throws when storage is blocked", () => {
    stubStorage(null, true);
    expect(() => {
      applyTheme("syntax-light");
    }).not.toThrow();
    expect(dataset().theme).toBe("syntax-light");
  });
});
