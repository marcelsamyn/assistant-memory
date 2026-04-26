/** Node update boundary helpers. */

export function hasNodeDescriptionUpdate(body: unknown): boolean {
  return typeof body === "object" && body !== null && "description" in body;
}
