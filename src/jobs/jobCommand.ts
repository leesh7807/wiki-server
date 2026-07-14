import { z } from "zod";
import type { JobCommand } from "./jobTypes.js";

const contentBodySchema = z.object({
  content: z.string().min(1),
});

const lintBodySchema = z.union([
  z.undefined(),
  z.object({
    content: z.string().optional(),
  }).strict(),
]);

export function formatJobInput(command: JobCommand, content: string, context?: string) {
  const input = command === "lint" ? "/lint" : `/${command} ${content}`;
  return context ? `${input}\n\n${context}` : input;
}

export function parseCommandContent(command: JobCommand, body: unknown) {
  if (command === "lint") {
    const parsed = lintBodySchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false as const, message: "body must be empty or include optional empty string content" };
    }
    if ((parsed.data?.content ?? "").trim().length > 0) {
      return { ok: false as const, message: "lint does not accept content" };
    }
    return { ok: true as const, content: "" };
  }

  const parsed = contentBodySchema.safeParse(body);
  return parsed.success
    ? { ok: true as const, content: parsed.data.content }
    : { ok: false as const, message: "body must include non-empty string content" };
}
