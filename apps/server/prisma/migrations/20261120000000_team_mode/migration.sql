-- Team mode (2v2). Postgres >= 12 allows ADD VALUE inside the migration's transaction, but the new
-- value cannot be USED in that same transaction: this migration only adds it. Any data step that
-- needs 'teamLoss' must go in a later migration.

-- AlterEnum
ALTER TYPE "player_result" ADD VALUE 'teamLoss';

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "teams" BOOLEAN NOT NULL DEFAULT false;
