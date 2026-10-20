import asyncio
import html
import logging
import os
import random
import re
import sqlite3
import string
from datetime import datetime

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from dotenv import load_dotenv

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_IDS = {int(x) for x in os.getenv("ADMIN_IDS", "").replace(" ", "").split(",") if x}
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot.db")

router = Router()


# ---------------- Database ----------------

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        c.executescript(
            """
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
            -- qaysi test qaysi guruhga yuborilgan (topshirmaganlarni ko'rsatish uchun)
            CREATE TABLE IF NOT EXISTS test_groups (
                test_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                PRIMARY KEY (test_id, group_id)
            );
            """
        )


def new_code():
    while True:
        code = "".join(random.choices(string.digits, k=5))
        with db() as c:
            if not c.execute("SELECT 1 FROM tests WHERE code=?", (code,)).fetchone():
                return code


def get_test(code):
    with db() as c:
        return c.execute("SELECT * FROM tests WHERE code=?", (code,)).fetchone()


def get_questions(test_id):
    with db() as c:
        return c.execute(
            "SELECT * FROM questions WHERE test_id=? ORDER BY position", (test_id,)
        ).fetchall()


def get_student(user_id):
    with db() as c:
        return c.execute("SELECT * FROM students WHERE user_id=?", (user_id,)).fetchone()


def new_group_code():
    while True:
        code = "".join(random.choices(string.digits, k=5))
        with db() as c:
            if not c.execute("SELECT 1 FROM groups WHERE code=?", (code,)).fetchone():
                return code


def get_group(group_id):
    with db() as c:
        return c.execute("SELECT * FROM groups WHERE id=?", (group_id,)).fetchone()


def owner_groups(owner_id):
    with db() as c:
        return c.execute(
            """SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS n
               FROM groups g WHERE owner_id=? ORDER BY name""",
            (owner_id,),
        ).fetchall()


def student_group_names(user_id, owner_id):
    with db() as c:
        rows = c.execute(
            """SELECT g.name FROM groups g JOIN group_members m ON m.group_id=g.id
               WHERE m.user_id=? AND g.owner_id=? ORDER BY g.name""",
            (user_id, owner_id),
        ).fetchall()
    return [r["name"] for r in rows]


# ---------------- Test parsing ----------------

OPTION_RE = re.compile(r"^\s*(\*?)\s*([A-Za-zА-Яа-я])\s*[\)\.]\s*(.+)$")
ANSWER_RE = re.compile(
    r"^\s*(?:to['‘’`]?g['‘’`]?ri\s+)?(javob|answer|ответ|правильный ответ)\s*[:\-]\s*([A-Za-zА-Яа-я])\b.*$", re.I
)
NUMBER_RE = re.compile(r"^\s*(?:savol\s*)?\d+\s*[\.\)\-:]\s*", re.I)


def clean_ai_text(raw: str) -> str:
    """Claude/ChatGPT javobidagi markdown belgilarini (```, **, #) olib tashlaydi."""
    lines = []
    for line in raw.replace("\r\n", "\n").splitlines():
        if line.strip().startswith("```"):
            line = ""  # bo'sh qator — blokdan keyingi gap oxirgi savolga yopishmasin
        line = line.replace("**", "").replace("__", "")
        line = re.sub(r"^\s*#+\s*", "", line)
        lines.append(line)
    return "\n".join(lines)


def parse_questions(raw: str):
    """Savollar bo'sh qator bilan ajratiladi. To'g'ri javob 'Javob: B' qatori yoki variant oldidagi '*' bilan."""
    raw = clean_ai_text(raw)
    blocks = [b.strip() for b in re.split(r"\n\s*\n", raw.strip()) if b.strip()]
    questions, errors = [], []
    for n, block in enumerate(blocks, 1):
        q_lines, options, correct = [], [], None
        for line in block.splitlines():
            if not line.strip():
                continue
            if m := ANSWER_RE.match(line):
                correct = m.group(2).upper()
            elif (m := OPTION_RE.match(line)) and (options or q_lines):
                letter = m.group(2).upper()
                options.append(f"{letter}) {m.group(3).strip()}")
                if m.group(1):
                    correct = letter
            elif not options:
                q_lines.append(line.strip() if q_lines else NUMBER_RE.sub("", line).strip())
            else:
                # variantning davomi
                options[-1] += " " + line.strip()
        letters = [o[0] for o in options]
        if not options and correct is None:
            continue  # AI yozgan kirish/xulosa matni ("Mana 20 ta savol:" va h.k.)
        label = f"«{q_lines[0][:40]}»" if q_lines else f"{n}-blok"
        if not q_lines:
            errors.append(f"{label}: savol matni yo'q")
        elif len(options) < 2:
            errors.append(f"{label}: kamida 2 ta variant kerak")
        elif correct not in letters:
            errors.append(f"{label}: to'g'ri javob ko'rsatilmagan (Javob: X yoki *X)")
        else:
            questions.append({"text": "\n".join(q_lines), "options": options, "correct": correct})
    return questions, errors


# ---------------- States ----------------

class NewTest(StatesGroup):
    title = State()
    questions = State()


class NewGroup(StatesGroup):
    name = State()


class Student(StatesGroup):
    name = State()
    code = State()
    solving = State()


def is_admin(user_id):
    return user_id in ADMIN_IDS


# ---------------- Teacher ----------------

FORMAT_HELP = (
    "Savollarni quyidagi formatda yuboring (savollar orasida <b>bo'sh qator</b>):\n\n"
    "<code>O'zbekiston poytaxti qaysi?\n"
    "A) Samarqand\n"
    "B) Toshkent\n"
    "C) Buxoro\n"
    "D) Xiva\n"
    "Javob: B\n\n"
    "2 + 2 = ?\n"
    "A) 3\n"
    "*B) 4\n"
    "C) 5</code>\n\n"
    "To'g'ri javobni <code>Javob: B</code> qatori yoki variant oldiga <code>*</code> qo'yib belgilang.\n"
    "Claude/ChatGPT javobini to'g'ridan-to'g'ri nusxa olib yuborsangiz ham bo'ladi (/prompt).\n"
    "Ko'p savol bo'lsa, bir nechta xabarda yoki .txt fayl qilib yuboring. Tugatgach /done bosing."
)

TEACHER_HELP = (
    "👨‍🏫 <b>O'qituvchi buyruqlari</b>\n\n"
    "<b>Guruhlar</b>\n"
    "/newgroup — yangi guruh (talabalar havola orqali qo'shiladi)\n"
    "/groups — guruhlar, a'zolar, havolalar\n\n"
    "<b>Testlar</b>\n"
    "/prompt — Claude/ChatGPT uchun tayyor prompt\n"
    "/newtest — yangi test yaratish\n"
    "/send KOD — testni guruhga yuborish\n"
    "/mytests — mening testlarim\n"
    "/results KOD — natijalar (guruhlar bo'yicha)\n"
    "/close KOD — testni yopish\n"
    "/open KOD — testni qayta ochish\n"
    "/delete KOD — testni o'chirish\n"
    "/cancel — amalni bekor qilish"
)


@router.message(Command("cancel"))
async def cancel(message: Message, state: FSMContext):
    await state.clear()
    await message.answer("Bekor qilindi.")


AI_PROMPT = """Menga [MAVZU] bo'yicha [SONI] ta test savoli tuzib ber. Qiyinlik: [oson / o'rta / qiyin].

Har bir savolda 4 ta variant (A, B, C, D) va faqat bitta to'g'ri javob bo'lsin. To'g'ri javoblar o'rni aralash bo'lsin.

Javobni FAQAT quyidagi formatda, bitta kod blokida yoz. Savollar orasida bitta bo'sh qator qoldir. Raqamlama, qalin shrift va izoh ishlatma:

Savol matni
A) variant
B) variant
C) variant
D) variant
Javob: B"""


@router.message(Command("prompt"), F.from_user.func(lambda u: is_admin(u.id)))
async def prompt_cmd(message: Message):
    await message.answer(
        "🤖 <b>Claude yoki ChatGPT orqali test tuzish</b>\n\n"
        "1. Quyidagi promptni nusxa oling (ustiga bosing), [ ] ichini o'zgartiring va Claude/ChatGPT ga yuboring.\n"
        "   Darslik yoki ma'ruza bo'lsa, faylni ham chatga biriktiring.\n"
        "2. Javobni nusxa oling (kod blokidagi «Copy» tugmasi).\n"
        "3. Bu yerda /newtest → test nomi → nusxa olingan matnni yuboring → /done.\n\n"
        "Savollar ko'p bo'lsa (≈20+), matn bitta xabarga sig'masligi mumkin: "
        "bir necha xabarda yuboring yoki AI dan <i>.txt fayl qilib ber</i> deb so'rang va faylni yuboring."
    )
    await message.answer(f"<code>{html.escape(AI_PROMPT)}</code>")


@router.message(Command("newtest"), F.from_user.func(lambda u: is_admin(u.id)))
async def newtest(message: Message, state: FSMContext):
    await state.clear()
    await state.set_state(NewTest.title)
    await message.answer("Test nomini yuboring (masalan: <i>Matematika, 1-nazorat</i>):")


@router.message(NewTest.title, F.text)
async def newtest_title(message: Message, state: FSMContext):
    await state.update_data(title=message.text.strip(), questions=[])
    await state.set_state(NewTest.questions)
    await message.answer(FORMAT_HELP)


async def save_test(message: Message, bot: Bot, owner_id: int, title: str, questions):
    code = new_code()
    with db() as c:
        cur = c.execute(
            "INSERT INTO tests (code, title, owner_id, created_at) VALUES (?, ?, ?, ?)",
            (code, title, owner_id, datetime.now().isoformat(timespec="seconds")),
        )
        test_id = cur.lastrowid
        c.executemany(
            "INSERT INTO questions (test_id, position, text, options, correct) VALUES (?, ?, ?, ?, ?)",
            [(test_id, i, q["text"], "\n".join(q["options"]), q["correct"]) for i, q in enumerate(questions)],
        )
    me = await bot.get_me()
    link = f"https://t.me/{me.username}?start={code}"
    await message.answer(
        f"✅ Test yaratildi!\n\n"
        f"📝 <b>{html.escape(title)}</b>\n"
        f"❓ Savollar: {len(questions)} ta\n"
        f"🔑 Kod: <code>{code}</code>\n\n"
        f"Havola: {link}\n\n"
        f"Har bir talaba testni tugatganda natija sizga keladi."
    )
    await ask_send_groups(message, owner_id, test_id, code)


# ---------------- Guruhlar ----------------

async def group_link(bot: Bot, group):
    me = await bot.get_me()
    return f"https://t.me/{me.username}?start=g{group['code']}"


@router.message(Command("newgroup"), F.from_user.func(lambda u: is_admin(u.id)))
async def newgroup(message: Message, state: FSMContext):
    await state.clear()
    await state.set_state(NewGroup.name)
    await message.answer("Guruh nomini yozing (masalan: <i>1-guruh</i> yoki <i>101-A</i>):")


@router.message(NewGroup.name, F.text)
async def newgroup_name(message: Message, state: FSMContext, bot: Bot):
    name = message.text.strip()[:60]
    with db() as c:
        cur = c.execute(
            "INSERT INTO groups (code, name, owner_id) VALUES (?, ?, ?)",
            (new_group_code(), name, message.from_user.id),
        )
    await state.clear()
    link = await group_link(bot, get_group(cur.lastrowid))
    await message.answer(
        f"✅ <b>{html.escape(name)}</b> guruhi yaratildi.\n\n"
        f"Shu havolani guruh talabalariga yuboring (masalan, guruh chatiga tashlang):\n{link}\n\n"
        f"Talaba havolani bosib, ism-familiyasini yozadi va guruhga qo'shiladi. /groups"
    )


def groups_kb(groups):
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"👥 {g['name']} ({g['n']})", callback_data=f"grp:show:{g['id']}")]
        for g in groups
    ])


@router.message(Command("groups"), F.from_user.func(lambda u: is_admin(u.id)))
async def groups_cmd(message: Message):
    groups = owner_groups(message.from_user.id)
    if not groups:
        await message.answer("Sizda hali guruh yo'q. /newgroup")
        return
    await message.answer("👥 <b>Guruhlaringiz</b> (qavsda — talabalar soni):", reply_markup=groups_kb(groups))


def owned_group(call: CallbackQuery):
    group = get_group(int(call.data.split(":")[2]))
    return group if group and group["owner_id"] == call.from_user.id else None


@router.callback_query(F.data.startswith("grp:show:"))
async def group_show(call: CallbackQuery, bot: Bot):
    group = owned_group(call)
    if not group:
        await call.answer("Guruh topilmadi.")
        return
    with db() as c:
        members = c.execute(
            """SELECT s.* FROM group_members m JOIN students s ON s.user_id=m.user_id
               WHERE m.group_id=? ORDER BY s.full_name""",
            (group["id"],),
        ).fetchall()
    lines = [f"{i}. {html.escape(m['full_name'])}" + (f" (@{m['username']})" if m["username"] else "")
             for i, m in enumerate(members, 1)]
    text = (
        f"👥 <b>{html.escape(group['name'])}</b> — {len(members)} ta talaba\n"
        f"🔗 Qo'shilish havolasi: {await group_link(bot, group)}\n\n"
        + ("\n".join(lines) if lines else "Hali hech kim qo'shilmagan.")
    )
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="➖ Talabani chiqarish", callback_data=f"grp:kick:{group['id']}")],
        [InlineKeyboardButton(text="🗑 Guruhni o'chirish", callback_data=f"grp:del:{group['id']}")],
    ])
    await call.answer()
    await call.message.answer(text[:4096], reply_markup=kb, disable_web_page_preview=True)


@router.callback_query(F.data.startswith("grp:kick:"))
async def group_kick_list(call: CallbackQuery):
    group = owned_group(call)
    if not group:
        await call.answer("Guruh topilmadi.")
        return
    with db() as c:
        members = c.execute(
            """SELECT s.* FROM group_members m JOIN students s ON s.user_id=m.user_id
               WHERE m.group_id=? ORDER BY s.full_name""",
            (group["id"],),
        ).fetchall()
    await call.answer()
    if not members:
        await call.message.answer("Guruhda talaba yo'q.")
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"❌ {m['full_name']}", callback_data=f"grp:rm:{group['id']}:{m['user_id']}")]
        for m in members[:90]
    ])
    await call.message.answer(f"<b>{html.escape(group['name'])}</b> dan kimni chiqaramiz?", reply_markup=kb)


@router.callback_query(F.data.startswith("grp:rm:"))
async def group_kick(call: CallbackQuery):
    group = owned_group(call)
    if not group:
        await call.answer("Guruh topilmadi.")
        return
    user_id = int(call.data.split(":")[3])
    with db() as c:
        c.execute("DELETE FROM group_members WHERE group_id=? AND user_id=?", (group["id"], user_id))
    student = get_student(user_id)
    await call.answer("Chiqarildi")
    await call.message.edit_text(
        f"✅ {html.escape(student['full_name'] if student else str(user_id))} "
        f"<b>{html.escape(group['name'])}</b> guruhidan chiqarildi."
    )


@router.callback_query(F.data.startswith("grp:del:"))
async def group_delete_ask(call: CallbackQuery):
    group = owned_group(call)
    if not group:
        await call.answer("Guruh topilmadi.")
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Ha, o'chirilsin", callback_data=f"grp:delok:{group['id']}"),
        InlineKeyboardButton(text="Yo'q", callback_data="grp:no:0"),
    ]])
    await call.answer()
    await call.message.answer(
        f"<b>{html.escape(group['name'])}</b> guruhi o'chirilsinmi? Talabalar natijalari saqlanib qoladi.",
        reply_markup=kb,
    )


@router.callback_query(F.data.startswith("grp:delok:"))
async def group_delete(call: CallbackQuery):
    group = owned_group(call)
    if not group:
        await call.answer("Guruh topilmadi.")
        return
    with db() as c:
        c.execute("DELETE FROM group_members WHERE group_id=?", (group["id"],))
        c.execute("DELETE FROM test_groups WHERE group_id=?", (group["id"],))
        c.execute("DELETE FROM groups WHERE id=?", (group["id"],))
    await call.answer()
    await call.message.edit_text(f"🗑 <b>{html.escape(group['name'])}</b> guruhi o'chirildi.")


@router.callback_query(F.data == "grp:no:0")
async def group_no(call: CallbackQuery):
    await call.answer()
    await call.message.edit_text("Bekor qilindi.")


# ---------------- Testni guruhga yuborish ----------------

async def ask_send_groups(message: Message, owner_id: int, test_id: int, code: str):
    groups = owner_groups(owner_id)
    if not groups:
        await message.answer("💡 Guruh yaratsangiz (/newgroup), testni bir tugma bilan butun guruhga yubora olasiz.")
        return
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"📤 {g['name']} ({g['n']} ta)", callback_data=f"send:{test_id}:{g['id']}")]
        for g in groups
    ])
    await message.answer(
        f"Testni (<code>{code}</code>) qaysi guruhga yuboramiz? Har bir talabaga botda xabar boradi.",
        reply_markup=kb,
    )


@router.message(Command("send"), F.from_user.func(lambda u: is_admin(u.id)))
async def send_cmd(message: Message, command: CommandObject):
    test = owned_test(message, command)
    if not test:
        await message.answer("Foydalanish: /send KOD")
        return
    await ask_send_groups(message, message.from_user.id, test["id"], test["code"])


@router.callback_query(F.data.startswith("send:"))
async def send_to_group(call: CallbackQuery, bot: Bot):
    _, test_id, group_id = call.data.split(":")
    with db() as c:
        test = c.execute("SELECT * FROM tests WHERE id=?", (int(test_id),)).fetchone()
    group = get_group(int(group_id))
    if not test or not group or test["owner_id"] != call.from_user.id or group["owner_id"] != call.from_user.id:
        await call.answer("Test yoki guruh topilmadi.")
        return
    await call.answer("Yuborilmoqda...")
    with db() as c:
        c.execute("INSERT OR IGNORE INTO test_groups (test_id, group_id) VALUES (?, ?)", (test["id"], group["id"]))
        members = c.execute(
            """SELECT m.user_id FROM group_members m
               WHERE m.group_id=? AND m.user_id NOT IN (SELECT user_id FROM results WHERE test_id=?)""",
            (group["id"], test["id"]),
        ).fetchall()
    me = await bot.get_me()
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="▶️ Testni boshlash", url=f"https://t.me/{me.username}?start={test['code']}")
    ]])
    sent = 0
    for m in members:
        try:
            await bot.send_message(
                m["user_id"], f"📝 Yangi test: <b>{html.escape(test['title'])}</b>", reply_markup=kb
            )
            sent += 1
        except Exception:
            logging.warning("Talabaga xabar yuborilmadi: %s", m["user_id"])
        await asyncio.sleep(0.05)  # Telegram limitlariga tushmaslik uchun
    failed = len(members) - sent
    await call.message.answer(
        f"📤 <b>{html.escape(group['name'])}</b>: {sent} ta talabaga yuborildi."
        + (f"\n⚠️ {failed} ta talabaga yetib bormadi (botni bloklagan bo'lishi mumkin)." if failed else "")
    )


@router.message(NewTest.questions, Command("done"))
async def newtest_done(message: Message, state: FSMContext, bot: Bot):
    data = await state.get_data()
    questions = data.get("questions", [])
    if not questions:
        await message.answer("Hali birorta savol qo'shilmadi. Savollarni yuboring yoki /cancel.")
        return
    await state.clear()
    await save_test(message, bot, message.from_user.id, data["title"], questions)


@router.message(NewTest.questions, F.document)
async def newtest_file(message: Message, state: FSMContext, bot: Bot):
    name = (message.document.file_name or "").lower()
    if not name.endswith((".txt", ".md")):
        await message.answer("Faqat .txt fayl qabul qilinadi (yoki matnni xabar qilib yuboring).")
        return
    raw = (await bot.download(message.document)).read().decode("utf-8-sig", errors="ignore")
    await add_questions(message, state, raw)


@router.message(NewTest.questions, F.text)
async def newtest_questions(message: Message, state: FSMContext):
    await add_questions(message, state, message.text)


async def add_questions(message: Message, state: FSMContext, raw: str):
    parsed, errors = parse_questions(raw)
    data = await state.get_data()
    questions = data.get("questions", []) + parsed
    await state.update_data(questions=questions)
    text = f"➕ {len(parsed)} ta savol qo'shildi. Jami: {len(questions)} ta."
    if errors:
        text += "\n\n⚠️ Qabul qilinmadi:\n" + "\n".join(html.escape(e) for e in errors)
    text += "\n\nYana savol yuboring yoki /done bosing."
    await message.answer(text)


@router.message(Command("mytests"), F.from_user.func(lambda u: is_admin(u.id)))
async def mytests(message: Message):
    with db() as c:
        rows = c.execute(
            """SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.test_id=t.id) AS qn,
                      (SELECT COUNT(*) FROM results r WHERE r.test_id=t.id) AS rn
               FROM tests t WHERE owner_id=? ORDER BY id DESC""",
            (message.from_user.id,),
        ).fetchall()
    if not rows:
        await message.answer("Sizda hali test yo'q. /newtest")
        return
    lines = [
        f"{'🟢' if r['active'] else '🔴'} <code>{r['code']}</code> — {html.escape(r['title'])} "
        f"({r['qn']} savol, {r['rn']} ta topshirgan)"
        for r in rows
    ]
    await message.answer("📋 <b>Testlaringiz:</b>\n\n" + "\n".join(lines))


def owned_test(message: Message, command: CommandObject):
    code = (command.args or "").strip()
    test = get_test(code) if code else None
    if not test or test["owner_id"] != message.from_user.id:
        return None
    return test


@router.message(Command("results"), F.from_user.func(lambda u: is_admin(u.id)))
async def results(message: Message, command: CommandObject):
    test = owned_test(message, command)
    if not test:
        await message.answer("Foydalanish: /results KOD")
        return
    with db() as c:
        rows = c.execute(
            """SELECT r.*, s.full_name, s.username FROM results r
               JOIN students s ON s.user_id=r.user_id
               WHERE r.test_id=? ORDER BY r.score DESC, r.finished_at""",
            (test["id"],),
        ).fetchall()
        sent_groups = {r["group_id"] for r in c.execute(
            "SELECT group_id FROM test_groups WHERE test_id=?", (test["id"],))}
        members = c.execute(
            """SELECT g.id AS group_id, s.user_id, s.full_name FROM groups g
               JOIN group_members m ON m.group_id=g.id JOIN students s ON s.user_id=m.user_id
               WHERE g.owner_id=?""",
            (test["owner_id"],),
        ).fetchall()
    groups = owner_groups(test["owner_id"])
    done = {r["user_id"]: r for r in rows}

    def result_line(i, r):
        pct = round(r["score"] * 100 / r["total"])
        return f"{i}. {html.escape(r['full_name'])} — {r['score']}/{r['total']} ({pct}%)"

    sections, in_group = [], set()
    for g in groups:
        ids = {m["user_id"] for m in members if m["group_id"] == g["id"]}
        in_group |= ids
        took = [done[u] for u in done if u in ids]  # rows score bo'yicha tartiblangan
        if not took and g["id"] not in sent_groups:
            continue
        missing = sorted(m["full_name"] for m in members if m["group_id"] == g["id"] and m["user_id"] not in done)
        part = f"👥 <b>{html.escape(g['name'])}</b> — {len(took)}/{len(ids)} topshirdi"
        if took:
            avg = round(sum(r["score"] * 100 / r["total"] for r in took) / len(took))
            part += f", o'rtacha {avg}%"
        part += "\n" + "\n".join(result_line(i, r) for i, r in enumerate(took, 1))
        if missing and g["id"] in sent_groups:
            part += "\n⏳ Topshirmaganlar: " + ", ".join(html.escape(n) for n in missing)
        sections.append(part.strip())
    others = [r for r in rows if r["user_id"] not in in_group]
    if others:
        sections.append("👤 <b>Guruhsiz</b>\n" + "\n".join(result_line(i, r) for i, r in enumerate(others, 1)))
    if not sections:
        await message.answer("Bu testni hali hech kim topshirmagan.")
        return
    header = f"📊 <b>{html.escape(test['title'])}</b> (<code>{test['code']}</code>)\nJami topshirganlar: {len(rows)}"
    # bo'limlarni 4096 belgidan oshirmay yuboramiz
    text = header
    for s in sections:
        if len(text) + len(s) + 2 > 4000:
            await message.answer(text)
            text = ""
        text = f"{text}\n\n{s}" if text else s
    await message.answer(text[:4096])


async def set_active(message: Message, command: CommandObject, active: int):
    test = owned_test(message, command)
    if not test:
        await message.answer("Test topilmadi. Kodni tekshiring.")
        return
    with db() as c:
        c.execute("UPDATE tests SET active=? WHERE id=?", (active, test["id"]))
    await message.answer(f"Test <code>{test['code']}</code> {'ochildi 🟢' if active else 'yopildi 🔴'}.")


@router.message(Command("close"), F.from_user.func(lambda u: is_admin(u.id)))
async def close_test(message: Message, command: CommandObject):
    await set_active(message, command, 0)


@router.message(Command("open"), F.from_user.func(lambda u: is_admin(u.id)))
async def open_test(message: Message, command: CommandObject):
    await set_active(message, command, 1)


@router.message(Command("delete"), F.from_user.func(lambda u: is_admin(u.id)))
async def delete_test(message: Message, command: CommandObject):
    test = owned_test(message, command)
    if not test:
        await message.answer("Test topilmadi. Kodni tekshiring.")
        return
    with db() as c:
        c.execute("DELETE FROM questions WHERE test_id=?", (test["id"],))
        c.execute("DELETE FROM results WHERE test_id=?", (test["id"],))
        c.execute("DELETE FROM test_groups WHERE test_id=?", (test["id"],))
        c.execute("DELETE FROM tests WHERE id=?", (test["id"],))
    await message.answer(f"🗑 Test <code>{test['code']}</code> o'chirildi.")


# ---------------- Student ----------------

@router.message(CommandStart())
async def start(message: Message, command: CommandObject, state: FSMContext):
    await state.clear()
    code = (command.args or "").strip()
    if is_admin(message.from_user.id) and not code:
        await message.answer(TEACHER_HELP)
        return
    await state.update_data(code=code)
    student = get_student(message.from_user.id)
    if not student:
        await state.set_state(Student.name)
        await message.answer("Assalomu alaykum! 👋\nIsm va familiyangizni yozing:")
        return
    await ask_code_or_begin(message, state, code)


@router.message(Command("name"))
async def change_name(message: Message, state: FSMContext):
    await state.clear()
    await state.set_state(Student.name)
    await message.answer("Yangi ism va familiyangizni yozing:")


@router.message(Student.name, F.text)
async def student_name(message: Message, state: FSMContext):
    name = message.text.strip()
    if len(name) < 3 or name.startswith("/"):
        await message.answer("Iltimos, to'liq ism-familiyangizni yozing:")
        return
    with db() as c:
        c.execute(
            "INSERT INTO students (user_id, full_name, username) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET full_name=excluded.full_name, username=excluded.username",
            (message.from_user.id, name, message.from_user.username),
        )
    data = await state.get_data()
    await message.answer(f"Rahmat, {html.escape(name)}!")
    await ask_code_or_begin(message, state, data.get("code", ""))


async def ask_code_or_begin(message: Message, state: FSMContext, code: str):
    if code.startswith("g"):
        await join_group(message, state, code[1:])
    elif code:
        await begin_test(message, state, code)
    else:
        await state.set_state(Student.code)
        await message.answer("O'qituvchingiz bergan test kodini yuboring:")


async def join_group(message: Message, state: FSMContext, group_code: str):
    await state.clear()
    with db() as c:
        group = c.execute("SELECT * FROM groups WHERE code=?", (group_code,)).fetchone()
        if not group:
            await message.answer("❌ Guruh topilmadi. Havolani o'qituvchingizdan qayta so'rang.")
            return
        c.execute(
            "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)",
            (group["id"], message.from_user.id, datetime.now().isoformat(timespec="seconds")),
        )
    await message.answer(
        f"✅ Siz <b>{html.escape(group['name'])}</b> guruhiga qo'shildingiz!\n\n"
        "O'qituvchi test yuborganda shu yerga xabar keladi. "
        "Ismingizni o'zgartirish uchun: /name"
    )


@router.message(Student.code, F.text)
async def student_code(message: Message, state: FSMContext):
    await begin_test(message, state, message.text.strip())


async def begin_test(message: Message, state: FSMContext, code: str):
    test = get_test(code)
    if not test:
        await state.set_state(Student.code)
        await message.answer("❌ Bunday kodli test topilmadi. Qaytadan yuboring:")
        return
    if not test["active"]:
        await state.clear()
        await message.answer("🔴 Bu test yopilgan.")
        return
    with db() as c:
        done = c.execute(
            "SELECT score, total FROM results WHERE test_id=? AND user_id=?",
            (test["id"], message.from_user.id),
        ).fetchone()
    if done:
        await state.clear()
        await message.answer(f"Siz bu testni allaqachon topshirgansiz. Natijangiz: {done['score']}/{done['total']}")
        return
    questions = get_questions(test["id"])
    await state.set_state(Student.solving)
    await state.update_data(test_id=test["id"], code=code, idx=0, answers=[])
    await message.answer(
        f"📝 <b>{html.escape(test['title'])}</b>\nSavollar soni: {len(questions)} ta\n\nBoshladik! 🍀"
    )
    await send_question(message, questions, 0)


async def send_question(message: Message, questions, idx: int):
    q = questions[idx]
    options = q["options"].split("\n")
    text = (
        f"<b>{idx + 1}/{len(questions)}.</b> {html.escape(q['text'])}\n\n"
        + "\n".join(html.escape(o) for o in options)
    )
    kb = InlineKeyboardMarkup(
        inline_keyboard=[[
            InlineKeyboardButton(text=o[0], callback_data=f"ans:{idx}:{o[0]}") for o in options
        ]]
    )
    await message.answer(text, reply_markup=kb)


@router.callback_query(Student.solving, F.data.startswith("ans:"))
async def answer(call: CallbackQuery, state: FSMContext, bot: Bot):
    _, idx_s, letter = call.data.split(":")
    data = await state.get_data()
    idx = data["idx"]
    if int(idx_s) != idx:
        await call.answer("Bu savolga allaqachon javob berilgan.")
        return
    answers = data["answers"] + [letter]
    questions = get_questions(data["test_id"])
    await call.message.edit_text(call.message.html_text + f"\n\n✍️ Javobingiz: <b>{letter}</b>")
    await call.answer()
    if idx + 1 < len(questions):
        await state.update_data(idx=idx + 1, answers=answers)
        await send_question(call.message, questions, idx + 1)
    else:
        await state.clear()
        await finish_test(call, bot, data["test_id"], questions, answers)


async def finish_test(call: CallbackQuery, bot: Bot, test_id: int, questions, answers):
    user = call.from_user
    score = sum(1 for q, a in zip(questions, answers) if q["correct"] == a)
    total = len(questions)
    pct = round(score * 100 / total)
    with db() as c:
        try:
            c.execute(
                "INSERT INTO results (test_id, user_id, answers, score, total, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
                (test_id, user.id, "".join(answers), score, total, datetime.now().isoformat(timespec="seconds")),
            )
        except sqlite3.IntegrityError:
            await call.message.answer("Siz bu testni allaqachon topshirgansiz.")
            return
        test = c.execute("SELECT * FROM tests WHERE id=?", (test_id,)).fetchone()
    student = get_student(user.id)

    await call.message.answer(
        f"🏁 Test tugadi!\n\n✅ To'g'ri javoblar: <b>{score}/{total}</b> ({pct}%)\n\nNatijangiz o'qituvchiga yuborildi."
    )

    details = []
    for i, (q, a) in enumerate(zip(questions, answers), 1):
        mark = "✅" if q["correct"] == a else f"❌ (to'g'ri: {q['correct']})"
        details.append(f"{i}. {a} {mark}")
    username = f" (@{user.username})" if user.username else ""
    group_names = student_group_names(user.id, test["owner_id"])
    report = (
        f"📥 <b>Yangi natija</b>\n\n"
        f"👤 {html.escape(student['full_name'])}{html.escape(username)}\n"
        + (f"👥 {html.escape(', '.join(group_names))}\n" if group_names else "")
        +
        f"📝 {html.escape(test['title'])} (<code>{test['code']}</code>)\n"
        f"✅ Natija: <b>{score}/{total}</b> ({pct}%)\n\n"
        + "\n".join(details)
    )
    try:
        await bot.send_message(test["owner_id"], report[:4096])
    except Exception:
        logging.exception("O'qituvchiga natija yuborilmadi")


@router.callback_query(F.data.startswith("ans:"))
async def stale_answer(call: CallbackQuery):
    await call.answer("Bu test sessiyasi tugagan. Qaytadan /start bosing.", show_alert=True)


@router.message(Student.solving)
async def solving_text(message: Message):
    await message.answer("Javobni tugmalar orqali tanlang 👆")


@router.message()
async def fallback(message: Message, state: FSMContext):
    if is_admin(message.from_user.id):
        await message.answer(TEACHER_HELP)
    else:
        await state.set_state(Student.code)
        await message.answer("Test kodini yuboring (yoki /start):")


async def main():
    if not BOT_TOKEN:
        raise SystemExit(".env faylida BOT_TOKEN ko'rsatilmagan")
    if not ADMIN_IDS:
        raise SystemExit(".env faylida ADMIN_IDS ko'rsatilmagan")
    logging.basicConfig(level=logging.INFO)
    init_db()
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
