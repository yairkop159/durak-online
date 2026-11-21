-- Tournaments: a series of games in one room. Additive only: a new counter with a default and
-- two new tables, so every Phase 10 and team-mode row stays as it is.

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "tournaments_won" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tournaments" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "teams" BOOLEAN NOT NULL,
    "games_planned" INTEGER NOT NULL,
    "games_played" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_players" (
    "tournament_id" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "profile_id" TEXT,
    "nickname" TEXT NOT NULL,
    "is_bot" BOOLEAN NOT NULL,
    "left" BOOLEAN NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "duraks" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "champion" BOOLEAN NOT NULL,

    CONSTRAINT "tournament_players_pkey" PRIMARY KEY ("tournament_id","seat")
);

-- CreateIndex
CREATE INDEX "tournaments_ended_at_idx" ON "tournaments"("ended_at");

-- CreateIndex
CREATE INDEX "tournament_players_profile_id_idx" ON "tournament_players"("profile_id");

-- AddForeignKey
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_players" ADD CONSTRAINT "tournament_players_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

