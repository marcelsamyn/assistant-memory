import { z } from "zod";

export const convertFileMimeTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/json",
] as const;

export const convertFileFieldsSchema = z.object({
  filename: z.string().min(1),
  mimeType: z
    .string()
    .transform((value) => value.split(";", 1)[0]?.trim().toLowerCase() ?? "")
    .pipe(z.string().min(1)),
});

export const convertFileResponseSchema = z.object({
  markdown: z.string().max(10 * 1024 * 1024),
  title: z.string().nullable(),
});
export type ConvertFileResponse = z.infer<typeof convertFileResponseSchema>;

export interface ConvertFileRequest {
  file: Buffer | Blob | Uint8Array;
  filename: string;
  mimeType: string;
}
