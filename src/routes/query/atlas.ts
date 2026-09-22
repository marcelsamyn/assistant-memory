import { defineEventHandler } from "h3";
import {
  getAtlas,
  getAssistantAtlas,
  getWorkspaceAtlasEntries,
} from "~/lib/atlas";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  queryAtlasRequestSchema,
  queryAtlasResponseSchema,
} from "~/lib/schemas/query-atlas";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, assistantId } = parseRequestBody(
    queryAtlasRequestSchema,
    await readBody(event),
  );
  const accessScope = getRequestAccessScope(event);
  const db = await useDatabase();

  if (partitionKey === undefined && accessScope === "workspace") {
    const entries = await getWorkspaceAtlasEntries(db, userId, assistantId);
    const render = (
      type: "User Atlas" | "Assistant Atlas",
      about: string,
      rows: typeof entries.user,
    ): string =>
      rows
        .filter((row) => row.description)
        .map(
          (row) =>
            `<context type="${type}" partition="${row.partitionKey ?? "legacy"}" about="${about}">
${row.description}
</context>`,
        )
        .join("\n");
    const combinedWorkspaceAtlas = [
      render(
        "User Atlas",
        "The User Atlas is the central, persistent repository of structured information about the user.",
        entries.user,
      ),
      render(
        "Assistant Atlas",
        "The Assistant Atlas is persistent internal memory specific to this assistant instance.",
        entries.assistant,
      ),
    ]
      .filter(Boolean)
      .join("\n");
    return queryAtlasResponseSchema.parse({ atlas: combinedWorkspaceAtlas });
  }

  const { description: userDesc } = await getAtlas(db, userId, partitionKey);
  const { description: assistantDesc } = await getAssistantAtlas(
    db,
    userId,
    assistantId,
    partitionKey,
  );

  // Combine both atlases into a single string
  const combinedAtlas = `
${
  userDesc
    ? `
<context type="User Atlas" about="The User Atlas is the central, persistent repository of structured information *about the user*. It aims to capture factual details, track ongoing projects, long-term goals, upcoming events, and significant themes or interests expressed by the user. Refreshed daily.">
${userDesc}
</context>`
    : ""
}

${
  assistantDesc
    ? `
<context type="Assistant Atlas" about="The Assistant Atlas is the persistent internal memory specific to *this* assistant instance. It captures the assistant's synthesized understanding of its relationship with the user, its own emergent reflections, recurring interaction patterns, perceived emotional tones in the dialogue, and significant moments from its unique perspective. Refreshed daily.">
${assistantDesc}
</context>`
    : ""
}`;

  return queryAtlasResponseSchema.parse({ atlas: combinedAtlas.trim() });
});
