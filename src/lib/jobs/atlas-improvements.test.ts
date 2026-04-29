/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, expect, it } from "vitest";

// The User Atlas job was rewritten in Phase 3.4 to a registry-driven, claims-
// derived synthesis. Its prompt is exercised by `atlas-user.test.ts`. The
// remaining assertions here cover the assistant-atlas job, which still uses
// the legacy daily-summary prompt shape.
describe("Atlas Improvements", () => {
  describe("Assistant Atlas Prompt", () => {
    it("should include instructions for observations vs assumptions", () => {
      const fs = require("fs");
      const path = require("path");
      const assistantAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-assistant.ts"),
        "utf8",
      );

      expect(assistantAtlasContent).toContain(
        "Record only what can be directly observed from interactions",
      );
      expect(assistantAtlasContent).toContain(
        "Avoid storing assumptions, guesses, or interpretations as established facts",
      );
      expect(assistantAtlasContent).toContain(
        "MANDATORY:** Include the date (YYYY-MM-DD format)",
      );
      expect(assistantAtlasContent).toContain(
        "Actively remove outdated relationship patterns",
      );
      expect(assistantAtlasContent).toContain(
        "Date Tracking:** When adding or updating any entry",
      );
    });

    it("should specify YYYY-MM-DD format and removal timeframes", () => {
      const fs = require("fs");
      const path = require("path");

      const assistantAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-assistant.ts"),
        "utf8",
      );

      expect(assistantAtlasContent).toContain("YYYY-MM-DD format");
      expect(assistantAtlasContent).toContain("14+ days");
      expect(assistantAtlasContent).toContain("30+ days");
    });
  });
});
