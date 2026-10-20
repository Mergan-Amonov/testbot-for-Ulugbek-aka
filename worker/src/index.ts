// Telegram test bot — Cloudflare Workers versiyasi (webhook + D1).
// Mantiq Python versiyasi (../bot.py) bilan bir xil.
import { env } from "cloudflare:workers";

// ---------------- Telegram turlari ----------------

interface TgUser { id: number; username?: string }
interface TgDocument { file_id: string; file_name?: string; file_size?: number }
interface TgMessage { message_id: number; chat: { id: number }; from?: TgUser; text?: string; caption?: string; document?: TgDocument }
interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
interface TgUpdate { message?: TgMessage; callback_query?: TgCallback }
type Button = { text: string; callback_data?: string; url?: string };
type Keyboard = { inline_keyboard: Button[][] };

type Row = Record<string, any>;
type Question = { text: string; options: string[]; correct: string };

// ---------------- Yordamchilar ----------------

const isAdmin = (id: number) => env.ADMIN_IDS.split(",").map((x) => Number(x.trim())).includes(id);
const now = () => new Date().toISOString().slice(0, 19);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kb = (rows: Button[][]): Keyboard => ({ inline_keyboard: rows });
const startLink = (arg: string) => `https://t.me/${env.BOT_USERNAME}?start=${arg}`;

async function tg(method: string, params: Record<string, unknown>): Promise<any> {
	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
	});
	const data: any = await res.json();
	if (!data.ok) throw new Error(`${method}: ${data.description}`);
	return data.result;
}

const send = (chatId: number, text: string, markup?: Keyboard) =>
	tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });

const editText = (msg: TgMessage, text: string, markup?: Keyboard) =>
	tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: "HTML", reply_markup: markup });

const removeKb = (msg: TgMessage) =>
	tg("editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});

// ---------------- Ma'lumotlar bazasi ----------------

const one = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<Row>();
const all = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<Row>()).results;
const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();

async function newCode(table: "tests" | "groups") {
	for (;;) {
		const code = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
		if (!(await one(`SELECT 1 FROM ${table} WHERE code=?`, code))) return code;
	}
}

const getTest = (code: string) => one("SELECT * FROM tests WHERE code=?", code);
const getQuestions = (testId: number) => all("SELECT * FROM questions WHERE test_id=? ORDER BY position", testId);
const getStudent = (userId: number) => one("SELECT * FROM students WHERE user_id=?", userId);
const getGroup = (groupId: number) => one("SELECT * FROM groups WHERE id=?", groupId);

const ownerGroups = (ownerId: number) =>
	all(
		`SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS n
		 FROM groups g WHERE owner_id=? ORDER BY name`,
		ownerId,
	);

async function studentGroupNames(userId: number, ownerId: number) {
	const rows = await all(
		`SELECT g.name FROM groups g JOIN group_members m ON m.group_id=g.id
		 WHERE m.user_id=? AND g.owner_id=? ORDER BY g.name`,
		userId, ownerId,
	);
	return rows.map((r) => r.name as string);
}

// ---------------- Holat (FSM) ----------------

type State = { state: string | null; data: Row };

async function getState(userId: number): Promise<State> {
	const row = await one("SELECT state, data FROM states WHERE user_id=?", userId);
	return row ? { state: row.state, data: JSON.parse(row.data) } : { state: null, data: {} };
}

const setState = (userId: number, state: string | null, data: Row = {}) =>
	run(
		"INSERT INTO states (user_id, state, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data",
		userId, state, JSON.stringify(data),
	);

const clearState = (userId: number) => run("DELETE FROM states WHERE user_id=?", userId);

// ---------------- Test matnini o'qish ----------------

const L = "A-Za-zА-Яа-я";
const OPTION_RE = new RegExp(`^\\s*(\\*?)\\s*([${L}])\\s*[\\)\\.]\\s*(.+)$`, "u");
const ANSWER_RE = new RegExp(
	`^\\s*(?:to['‘’\`]?g['‘’\`]?ri\\s+)?(javob|answer|ответ|правильный ответ)\\s*[:\\-]\\s*([${L}])(?![${L}]).*$`, "iu",
);
const NUMBER_RE = /^\s*(?:savol\s*)?\d+\s*[.)\-:]\s*/i;

// Claude/ChatGPT javobidagi markdown belgilarini (```, **, #) olib tashlaydi
function cleanAiText(raw: string) {
	return raw
		.replace(/\r\n/g, "\n")
		.split("\n")
		// ``` qatori bo'sh qatorga aylanadi — blokdan keyingi gap oxirgi savolga yopishmasin
		.map((line) => (line.trim().startsWith("```") ? "" : line))
		.map((line) => line.replaceAll("**", "").replaceAll("__", "").replace(/^\s*#+\s*/, ""))
		.join("\n");
}

// Savollar bo'sh qator bilan ajratiladi. To'g'ri javob 'Javob: B' qatori yoki variant oldidagi '*' bilan.
function parseQuestions(raw: string) {
	const blocks = cleanAiText(raw).trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
	const questions: Question[] = [];
	const errors: string[] = [];
	blocks.forEach((block, i) => {
		const qLines: string[] = [];
		const options: string[] = [];
		let correct: string | null = null;
		for (const line of block.split("\n")) {
			if (!line.trim()) continue;
			let m: RegExpMatchArray | null;
			if ((m = line.match(ANSWER_RE))) {
				correct = m[2].toUpperCase();
			} else if ((m = line.match(OPTION_RE)) && (options.length || qLines.length)) {
				const letter = m[2].toUpperCase();
				options.push(`${letter}) ${m[3].trim()}`);
				if (m[1]) correct = letter;
			} else if (!options.length) {
				qLines.push(qLines.length ? line.trim() : line.replace(NUMBER_RE, "").trim());
			} else {
				options[options.length - 1] += " " + line.trim(); // variantning davomi
			}
		}
		if (!options.length && correct === null) return; // AI yozgan kirish/xulosa matni
		const label = qLines.length ? `«${qLines[0].slice(0, 40)}»` : `${i + 1}-blok`;
		const letters = options.map((o) => o[0]);
		if (!qLines.length) errors.push(`${label}: savol matni yo'q`);
		else if (options.length < 2) errors.push(`${label}: kamida 2 ta variant kerak`);
		else if (!correct || !letters.includes(correct)) errors.push(`${label}: to'g'ri javob ko'rsatilmagan (Javob: X yoki *X)`);
		else questions.push({ text: qLines.join("\n"), options, correct });
	});
	return { questions, errors };
}

// ---------------- Matnlar ----------------

const FORMAT_HELP =
	"Savollarni quyidagi formatda yuboring (savollar orasida <b>bo'sh qator</b>):\n\n" +
	"<code>O'zbekiston poytaxti qaysi?\nA) Samarqand\nB) Toshkent\nC) Buxoro\nD) Xiva\nJavob: B\n\n" +
	"2 + 2 = ?\nA) 3\n*B) 4\nC) 5</code>\n\n" +
	"To'g'ri javobni <code>Javob: B</code> qatori yoki variant oldiga <code>*</code> qo'yib belgilang.\n" +
	"Claude/ChatGPT javobini to'g'ridan-to'g'ri nusxa olib yuborsangiz ham bo'ladi (/prompt).\n" +
	"Ko'p savol bo'lsa, bir nechta xabarda yoki .txt fayl qilib yuboring. Tugatgach /done bosing.";

const TEACHER_HELP =
	"👨‍🏫 <b>O'qituvchi buyruqlari</b>\n\n" +
	"<b>Guruhlar</b>\n" +
	"/newgroup — yangi guruh (talabalar havola orqali qo'shiladi)\n" +
	"/groups — guruhlar, a'zolar, havolalar\n\n" +
	"<b>Testlar</b>\n" +
	"/prompt — Claude/ChatGPT uchun tayyor prompt\n" +
	"/newtest — yangi test yaratish\n" +
	"/send KOD — testni guruhga yuborish\n" +
	"/mytests — mening testlarim\n" +
	"/results KOD — natijalar (guruhlar bo'yicha)\n" +
	"/close KOD — testni yopish\n" +
	"/open KOD — testni qayta ochish\n" +
	"/delete KOD — testni o'chirish\n" +
	"/cancel — amalni bekor qilish";

const AI_PROMPT = `Menga [MAVZU] bo'yicha [SONI] ta test savoli tuzib ber. Qiyinlik: [oson / o'rta / qiyin].

Har bir savolda 4 ta variant (A, B, C, D) va faqat bitta to'g'ri javob bo'lsin. To'g'ri javoblar o'rni aralash bo'lsin.

Javobni FAQAT quyidagi formatda, bitta kod blokida yoz. Savollar orasida bitta bo'sh qator qoldir. Raqamlama, qalin shrift va izoh ishlatma:

Savol matni
A) variant
B) variant
C) variant
D) variant
Javob: B`;

// ---------------- O'qituvchi: testlar ----------------

async function saveTest(chatId: number, ownerId: number, title: string, questions: Question[]) {
	const code = await newCode("tests");
	const test = await one(
		"INSERT INTO tests (code, title, owner_id, created_at) VALUES (?, ?, ?, ?) RETURNING id",
		code, title, ownerId, now(),
	);
	const insert = env.DB.prepare("INSERT INTO questions (test_id, position, text, options, correct) VALUES (?, ?, ?, ?, ?)");
	await env.DB.batch(questions.map((q, i) => insert.bind(test!.id, i, q.text, q.options.join("\n"), q.correct)));
	await send(
		chatId,
		`✅ Test yaratildi!\n\n📝 <b>${esc(title)}</b>\n❓ Savollar: ${questions.length} ta\n🔑 Kod: <code>${code}</code>\n\n` +
			`Havola: ${startLink(code)}\n\nHar bir talaba testni tugatganda natija sizga keladi.`,
	);
	await askSendGroups(chatId, ownerId, test!.id, code);
}

async function addQuestions(chatId: number, userId: number, st: State, raw: string) {
	const { questions: parsed, errors } = parseQuestions(raw);
	const questions = [...(st.data.questions ?? []), ...parsed];
	await setState(userId, "newtest:questions", { ...st.data, questions });
	let text = `➕ ${parsed.length} ta savol qo'shildi. Jami: ${questions.length} ta.`;
	if (errors.length) text += "\n\n⚠️ Qabul qilinmadi:\n" + errors.map(esc).join("\n");
	await send(chatId, text + "\n\nYana savol yuboring yoki /done bosing.");
}

async function ownedTest(userId: number, code: string) {
	const test = code ? await getTest(code) : null;
	return test && test.owner_id === userId ? test : null;
}

async function myTests(chatId: number, userId: number) {
	const rows = await all(
		`SELECT t.*, (SELECT COUNT(*) FROM questions q WHERE q.test_id=t.id) AS qn,
		        (SELECT COUNT(*) FROM results r WHERE r.test_id=t.id) AS rn
		 FROM tests t WHERE owner_id=? ORDER BY id DESC LIMIT 60`,
		userId,
	);
	if (!rows.length) return send(chatId, "Sizda hali test yo'q. /newtest");
	const lines = rows.map(
		(r) => `${r.active ? "🟢" : "🔴"} <code>${r.code}</code> — ${esc(r.title)} (${r.qn} savol, ${r.rn} ta topshirgan)`,
	);
	await send(chatId, ("📋 <b>Testlaringiz:</b>\n\n" + lines.join("\n")).slice(0, 4096));
}

async function results(chatId: number, userId: number, code: string) {
	const test = await ownedTest(userId, code);
	if (!test) return send(chatId, "Foydalanish: /results KOD");
	const [rows, sentRows, members, groups] = await Promise.all([
		all(
			`SELECT r.*, s.full_name FROM results r JOIN students s ON s.user_id=r.user_id
			 WHERE r.test_id=? ORDER BY r.score DESC, r.finished_at`,
			test.id,
		),
		all("SELECT group_id FROM test_groups WHERE test_id=?", test.id),
		all(
			`SELECT g.id AS group_id, s.user_id, s.full_name FROM groups g
			 JOIN group_members m ON m.group_id=g.id JOIN students s ON s.user_id=m.user_id
			 WHERE g.owner_id=?`,
			test.owner_id,
		),
		ownerGroups(test.owner_id),
	]);
	const sentGroups = new Set(sentRows.map((r) => r.group_id));
	const done = new Map(rows.map((r) => [r.user_id, r]));
	const line = (i: number, r: Row) =>
		`${i}. ${esc(r.full_name)} — ${r.score}/${r.total} (${Math.round((r.score * 100) / r.total)}%)`;

	const sections: string[] = [];
	const inGroup = new Set<number>();
	for (const g of groups) {
		const gm = members.filter((m) => m.group_id === g.id);
		const ids = new Set(gm.map((m) => m.user_id));
		ids.forEach((id) => inGroup.add(id));
		const took = rows.filter((r) => ids.has(r.user_id)); // ball bo'yicha tartiblangan
		if (!took.length && !sentGroups.has(g.id)) continue;
		let part = `👥 <b>${esc(g.name)}</b> — ${took.length}/${ids.size} topshirdi`;
		if (took.length) {
			const avg = Math.round(took.reduce((s, r) => s + (r.score * 100) / r.total, 0) / took.length);
			part += `, o'rtacha ${avg}%`;
		}
		part += "\n" + took.map((r, i) => line(i + 1, r)).join("\n");
		const missing = gm.filter((m) => !done.has(m.user_id)).map((m) => m.full_name as string).sort();
		if (missing.length && sentGroups.has(g.id)) part += "\n⏳ Topshirmaganlar: " + missing.map(esc).join(", ");
		sections.push(part.trim());
	}
	const others = rows.filter((r) => !inGroup.has(r.user_id));
	if (others.length) sections.push("👤 <b>Guruhsiz</b>\n" + others.map((r, i) => line(i + 1, r)).join("\n"));
	if (!sections.length) return send(chatId, "Bu testni hali hech kim topshirmagan.");

	// bo'limlarni 4096 belgidan oshirmay yuboramiz
	let text = `📊 <b>${esc(test.title)}</b> (<code>${test.code}</code>)\nJami topshirganlar: ${rows.length}`;
	for (const s of sections) {
		if (text.length + s.length + 2 > 4000) {
			await send(chatId, text);
			text = "";
		}
		text = text ? `${text}\n\n${s}` : s;
	}
	await send(chatId, text.slice(0, 4096));
}

async function setActive(chatId: number, userId: number, code: string, active: number) {
	const test = await ownedTest(userId, code);
	if (!test) return send(chatId, "Test topilmadi. Kodni tekshiring.");
	await run("UPDATE tests SET active=? WHERE id=?", active, test.id);
	await send(chatId, `Test <code>${test.code}</code> ${active ? "ochildi 🟢" : "yopildi 🔴"}.`);
}

async function deleteTest(chatId: number, userId: number, code: string) {
	const test = await ownedTest(userId, code);
	if (!test) return send(chatId, "Test topilmadi. Kodni tekshiring.");
	await env.DB.batch([
		env.DB.prepare("DELETE FROM questions WHERE test_id=?").bind(test.id),
		env.DB.prepare("DELETE FROM results WHERE test_id=?").bind(test.id),
		env.DB.prepare("DELETE FROM test_groups WHERE test_id=?").bind(test.id),
		env.DB.prepare("DELETE FROM tests WHERE id=?").bind(test.id),
	]);
	await send(chatId, `🗑 Test <code>${test.code}</code> o'chirildi.`);
}

// ---------------- O'qituvchi: guruhlar ----------------

async function groupsList(chatId: number, userId: number) {
	const groups = await ownerGroups(userId);
	if (!groups.length) return send(chatId, "Sizda hali guruh yo'q. /newgroup");
	await send(
		chatId,
		"👥 <b>Guruhlaringiz</b> (qavsda — talabalar soni):",
		kb(groups.map((g) => [{ text: `👥 ${g.name} (${g.n})`, callback_data: `grp:show:${g.id}` }])),
	);
}

const groupMembers = (groupId: number) =>
	all(
		`SELECT s.* FROM group_members m JOIN students s ON s.user_id=m.user_id
		 WHERE m.group_id=? ORDER BY s.full_name`,
		groupId,
	);

async function onGroupCallback(call: TgCallback, msg: TgMessage) {
	const [, action, id, extra] = call.data!.split(":");
	if (action === "no") {
		await tg("answerCallbackQuery", { callback_query_id: call.id });
		return editText(msg, "Bekor qilindi.");
	}
	const group = await getGroup(Number(id));
	if (!group || group.owner_id !== call.from.id) {
		return tg("answerCallbackQuery", { callback_query_id: call.id, text: "Guruh topilmadi." });
	}
	const chatId = msg.chat.id;
	const name = esc(group.name);

	if (action === "show") {
		const members = await groupMembers(group.id);
		const lines = members.map((m, i) => `${i + 1}. ${esc(m.full_name)}` + (m.username ? ` (@${m.username})` : ""));
		await tg("answerCallbackQuery", { callback_query_id: call.id });
		const text =
			`👥 <b>${name}</b> — ${members.length} ta talaba\n🔗 Qo'shilish havolasi: ${startLink("g" + group.code)}\n\n` +
			(lines.length ? lines.join("\n") : "Hali hech kim qo'shilmagan.");
		return send(chatId, text.slice(0, 4096), kb([
			[{ text: "➖ Talabani chiqarish", callback_data: `grp:kick:${group.id}` }],
			[{ text: "🗑 Guruhni o'chirish", callback_data: `grp:del:${group.id}` }],
		]));
	}
	if (action === "kick") {
		const members = await groupMembers(group.id);
		await tg("answerCallbackQuery", { callback_query_id: call.id });
		if (!members.length) return send(chatId, "Guruhda talaba yo'q.");
		return send(
			chatId,
			`<b>${name}</b> dan kimni chiqaramiz?`,
			kb(members.slice(0, 90).map((m) => [{ text: `❌ ${m.full_name}`, callback_data: `grp:rm:${group.id}:${m.user_id}` }])),
		);
	}
	if (action === "rm") {
		const userId = Number(extra);
		await run("DELETE FROM group_members WHERE group_id=? AND user_id=?", group.id, userId);
		const student = await getStudent(userId);
		await tg("answerCallbackQuery", { callback_query_id: call.id, text: "Chiqarildi" });
		return editText(msg, `✅ ${esc(student?.full_name ?? String(userId))} <b>${name}</b> guruhidan chiqarildi.`);
	}
	if (action === "del") {
		await tg("answerCallbackQuery", { callback_query_id: call.id });
		return send(chatId, `<b>${name}</b> guruhi o'chirilsinmi? Talabalar natijalari saqlanib qoladi.`, kb([[
			{ text: "Ha, o'chirilsin", callback_data: `grp:delok:${group.id}` },
			{ text: "Yo'q", callback_data: "grp:no:0" },
		]]));
	}
	if (action === "delok") {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM group_members WHERE group_id=?").bind(group.id),
			env.DB.prepare("DELETE FROM test_groups WHERE group_id=?").bind(group.id),
			env.DB.prepare("DELETE FROM groups WHERE id=?").bind(group.id),
		]);
		await tg("answerCallbackQuery", { callback_query_id: call.id });
		return editText(msg, `🗑 <b>${name}</b> guruhi o'chirildi.`);
	}
}

// ---------------- Testni guruhga yuborish ----------------

async function askSendGroups(chatId: number, ownerId: number, testId: number, code: string) {
	const groups = await ownerGroups(ownerId);
	if (!groups.length) {
		return send(chatId, "💡 Guruh yaratsangiz (/newgroup), testni bir tugma bilan butun guruhga yubora olasiz.");
	}
	await send(
		chatId,
		`Testni (<code>${code}</code>) qaysi guruhga yuboramiz? Har bir talabaga botda xabar boradi.`,
		kb(groups.map((g) => [{ text: `📤 ${g.name} (${g.n} ta)`, callback_data: `send:${testId}:${g.id}` }])),
	);
}

async function onSendCallback(call: TgCallback, msg: TgMessage, ctx: ExecutionContext) {
	const [, testId, groupId] = call.data!.split(":").map(Number);
	const test = await one("SELECT * FROM tests WHERE id=?", testId);
	const group = await getGroup(groupId);
	if (!test || !group || test.owner_id !== call.from.id || group.owner_id !== call.from.id) {
		return tg("answerCallbackQuery", { callback_query_id: call.id, text: "Test yoki guruh topilmadi." });
	}
	await tg("answerCallbackQuery", { callback_query_id: call.id, text: "Yuborilmoqda..." });
	await run("INSERT OR IGNORE INTO test_groups (test_id, group_id) VALUES (?, ?)", test.id, group.id);
	const members = await all(
		`SELECT user_id FROM group_members WHERE group_id=?
		 AND user_id NOT IN (SELECT user_id FROM results WHERE test_id=?)`,
		group.id, test.id,
	);
	const payload = JSON.stringify({
		text: `📝 Yangi test: <b>${esc(test.title)}</b>`,
		reply_markup: kb([[{ text: "▶️ Testni boshlash", url: startLink(test.code) }]]),
	});
	const insert = env.DB.prepare("INSERT INTO outbox (chat_id, payload) VALUES (?, ?)");
	if (members.length) await env.DB.batch(members.map((m) => insert.bind(m.user_id, payload)));
	await send(
		msg.chat.id,
		`📤 <b>${esc(group.name)}</b>: ${members.length} ta talabaga yuborilmoqda.` +
			(members.length > 30 ? "\nGuruh katta — hammaga 1–2 daqiqada yetib boradi." : ""),
	);
	ctx.waitUntil(flushOutbox(30));
}

// Navbatdagi xabarlarni jo'natadi. Bepul tarifda bitta chaqiruvda 50 ta tashqi so'rov limiti bor.
async function flushOutbox(limit: number) {
	const rows = await all("SELECT * FROM outbox ORDER BY id LIMIT ?", limit);
	for (const r of rows) {
		// avval o'chiramiz — cron bilan bir vaqtda ikki marta yuborilmasin
		const del = await run("DELETE FROM outbox WHERE id=?", r.id);
		if (!del.meta.changes) continue;
		const { text, reply_markup } = JSON.parse(r.payload);
		try {
			await send(r.chat_id, text, reply_markup);
		} catch (e) {
			console.warn("Talabaga xabar yuborilmadi", r.chat_id, String(e));
		}
	}
}

// ---------------- Talaba ----------------

async function askCodeOrBegin(chatId: number, user: TgUser, code: string) {
	if (code.startsWith("g")) return joinGroup(chatId, user, code.slice(1));
	if (code) return beginTest(chatId, user, code);
	await setState(user.id, "student:code");
	await send(chatId, "O'qituvchingiz bergan test kodini yuboring:");
}

async function joinGroup(chatId: number, user: TgUser, groupCode: string) {
	await clearState(user.id);
	const group = await one("SELECT * FROM groups WHERE code=?", groupCode);
	if (!group) return send(chatId, "❌ Guruh topilmadi. Havolani o'qituvchingizdan qayta so'rang.");
	await run("INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)", group.id, user.id, now());
	await send(
		chatId,
		`✅ Siz <b>${esc(group.name)}</b> guruhiga qo'shildingiz!\n\n` +
			"O'qituvchi test yuborganda shu yerga xabar keladi. Ismingizni o'zgartirish uchun: /name",
	);
}

async function beginTest(chatId: number, user: TgUser, code: string) {
	const test = await getTest(code);
	if (!test) {
		await setState(user.id, "student:code");
		return send(chatId, "❌ Bunday kodli test topilmadi. Qaytadan yuboring:");
	}
	if (!test.active) {
		await clearState(user.id);
		return send(chatId, "🔴 Bu test yopilgan.");
	}
	const done = await one("SELECT score, total FROM results WHERE test_id=? AND user_id=?", test.id, user.id);
	if (done) {
		await clearState(user.id);
		return send(chatId, `Siz bu testni allaqachon topshirgansiz. Natijangiz: ${done.score}/${done.total}`);
	}
	const questions = await getQuestions(test.id);
	await setState(user.id, "student:solving", { test_id: test.id, idx: 0, answers: [] });
	await send(chatId, `📝 <b>${esc(test.title)}</b>\nSavollar soni: ${questions.length} ta\n\nBoshladik! 🍀`);
	await sendQuestion(chatId, questions, 0);
}

async function sendQuestion(chatId: number, questions: Row[], idx: number) {
	const q = questions[idx];
	const options: string[] = q.options.split("\n");
	const text = `<b>${idx + 1}/${questions.length}.</b> ${esc(q.text)}\n\n` + options.map(esc).join("\n");
	await send(chatId, text, kb([options.map((o) => ({ text: o[0], callback_data: `ans:${idx}:${o[0]}` }))]));
}

async function onAnswer(call: TgCallback, msg: TgMessage) {
	const st = await getState(call.from.id);
	if (st.state !== "student:solving") {
		return tg("answerCallbackQuery", {
			callback_query_id: call.id, text: "Bu test sessiyasi tugagan. Qaytadan /start bosing.", show_alert: true,
		});
	}
	const [, idxS, letter] = call.data!.split(":");
	const idx: number = st.data.idx;
	if (Number(idxS) !== idx) {
		return tg("answerCallbackQuery", { callback_query_id: call.id, text: "Bu savolga allaqachon javob berilgan." });
	}
	const answers: string[] = [...st.data.answers, letter];
	const questions = await getQuestions(st.data.test_id);
	// savolni qayta chizamiz (HTML formatlash bilan) va tanlangan javobni qo'shamiz
	const q = questions[idx];
	const qText =
		`<b>${idx + 1}/${questions.length}.</b> ${esc(q.text)}\n\n` +
		q.options.split("\n").map(esc).join("\n") + `\n\n✍️ Javobingiz: <b>${esc(letter)}</b>`;
	await Promise.all([
		editText(msg, qText).catch(() => {}),
		tg("answerCallbackQuery", { callback_query_id: call.id }),
	]);
	if (idx + 1 < questions.length) {
		await setState(call.from.id, "student:solving", { ...st.data, idx: idx + 1, answers });
		await sendQuestion(msg.chat.id, questions, idx + 1);
	} else {
		await clearState(call.from.id);
		await finishTest(msg.chat.id, call.from, st.data.test_id, questions, answers);
	}
}

async function finishTest(chatId: number, user: TgUser, testId: number, questions: Row[], answers: string[]) {
	const score = questions.filter((q, i) => q.correct === answers[i]).length;
	const total = questions.length;
	const pct = Math.round((score * 100) / total);
	const inserted = await run(
		"INSERT OR IGNORE INTO results (test_id, user_id, answers, score, total, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
		testId, user.id, answers.join(""), score, total, now(),
	);
	if (!inserted.meta.changes) return send(chatId, "Siz bu testni allaqachon topshirgansiz.");
	const test = (await one("SELECT * FROM tests WHERE id=?", testId))!;
	const student = await getStudent(user.id);

	await send(chatId, `🏁 Test tugadi!\n\n✅ To'g'ri javoblar: <b>${score}/${total}</b> (${pct}%)\n\nNatijangiz o'qituvchiga yuborildi.`);

	const details = questions.map((q, i) =>
		`${i + 1}. ${answers[i]} ${q.correct === answers[i] ? "✅" : `❌ (to'g'ri: ${q.correct})`}`,
	);
	const groupNames = await studentGroupNames(user.id, test.owner_id);
	const report =
		`📥 <b>Yangi natija</b>\n\n👤 ${esc(student?.full_name ?? "")}${user.username ? esc(` (@${user.username})`) : ""}\n` +
		(groupNames.length ? `👥 ${esc(groupNames.join(", "))}\n` : "") +
		`📝 ${esc(test.title)} (<code>${test.code}</code>)\n✅ Natija: <b>${score}/${total}</b> (${pct}%)\n\n` +
		details.join("\n");
	try {
		await send(test.owner_id, report.slice(0, 4096));
	} catch (e) {
		console.error("O'qituvchiga natija yuborilmadi", String(e));
	}
}

// ---------------- Xabarlarni yo'naltirish ----------------

async function onMessage(msg: TgMessage) {
	const user = msg.from;
	if (!user) return;
	const chatId = msg.chat.id;
	const text = msg.text?.trim() ?? "";
	const admin = isAdmin(user.id);
	let cmd = "";
	let args = "";
	if (text.startsWith("/")) {
		const [first, ...rest] = text.split(/\s+/);
		cmd = first.slice(1).split("@")[0].toLowerCase();
		args = rest.join(" ").trim();
	}

	// buyruqlar har qanday holatda ishlaydi (/done va /skip — holatga bog'liq)
	if (cmd === "cancel") {
		await clearState(user.id);
		return send(chatId, "Bekor qilindi.");
	}
	if (cmd === "start") {
		await clearState(user.id);
		if (admin && !args) return send(chatId, TEACHER_HELP);
		if (!(await getStudent(user.id))) {
			await setState(user.id, "student:name", { code: args });
			return send(chatId, "Assalomu alaykum! 👋\nIsm va familiyangizni yozing:");
		}
		return askCodeOrBegin(chatId, user, args);
	}
	if (cmd === "name") {
		await setState(user.id, "student:name");
		return send(chatId, "Yangi ism va familiyangizni yozing:");
	}
	if (admin) {
		switch (cmd) {
			case "prompt":
				await send(
					chatId,
					"🤖 <b>Claude yoki ChatGPT orqali test tuzish</b>\n\n" +
						"1. Quyidagi promptni nusxa oling (ustiga bosing), [ ] ichini o'zgartiring va Claude/ChatGPT ga yuboring.\n" +
						"   Darslik yoki ma'ruza bo'lsa, faylni ham chatga biriktiring.\n" +
						"2. Javobni nusxa oling (kod blokidagi «Copy» tugmasi).\n" +
						"3. Bu yerda /newtest → test nomi → nusxa olingan matnni yuboring → /done.\n\n" +
						"Savollar ko'p bo'lsa (≈20+), matn bitta xabarga sig'masligi mumkin: " +
						"bir necha xabarda yuboring yoki AI dan <i>.txt fayl qilib ber</i> deb so'rang va faylni yuboring.",
				);
				return send(chatId, `<code>${esc(AI_PROMPT)}</code>`);
			case "newtest":
				await setState(user.id, "newtest:title");
				return send(chatId, "Test nomini yuboring (masalan: <i>Matematika, 1-nazorat</i>):");
			case "newgroup":
				await setState(user.id, "newgroup:name");
				return send(chatId, "Guruh nomini yozing (masalan: <i>1-guruh</i> yoki <i>101-A</i>):");
			case "groups":
				return groupsList(chatId, user.id);
			case "send": {
				const test = await ownedTest(user.id, args);
				if (!test) return send(chatId, "Foydalanish: /send KOD");
				return askSendGroups(chatId, user.id, test.id, test.code);
			}
			case "mytests":
				return myTests(chatId, user.id);
			case "results":
				return results(chatId, user.id, args);
			case "close":
				return setActive(chatId, user.id, args, 0);
			case "open":
				return setActive(chatId, user.id, args, 1);
			case "delete":
				return deleteTest(chatId, user.id, args);
		}
	}

	const st = await getState(user.id);
	switch (st.state) {
		case "newtest:title":
			if (!text || cmd) break;
			await setState(user.id, "newtest:questions", { title: text, questions: [] });
			return send(chatId, FORMAT_HELP);
		case "newtest:questions": {
			if (cmd === "done") {
				const questions: Question[] = st.data.questions ?? [];
				if (!questions.length) return send(chatId, "Hali birorta savol qo'shilmadi. Savollarni yuboring yoki /cancel.");
				await clearState(user.id);
				return saveTest(chatId, user.id, st.data.title, questions);
			}
			if (msg.document) {
				const name = (msg.document.file_name ?? "").toLowerCase();
				if (!name.endsWith(".txt") && !name.endsWith(".md")) {
					return send(chatId, "Faqat .txt fayl qabul qilinadi (yoki matnni xabar qilib yuboring).");
				}
				const file = await tg("getFile", { file_id: msg.document.file_id });
				const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
				const raw = (await res.text()).replace(/^﻿/, "");
				return addQuestions(chatId, user.id, st, raw);
			}
			if (text && !cmd) return addQuestions(chatId, user.id, st, msg.text!);
			break;
		}
		case "newgroup:name": {
			if (!text || cmd) break;
			const name = text.slice(0, 60);
			const code = await newCode("groups");
			await run("INSERT INTO groups (code, name, owner_id) VALUES (?, ?, ?)", code, name, user.id);
			await clearState(user.id);
			return send(
				chatId,
				`✅ <b>${esc(name)}</b> guruhi yaratildi.\n\n` +
					`Shu havolani guruh talabalariga yuboring (masalan, guruh chatiga tashlang):\n${startLink("g" + code)}\n\n` +
					"Talaba havolani bosib, ism-familiyasini yozadi va guruhga qo'shiladi. /groups",
			);
		}
		case "student:name": {
			if (!text) break;
			if (text.length < 3 || cmd) return send(chatId, "Iltimos, to'liq ism-familiyangizni yozing:");
			await run(
				"INSERT INTO students (user_id, full_name, username) VALUES (?, ?, ?) " +
					"ON CONFLICT(user_id) DO UPDATE SET full_name=excluded.full_name, username=excluded.username",
				user.id, text, user.username ?? null,
			);
			await send(chatId, `Rahmat, ${esc(text)}!`);
			return askCodeOrBegin(chatId, user, st.data.code ?? "");
		}
		case "student:code":
			if (text && !cmd) return beginTest(chatId, user, text);
			break;
		case "student:solving":
			return send(chatId, "Javobni tugmalar orqali tanlang 👆");
	}

	if (admin) return send(chatId, TEACHER_HELP);
	await setState(user.id, "student:code");
	await send(chatId, "Test kodini yuboring (yoki /start):");
}

async function onCallback(call: TgCallback, ctx: ExecutionContext) {
	const msg = call.message;
	const data = call.data ?? "";
	if (!msg) return tg("answerCallbackQuery", { callback_query_id: call.id });
	if (data.startsWith("ans:")) return onAnswer(call, msg);
	if (data.startsWith("grp:")) return onGroupCallback(call, msg);
	if (data.startsWith("send:")) return onSendCallback(call, msg, ctx);
	await tg("answerCallbackQuery", { callback_query_id: call.id });
}

// ---------------- Worker ----------------

export default {
	async fetch(request, _env, ctx) {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/webhook") {
			return new Response("Test bot ishlayapti ✅", { headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
			return new Response("forbidden", { status: 403 });
		}
		const update: TgUpdate = await request.json();
		try {
			if (update.message) await onMessage(update.message);
			else if (update.callback_query) await onCallback(update.callback_query, ctx);
		} catch (e) {
			// Telegram qayta-qayta yubormasligi uchun baribir 200 qaytaramiz
			console.error("Update xatosi", String(e), e instanceof Error ? e.stack : "");
		}
		return new Response("ok");
	},

	async scheduled() {
		await flushOutbox(45);
	},
} satisfies ExportedHandler;
