// Bot va sayt uchun umumiy: Telegram API, baza, natijani saqlash.
import { env } from "cloudflare:workers";

// ---------------- Telegram turlari ----------------

export interface TgUser { id: number; username?: string; first_name?: string; last_name?: string }
export interface TgContact { phone_number: string; user_id?: number }
export interface TgDocument { file_id: string; file_name?: string; file_size?: number }
export interface TgMessage { message_id: number; chat: { id: number }; from?: TgUser; text?: string; caption?: string; document?: TgDocument; contact?: TgContact }
export interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
export interface TgUpdate { message?: TgMessage; callback_query?: TgCallback }
export type Button = { text: string; callback_data?: string; url?: string };
export type Keyboard = { inline_keyboard: Button[][] };

export type Row = Record<string, any>;
export type Question = { text: string; options: string[]; correct: string };

// ---------------- Yordamchilar ----------------

export const isAdmin = (id: number) => env.ADMIN_IDS.split(",").map((x) => Number(x.trim())).includes(id);
export const now = () => new Date().toISOString().slice(0, 19);
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const kb = (rows: Button[][]): Keyboard => ({ inline_keyboard: rows });
export const startLink = (arg: string) => `https://t.me/${env.BOT_USERNAME}?start=${arg}`;

export async function tg(method: string, params: Record<string, unknown>): Promise<any> {
	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
	});
	const data: any = await res.json();
	if (!data.ok) throw new Error(`${method}: ${data.description}`);
	return data.result;
}

export const send = (chatId: number, text: string, markup?: Keyboard) =>
	tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } });

export const editText = (msg: TgMessage, text: string, markup?: Keyboard) =>
	tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: "HTML", reply_markup: markup });

export const removeKb = (msg: TgMessage) =>
	tg("editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});

// ---------------- Ma'lumotlar bazasi ----------------

export const one = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<Row>();
export const all = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<Row>()).results;
export const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();

export async function newCode(table: "tests" | "groups") {
	for (;;) {
		const code = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
		if (!(await one(`SELECT 1 FROM ${table} WHERE code=?`, code))) return code;
	}
}

export const getTest = (code: string) => one("SELECT * FROM tests WHERE code=?", code);
export const getQuestions = (testId: number) => all("SELECT * FROM questions WHERE test_id=? ORDER BY position", testId);
export const getStudent = (userId: number) => one("SELECT * FROM students WHERE user_id=?", userId);
export const getGroup = (groupId: number) => one("SELECT * FROM groups WHERE id=?", groupId);

export const ownerGroups = (ownerId: number) =>
	all(
		`SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS n
		 FROM groups g WHERE owner_id=? ORDER BY name`,
		ownerId,
	);

export async function studentGroupNames(userId: number, ownerId: number) {
	const rows = await all(
		`SELECT g.name FROM groups g JOIN group_members m ON m.group_id=g.id
		 WHERE m.user_id=? AND g.owner_id=? ORDER BY g.name`,
		userId, ownerId,
	);
	return rows.map((r) => r.name as string);
}

// ---------------- Holat (FSM) ----------------

export type State = { state: string | null; data: Row };

export async function getState(userId: number): Promise<State> {
	const row = await one("SELECT state, data FROM states WHERE user_id=?", userId);
	return row ? { state: row.state, data: JSON.parse(row.data) } : { state: null, data: {} };
}

export const setState = (userId: number, state: string | null, data: Row = {}) =>
	run(
		"INSERT INTO states (user_id, state, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data",
		userId, state, JSON.stringify(data),
	);

export const clearState = (userId: number) => run("DELETE FROM states WHERE user_id=?", userId);

// ---------------- Natija (bot va sayt uchun bir xil) ----------------

export const webLink = (code: string) => `${env.SITE_URL}/t/${code}`;

// Natijani saqlaydi va o'qituvchiga hisobot yuboradi. Avval topshirgan bo'lsa null qaytaradi.
export async function saveResult(user: TgUser, testId: number, questions: Row[], answers: string[]) {
	const score = questions.filter((q, i) => q.correct === answers[i]).length;
	const total = questions.length;
	const pct = Math.round((score * 100) / total);
	const inserted = await run(
		"INSERT OR IGNORE INTO results (test_id, user_id, answers, score, total, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
		testId, user.id, answers.join(""), score, total, now(),
	);
	if (!inserted.meta.changes) return null;
	const test = (await one("SELECT * FROM tests WHERE id=?", testId))!;
	const student = await getStudent(user.id);

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
	return { score, total, pct };
}
