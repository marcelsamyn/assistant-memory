import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import {
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources.mjs";
import { z } from "zod";
import { getExtractionClientOverride } from "~/utils/test-overrides";

export async function createCompletionClient(userId: string): Promise<OpenAI> {
  const override = getExtractionClientOverride();
  if (override) return override as OpenAI;
  const { OpenAI } = await import("openai");
  return new OpenAI({
    apiKey: env.MEMORY_OPENAI_API_KEY,
    baseURL: env.MEMORY_OPENAI_API_BASE_URL,
    defaultHeaders: {
      ...(env.HELICONE_API_KEY
        ? {
            "Helicone-Auth": `Bearer ${env.HELICONE_API_KEY}`,
            "Helicone-User-Id": userId,
          }
        : {}),
      "HTTP-Referer": "https://github.com/iamarcel/assistant-memory",
      "X-Title": "Assistant Memory",
    },
  });
}

export async function crateTextCompletion({
  userId,
  prompt,
  systemPrompt,
}: {
  userId: string;
  prompt: string;
  systemPrompt?: string;
}): Promise<string> {
  const client = await createCompletionClient(userId);
  const completion = await client.chat.completions.create({
    messages: [
      ...(systemPrompt
        ? [
            {
              role: "system",
              content: systemPrompt,
            } satisfies ChatCompletionSystemMessageParam,
          ]
        : []),
      {
        role: "user",
        content: prompt,
      } satisfies ChatCompletionUserMessageParam,
    ],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
  });

  return completion.choices[0]?.message.content ?? "";
}

export async function performStructuredAnalysis({
  userId,
  prompt,
  systemPrompt,
  schema,
}: {
  userId: string;
  prompt: string;
  systemPrompt?: string;
  schema: z.ZodObject<z.ZodRawShape>;
}): Promise<z.infer<typeof schema>> {
  if (!schema.description) throw new Error("Schema must have a description");

  const client = await createCompletionClient(userId);
  const completion = await client.beta.chat.completions.parse({
    messages: [
      ...(systemPrompt
        ? [
            {
              role: "system",
              content: systemPrompt,
            } satisfies ChatCompletionSystemMessageParam,
          ]
        : []),
      {
        role: "user",
        content: prompt,
      } satisfies ChatCompletionUserMessageParam,
    ],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
    response_format: zodResponseFormat(schema, schema.description),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("Failed to parse response");
  return parsed;
}
