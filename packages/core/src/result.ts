import { z } from "zod";
import { PLATFORMS } from "./platform.js";

const platformEnum = z.enum(PLATFORMS);

const attachmentSchema = z.object({
  kind: z.enum(["image", "video"]),
  src: z.string().min(1),
});

const baseResultShape = {
  ok: z.literal(true),
  platform: platformEnum,
  account: z.string().min(1),
  traceFile: z.string().optional(),
  auditRef: z.string().optional(),
};

export const PublishResultSchema = z.object({
  ...baseResultShape,
  postUrl: z.string().url(),
  attachments: z.array(attachmentSchema).default([]),
  commentIds: z.array(z.string()).default([]),
});

export const CommentResultSchema = z.object({
  ...baseResultShape,
  commentId: z.string().min(1),
  parentPostUrl: z.string().url(),
});

export const EditResultSchema = z.object({
  ...baseResultShape,
  postUrl: z.string().url(),
  edited: z.boolean(),
});

export const VerifyResultSchema = z.object({
  ok: z.boolean(),
  platform: platformEnum,
  postUrl: z.string().url(),
  reachable: z.boolean(),
  status: z.number().int().nonnegative(),
  account: z.string().optional(),
});

export type PublishResult = z.infer<typeof PublishResultSchema>;
export type CommentResult = z.infer<typeof CommentResultSchema>;
export type EditResult = z.infer<typeof EditResultSchema>;
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
