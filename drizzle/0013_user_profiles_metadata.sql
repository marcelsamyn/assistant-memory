-- Phase 4 PR 4ii-a — `userSelfAliases` lives at
-- `user_profiles.metadata.userSelfAliases`. Forward-only additive column;
-- the JSONB shape is defined in `src/lib/schemas/user-profile-metadata.ts`.
-- Idempotent — guarded so reruns are a no-op.

ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
