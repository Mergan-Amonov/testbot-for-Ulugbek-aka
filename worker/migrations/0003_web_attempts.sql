-- Saytdagi mashq urinishlari: test 20 tadan qismlarga bo'linadi, har bir qismni qayta yechish mumkin.
-- Botdagi rasmiy natijalar (results) bilan aralashmaydi.
CREATE TABLE IF NOT EXISTS web_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    test_id INTEGER NOT NULL,
    part INTEGER NOT NULL,        -- 0 — barcha savollar, 1.. — 20 tadan qismlar
    answers TEXT NOT NULL,        -- qism savollariga javob harflari, masalan "BADC..."
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at INTEGER NOT NULL   -- Date.now()
);
CREATE INDEX IF NOT EXISTS web_attempts_user_test ON web_attempts (user_id, test_id);
