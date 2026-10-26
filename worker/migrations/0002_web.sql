-- Sayt: talaba testni brauzerda yechadi, Telegram bot orqali kiradi.
ALTER TABLE students ADD COLUMN phone TEXT;

-- Kirish so'rovlari: sayt token beradi, bot telefonni oladi, talaba saytda uchta raqamdan mosini bosadi.
CREATE TABLE IF NOT EXISTS telegram_logins (
    token TEXT PRIMARY KEY,
    code INTEGER NOT NULL,
    options TEXT NOT NULL,       -- saytda ko'rsatiladigan uchta raqam, vergul bilan
    telegram_id INTEGER,
    chat_id INTEGER,
    name TEXT,
    username TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'new',   -- new | started | contact | done | failed
    created_at INTEGER NOT NULL           -- Date.now()
);
CREATE TABLE IF NOT EXISTS web_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    csrf TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
