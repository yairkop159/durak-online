-- CreateEnum
CREATE TYPE "player_result" AS ENUM ('win', 'durak', 'draw', 'forfeit', 'unfinished');

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "device_key_hash" TEXT NOT NULL,
    "transfer_code_hash" TEXT,
    "transfer_expires_at" TIMESTAMP(3),
    "rating" INTEGER NOT NULL DEFAULT 1000,
    "games" INTEGER NOT NULL DEFAULT 0,
    "rated_games" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "duraks" INTEGER NOT NULL DEFAULT 0,
    "forfeits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "player_count" INTEGER NOT NULL,
    "end_reason" TEXT NOT NULL,
    "rated" BOOLEAN NOT NULL,
    "bot_assisted" BOOLEAN NOT NULL,
    "durak_profile_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_players" (
    "game_id" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "profile_id" TEXT,
    "nickname" TEXT NOT NULL,
    "is_bot" BOOLEAN NOT NULL,
    "result" "player_result" NOT NULL,
    "rating_before" INTEGER,
    "rating_after" INTEGER,
    "forfeited" BOOLEAN NOT NULL,
    "bot_assisted" BOOLEAN NOT NULL,

    CONSTRAINT "game_players_pkey" PRIMARY KEY ("game_id","seat")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_device_key_hash_key" ON "profiles"("device_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_transfer_code_hash_key" ON "profiles"("transfer_code_hash");

-- CreateIndex
CREATE INDEX "profiles_leaderboard_idx" ON "profiles"("rating" DESC, "id");

-- CreateIndex
CREATE INDEX "games_ended_at_idx" ON "games"("ended_at");

-- CreateIndex
CREATE INDEX "game_players_profile_id_game_id_idx" ON "game_players"("profile_id", "game_id");

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

