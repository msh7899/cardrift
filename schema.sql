-- بازیکن‌ها: نام یکتا (name_key نسخه‌ی نرمال‌شده‌ی نام برای جلوگیری از تکراری‌ها)
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL UNIQUE,
  token      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- بهترین امتیاز هر بازیکن در هر بازی (برای دریفت: drift0 تا drift4 به تفکیک زمین)
CREATE TABLE IF NOT EXISTS scores (
  game       TEXT NOT NULL,
  player_id  INTEGER NOT NULL,
  score      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game, player_id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_scores_game_score ON scores(game, score DESC);
