/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, expect, it } from "vitest";

describe("Atlas Improvements", () => {
  describe("User Atlas Prompt", () => {
    it("should include instructions for fact vs assumption distinction", () => {
      const fs = require("fs");
      const path = require("path");
      const userAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-user.ts"),
        "utf8",
      );

      // Check that key improvements are present in the prompt
      expect(userAtlasContent).toContain(
        "Only include information the user explicitly stated",
      );
      expect(userAtlasContent).toContain(
        "Never include assistant speculation or assumptions",
      );
      expect(userAtlasContent).toContain(
        "Include specific dates (YYYY-MM-DD)",
      );
      expect(userAtlasContent).toContain(
        "Update immediately if the user corrects or contradicts",
      );
      expect(userAtlasContent).toContain(
        "Aggressively prune completed or obsolete items",
      );
    });
  });

  describe("Assistant Atlas Prompt", () => {
    it("should include instructions for observations vs assumptions", () => {
      const fs = require("fs");
      const path = require("path");
      const assistantAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-assistant.ts"),
        "utf8",
      );

      // Check that key improvements are present in the prompt
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
  });

  describe("Date Format Validation", () => {
    it("should specify YYYY-MM-DD format consistently", () => {
      const fs = require("fs");
      const path = require("path");

      const userAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-user.ts"),
        "utf8",
      );
      const assistantAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-assistant.ts"),
        "utf8",
      );

      // Both files should specify the YYYY-MM-DD format
      expect(userAtlasContent).toContain("YYYY-MM-DD");
      expect(assistantAtlasContent).toContain("YYYY-MM-DD format");
    });
  });

  describe("Removal Guidance", () => {
    it("should provide specific timeframes for removal", () => {
      const fs = require("fs");
      const path = require("path");

      const userAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-user.ts"),
        "utf8",
      );
      const assistantAtlasContent = fs.readFileSync(
        path.join(__dirname, "atlas-assistant.ts"),
        "utf8",
      );

      // Should specify timeframes for removal
      expect(userAtlasContent).toContain("more than a week");
      expect(assistantAtlasContent).toContain("14+ days");
      expect(assistantAtlasContent).toContain("30+ days");

      // Should favor removal when in doubt
      expect(userAtlasContent).toContain("Favor removal over retention");
    });
  });
});
