/**
 * Pure-function tests for the cleanup prompt builder.
 *
 * The DB-integration apply path is covered by `cleanup-operations.test.ts`.
 * These tests pin the prompt structure so future tweaks to the operation
 * vocabulary, bundle layout, or provenance rendering are visible in diff
 * review without spinning up Postgres or stubbing the LLM client.
 */
import { buildCleanupPrompt, type TempSubgraph } from "./cleanup-graph";
import { describe, expect, it } from "vitest";
import type { ContextBundle } from "~/lib/context/types";
import { newTypeId } from "~/types/typeid";

function makeBundle(): ContextBundle {
  return {
    assembledAt: new Date("2026-04-30T00:00:00Z"),
    sections: [
      {
        kind: "atlas",
        content: "User lives in Antwerp; works at Acme.",
        usage: "Authoritative summary of who the user is right now.",
      },
      {
        kind: "open_commitments",
        content: "- Send spec to Bob (due 2026-05-01)",
        usage:
          "Tasks the user owes someone; do not infer pending work elsewhere.",
      },
      {
        kind: "preferences",
        content: "Prefers email over Slack.",
        usage: "Stable preferences. Honor them in suggestions.",
      },
    ],
  };
}

function makeTempSubgraph(): TempSubgraph {
  const claimUserSays = newTypeId("claim");
  const claimAssistantInferred = newTypeId("claim");
  return {
    nodes: [
      {
        id: newTypeId("node"),
        tempId: "temp_node_1",
        label: "Marcel",
        description: "User",
        type: "Person",
        evidenceClaimCount: 2,
        sourceLinkCount: 1,
        aliasCount: 0,
        deleteAllowed: false,
      },
      {
        id: newTypeId("node"),
        tempId: "temp_node_2",
        label: "Antwerp",
        description: "City",
        type: "Location",
        evidenceClaimCount: 2,
        sourceLinkCount: 0,
        aliasCount: 1,
        deleteAllowed: false,
      },
    ],
    claims: [
      {
        id: claimUserSays,
        subjectTemp: "temp_node_1",
        objectTemp: "temp_node_2",
        predicate: "RELATED_TO",
        statement: "Marcel lives in Antwerp.",
        scope: "personal",
        assertedByKind: "user",
        retractAllowed: false,
        contradictionCitationAllowed: true,
      },
      {
        id: claimAssistantInferred,
        subjectTemp: "temp_node_1",
        objectTemp: "temp_node_2",
        predicate: "OCCURRED_AT",
        statement: "Marcel visited Antwerp last weekend.",
        scope: "personal",
        assertedByKind: "assistant_inferred",
        retractAllowed: true,
        contradictionCitationAllowed: false,
      },
    ],
  };
}

describe("buildCleanupPrompt", () => {
  it("renders bundle sections with their usage hints as comments", () => {
    const prompt = buildCleanupPrompt(makeTempSubgraph(), makeBundle());

    expect(prompt).toContain('<section kind="atlas">');
    expect(prompt).toContain('<section kind="open_commitments">');
    expect(prompt).toContain('<section kind="preferences">');
    expect(prompt).toContain(
      "<!-- Authoritative summary of who the user is right now. -->",
    );
    expect(prompt).toContain("User lives in Antwerp; works at Acme.");
    expect(prompt).toContain("- Send spec to Bob (due 2026-05-01)");
  });

  it("annotates claims with provenance and exposes real claim ids", () => {
    const sub = makeTempSubgraph();
    const prompt = buildCleanupPrompt(sub, makeBundle());

    const inferred = sub.claims.find(
      (c) => c.assertedByKind === "assistant_inferred",
    )!;
    const userClaim = sub.claims.find((c) => c.assertedByKind === "user")!;

    expect(prompt).toContain(`provenance="[assistant_inferred, personal]"`);
    expect(prompt).toContain(`provenance="[user, personal]"`);
    expect(prompt).toContain(`retractAllowed="true"`);
    expect(prompt).toContain(`contradictionCitationAllowed="true"`);
    expect(prompt).toContain(`id="${inferred.id}"`);
    expect(prompt).toContain(`id="${userClaim.id}"`);
  });

  it("renders explicit eligible target lists and node evidence counts", () => {
    const sub = makeTempSubgraph();
    const prompt = buildCleanupPrompt(sub, makeBundle());
    const inferred = sub.claims.find(
      (c) => c.assertedByKind === "assistant_inferred",
    )!;
    const userClaim = sub.claims.find((c) => c.assertedByKind === "user")!;

    expect(prompt).toContain("<eligible_delete_nodes>");
    expect(prompt).toContain("(none)");
    expect(prompt).toContain("<eligible_retract_claims>");
    expect(prompt).toContain(`- ${inferred.id}`);
    expect(prompt).toContain("<eligible_contradiction_citations>");
    expect(prompt).toContain(`- ${userClaim.id}`);
    expect(prompt).toContain(`deleteAllowed="false"`);
    expect(prompt).toContain(`evidenceClaims="2"`);
    expect(prompt).toContain(`sourceLinks="1"`);
    expect(prompt).toContain(`aliases="1"`);
  });

  it("documents the new operation vocabulary and id rules", () => {
    const prompt = buildCleanupPrompt(makeTempSubgraph(), makeBundle());

    for (const opName of [
      "merge_nodes",
      "delete_node",
      "retract_claim",
      "contradict_claim",
      "promote_assertion",
      "add_claim",
      "add_alias",
      "remove_alias",
      "create_node",
    ]) {
      expect(prompt).toContain(opName);
    }

    // Node-touching ops use temp ids, claim-touching ops use real ids.
    expect(prompt).toMatch(/temp ids/i);
    expect(prompt).toMatch(/REAL claim ids/);
    expect(prompt).toContain("Return at most 10 operations");
    expect(prompt).toContain("Absence from the bundle is NEVER sufficient");
    expect(prompt).toContain("ACTIVE, same-scope, source-backed claim");
  });

  it("renders the subgraph nodes and claims inside <subgraph>", () => {
    const prompt = buildCleanupPrompt(makeTempSubgraph(), makeBundle());

    expect(prompt).toContain("<subgraph>");
    expect(prompt).toContain('<node tempId="temp_node_1"');
    expect(prompt).toContain("Marcel lives in Antwerp.");
  });

  it("omits the bundle wrapper when no sections are present", () => {
    const empty: ContextBundle = {
      assembledAt: new Date(),
      sections: [],
    };
    const prompt = buildCleanupPrompt(makeTempSubgraph(), empty);
    expect(prompt).not.toContain("<bundle>");
    // Subgraph still rendered.
    expect(prompt).toContain("<subgraph>");
  });
});
