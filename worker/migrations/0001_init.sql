CREATE TABLE IF NOT EXISTS students (
    user_id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    username TEXT
);
CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    options TEXT NOT NULL,      -- variantlar har biri yangi qatorda, "A) ..." ko'rinishida
    correct TEXT NOT NULL       -- to'g'ri variant harfi, masalan "B"
);
CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    answers TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    finished_at TEXT NOT NULL,
    UNIQUE(test_id, user_id)
);
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS test_groups (
    test_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    PRIMARY KEY (test_id, group_id)
);
-- suhbat holati (Python versiyasidagi FSM o'rniga)
CREATE TABLE IF NOT EXISTS states (
    user_id INTEGER PRIMARY KEY,
    state TEXT,
    data TEXT NOT NULL DEFAULT '{}'
);
-- guruhga yuboriladigan xabarlar navbati (bepul tarifda bitta so'rovda 50 ta tashqi chaqiruv limiti bor)
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    payload TEXT NOT NULL
);
