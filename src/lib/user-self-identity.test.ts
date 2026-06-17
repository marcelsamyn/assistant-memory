import { describe, expect, it } from "vitest";
import {
  buildUserIdentityNote,
  distinguishingAliases,
  selectPrimarySelfLabel,
} from "./user-self-identity";

describe("selectPrimarySelfLabel", () => {
  it("picks the alias with the most tokens", () => {
    expect(selectPrimarySelfLabel(["Marcel", "Marcel Samyn"])).toBe(
      "Marcel Samyn",
    );
  });

  it("returns null when only single-token aliases are present", () => {
    expect(selectPrimarySelfLabel(["Marcel"])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectPrimarySelfLabel([])).toBeNull();
  });

  it("prefers the longest string when token counts tie", () => {
    expect(selectPrimarySelfLabel(["Jo Lee", "Joanna Lee"])).toBe("Joanna Lee");
  });
});

describe("distinguishingAliases", () => {
  it("keeps only multi-token aliases, de-duplicated by normalized form", () => {
    expect(
      distinguishingAliases(["Marcel", "Marcel Samyn", "marcel samyn"]),
    ).toEqual(["Marcel Samyn"]);
  });

  it("drops bare single-token names", () => {
    expect(distinguishingAliases(["Marcel", "MS"])).toEqual([]);
  });
});

describe("buildUserIdentityNote", () => {
  it("returns null when there are no aliases", () => {
    expect(buildUserIdentityNote([])).toBeNull();
  });

  it("names the primary, lists aliases, and warns against conflation", () => {
    const note = buildUserIdentityNote(["Marcel", "Marcel Samyn"]);
    expect(note).toContain("Marcel Samyn");
    expect(note).toContain("most specific");
    expect(note).toContain("share a first name");
  });
});
