import type { GrantFormState } from "./-grant-form";
import type { Grants } from "@/shared/lib/registry/types";
import { describe, expect, it } from "vitest";
import { emptyGrantForm, expiresAt, EXPIRY_PRESETS, fromWire, isEmpty, isExpired, packageKey, toWire } from "./-grant-form";

const OWNED = [
  { namespace: "abcd1234", slug: "app" },
  { namespace: "abcd1234", slug: "cli" },
  { namespace: "abcd1234", slug: "docs" },
];

function state(patch: Partial<GrantFormState>): GrantFormState {
  return { ...emptyGrantForm(), ...patch };
}

describe("packageKey", () => {
  it("joins the namespace and the slug", () => {
    expect(packageKey({ namespace: "abcd1234", slug: "app" })).toBe("abcd1234/app");
  });
});

describe("emptyGrantForm", () => {
  it("starts with the switch off, the weakest level and no row", () => {
    expect(emptyGrantForm()).toEqual({ all: false, allLevel: "read", perPackage: {} });
  });
});

describe("toWire", () => {
  it("sends the all-packages form when the switch is on", () => {
    expect(toWire(state({ all: true, allLevel: "write" }))).toEqual({ all: "write" });
  });

  it("lets the switch win over the per-package rows", () => {
    const form = state({ all: true, allLevel: "admin", perPackage: { "abcd1234/app": "read" } });
    expect(toWire(form)).toEqual({ all: "admin" });
  });

  it("lists the rows that carry a level and drops the \"none\" rows", () => {
    const form = state({
      perPackage: { "abcd1234/app": "read", "abcd1234/cli": "none", "abcd1234/docs": "admin" },
    });
    expect(toWire(form)).toEqual([
      { package: "abcd1234/app", access: "read" },
      { package: "abcd1234/docs", access: "admin" },
    ]);
  });

  it("ignores the all-packages level while the switch is off", () => {
    expect(toWire(state({ all: false, allLevel: "admin" }))).toEqual([]);
  });
});

describe("fromWire", () => {
  it("turns the switch on for the all-packages form and leaves every row at none", () => {
    expect(fromWire({ all: "write" }, OWNED)).toEqual({
      all: true,
      allLevel: "write",
      perPackage: { "abcd1234/app": "none", "abcd1234/cli": "none", "abcd1234/docs": "none" },
    });
  });

  it("gives every owned package a row, none where the token has no grant", () => {
    const grants: Grants = [{ package: "abcd1234/cli", access: "write" }];
    expect(fromWire(grants, OWNED)).toEqual({
      all: false,
      allLevel: "read",
      perPackage: { "abcd1234/app": "none", "abcd1234/cli": "write", "abcd1234/docs": "none" },
    });
  });

  it("drops a grant naming a package that no longer exists", () => {
    const grants: Grants = [
      { package: "abcd1234/gone", access: "admin" },
      { package: "abcd1234/app", access: "read" },
    ];
    const form = fromWire(grants, OWNED);
    expect(form.perPackage).not.toHaveProperty("abcd1234/gone");
    expect(toWire(form)).toEqual([{ package: "abcd1234/app", access: "read" }]);
  });

  it("reads a token without grants as an empty form", () => {
    expect(fromWire([], [])).toEqual(emptyGrantForm());
  });
});

describe("round trips", () => {
  it.each<[string, Grants]>([
    ["no grant", []],
    ["all packages", { all: "admin" }],
    ["a list in package order", [
      { package: "abcd1234/app", access: "read" },
      { package: "abcd1234/docs", access: "write" },
    ]],
  ])("keeps %s through fromWire and toWire", (_name, grants) => {
    expect(toWire(fromWire(grants, OWNED))).toEqual(grants);
  });

  it("keeps a form through toWire and fromWire", () => {
    const form = fromWire([{ package: "abcd1234/cli", access: "admin" }], OWNED);
    expect(fromWire(toWire(form), OWNED)).toEqual(form);
  });
});

describe("isEmpty", () => {
  it("is true for a fresh form", () => {
    expect(isEmpty(emptyGrantForm())).toBe(true);
  });

  it("is true when every row is none", () => {
    expect(isEmpty(state({ perPackage: { "abcd1234/app": "none" } }))).toBe(true);
  });

  it("is false with the switch on", () => {
    expect(isEmpty(state({ all: true }))).toBe(false);
  });

  it("is false when a row carries a level", () => {
    expect(isEmpty(state({ perPackage: { "abcd1234/app": "none", "abcd1234/cli": "read" } }))).toBe(false);
  });
});

describe("expiresAt", () => {
  const now = new Date("2026-01-15T10:30:00.000Z");

  it("offers day presets and no expiry", () => {
    expect(EXPIRY_PRESETS).toEqual(["30d", "90d", "365d", "never"]);
  });

  it("is null for no expiry", () => {
    expect(expiresAt("never", now)).toBeNull();
  });

  it.each([
    ["30d", "2026-02-14T10:30:00.000Z"],
    ["90d", "2026-04-15T10:30:00.000Z"],
    ["365d", "2027-01-15T10:30:00.000Z"],
  ] as const)("adds %s to now as an ISO 8601 instant with an offset", (preset, expected) => {
    expect(expiresAt(preset, now)).toBe(expected);
  });

  it("does not move the injected now", () => {
    expiresAt("30d", now);
    expect(now.toISOString()).toBe("2026-01-15T10:30:00.000Z");
  });
});

describe("isExpired", () => {
  const now = Date.parse("2026-01-15T10:30:00.000Z");

  it("is false for a token that never expires", () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it("is false before the expiry and true from it on", () => {
    expect(isExpired("2026-01-15T10:30:00.001Z", now)).toBe(false);
    expect(isExpired("2026-01-15T10:30:00.000Z", now)).toBe(true);
    expect(isExpired("2025-12-31T00:00:00.000Z", now)).toBe(true);
  });
});
