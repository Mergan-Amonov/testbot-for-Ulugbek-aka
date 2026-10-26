// Sayt: talaba testni brauzerda yechadi. Kirish — Telegram bot orqali:
// sayt havola beradi, bot telefon raqamini so'raydi va bitta raqam ko'rsatadi, talaba saytda uchta raqamdan mosini bosadi.
import qrcode from "qrcode-generator";
import {
	type Row, type TgContact, type TgUser,
	all, esc, getQuestions, getStudent, getTest, one, run, send, tg,
} from "./common.ts";
import { STICKERS } from "./sticker.ts";
import { env } from "cloudflare:workers";

const LOGIN_TTL = 10 * 60_000;
const SESSION_TTL = 30 * 86_400_000;
const fresh = () => Date.now() - LOGIN_TTL;

// ---------------- Yordamchilar ----------------

const h = (s: unknown) => esc(String(s ?? "")).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const randomToken = (bytes: number) =>
	btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomInt = (min: number, max: number) => min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min));

// To'g'ri raqam va saytda ko'rsatiladigan uchta turli ikki xonali raqam (aralash tartibda).
function codeOptions() {
	const set = new Set<number>();
	while (set.size < 3) set.add(randomInt(10, 100));
	const options = [...set];
	const code = options[0];
	for (let i = options.length - 1; i > 0; i--) {
		const j = randomInt(0, i + 1);
		[options[i], options[j]] = [options[j], options[i]];
	}
	return { code, options };
}

function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// Bot xabari yuborilmasa ham saytdagi jarayon to'xtamasin.
const notify = (chatId: number | null, text: string) =>
	chatId ? send(chatId, text).catch((e) => console.warn("Botga xabar yuborilmadi", String(e))) : undefined;

// ---------------- Sessiya ----------------

type Session = { id: string; user_id: number | null; csrf: string; data: Row };
type Ctx = { request: Request; url: URL; s: Session | null; setCookie: string | null };

async function loadSession(request: Request): Promise<Session | null> {
	const sid = request.headers.get("cookie")?.match(/(?:^|;\s*)sid=([A-Za-z0-9_-]+)/)?.[1];
	if (!sid) return null;
	const row = await one("SELECT * FROM web_sessions WHERE id=? AND created_at>?", sid, Date.now() - SESSION_TTL);
	return row ? { id: row.id, user_id: row.user_id, csrf: row.csrf, data: JSON.parse(row.data) } : null;
}

async function newSession(c: Ctx, userId: number | null, data: Row = {}) {
	const s: Session = { id: randomToken(24), user_id: userId, csrf: randomToken(18), data };
	await run(
		"INSERT INTO web_sessions (id, user_id, csrf, data, created_at) VALUES (?, ?, ?, ?, ?)",
		s.id, userId, s.csrf, JSON.stringify(data), Date.now(),
	);
	c.s = s;
	c.setCookie = `sid=${s.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;
	return s;
}

const ensureSession = async (c: Ctx) => c.s ?? newSession(c, null);
const saveSession = (s: Session) => run("UPDATE web_sessions SET user_id=?, data=? WHERE id=?", s.user_id, JSON.stringify(s.data), s.id);

async function flash(c: Ctx, text: string) {
	const s = await ensureSession(c);
	s.data.flash = text;
	await saveSession(s);
}

async function form(c: Ctx) {
	const f = await c.request.formData();
	const ok = !!c.s && safeEqual(String(f.get("_csrf") ?? ""), c.s.csrf);
	return ok ? f : null;
}

// ---------------- Javoblar ----------------

const STYLE = `
:root { --bg: #f6f7f9; --card: #fff; --text: #16181d; --muted: #646b78; --line: #e3e6eb; --accent: #2a7ae2; --accent-text: #fff;
	--ok: #1f8a4c; --bad: #c63b3b; --ok-bg: #eaf7ef; --bad-bg: #fcecec; --pick: #eaf2fd; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --card: #1a1d23; --text: #e9ebef; --muted: #9aa1ad; --line: #2c3038;
	--accent: #5b9cf0; --accent-text: #0b1220; --ok: #4cc27f; --bad: #ef6b6b; --ok-bg: #16291e; --bad-bg: #2e1a1a; --pick: #1d2a3d; color-scheme: dark; } }
* { box-sizing: border-box; } [hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
header a { color: var(--text); text-decoration: none; font-weight: 700; }
h1 { font-size: 24px; margin: 0 0 12px; } h2 { font-size: 18px; margin: 24px 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 16px; }
.muted { color: var(--muted); } .small { font-size: 14px; }
.btn { display: inline-block; width: 100%; padding: 12px 16px; border-radius: 10px; border: 1px solid var(--line); background: var(--card);
	color: var(--text); font: inherit; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.btn.link { width: auto; padding: 6px 10px; font-weight: 500; }
input[type=text] { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; }
.row { display: flex; gap: 8px; } .row input { flex: 1; } .row .btn { width: auto; }
.stack > * + * { margin-top: 12px; }
.flash { background: var(--pick); border: 1px solid var(--accent); border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; }
.list { list-style: none; padding: 0; margin: 0; } .list li { border-top: 1px solid var(--line); padding: 10px 0; display: flex; justify-content: space-between; gap: 12px; }
.list li:first-child { border-top: 0; } .list a { color: var(--accent); }
.q { white-space: pre-line; font-weight: 600; margin-bottom: 10px; }
.opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; margin-top: 8px; cursor: pointer; }
.opt:has(input:checked) { border-color: var(--accent); background: var(--pick); }
.opt input { margin-top: 4px; }
.opt.ok { border-color: var(--ok); background: var(--ok-bg); } .opt.bad { border-color: var(--bad); background: var(--bad-bg); }
.opt .mark { width: 14px; flex: none; font-weight: 700; } .opt.ok .mark { color: var(--ok); } .opt.bad .mark { color: var(--bad); }
.card.wrong { border-left: 4px solid var(--bad); } .card.right { border-left: 4px solid var(--ok); }
.only-wrong .card.right { display: none; }
.actions { display: grid; gap: 8px; }
button.opt { width: 100%; text-align: left; font: inherit; color: var(--text); background: var(--card); }
button.opt:not(:disabled):hover { border-color: var(--accent); }
button.opt:disabled { cursor: default; opacity: 1; }
.verdict { margin-top: 12px; font-weight: 600; } .verdict.good { color: var(--ok); } .verdict.wrong { color: var(--bad); }
.step .next { margin-top: 12px; }
.made { position: fixed; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px;
	background: var(--card); border: 1px solid var(--line); border-radius: 14px; color: var(--muted); font-size: 12px; z-index: 10; }
main { padding-bottom: 88px; }
.made a { color: inherit; text-decoration: none; } .made a:hover b { color: var(--accent); }
.made img { border-radius: 10px; cursor: pointer; transition: transform .15s; } .made img:hover { transform: rotate(-8deg) scale(1.1); }
.bar { height: 6px; background: var(--line); border-radius: 3px; margin-bottom: 16px; overflow: hidden; }
.bar div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.nums .btn { font-size: 28px; font-weight: 700; min-height: 72px; }
.score { font-size: 44px; font-weight: 800; margin: 4px 0; }
.qr { text-align: center; } .qr div { width: 200px; max-width: 70%; margin: 0 auto; padding: 8px; background: #fff; border-radius: 12px; border: 1px solid #e5e7eb; }
.qr svg { display: block; width: 100%; height: auto; } @media (max-width: 720px) { .qr { display: none; } }
`;

// Pastki yozuv: ikki stikerdan biri tasodifiy chiqadi, bosilsa almashadi.
const FOOTER = `<footer class="made">
	<img id="sticker" src="/sticker/hehe.webp" alt="mushuk stiker" width="44" height="44">
	<a href="https://t.me/merganjan" target="_blank" rel="noopener">made by <b>Mergan</b></a>
</footer>
<script>
	(function () {
		var s = document.getElementById("sticker"), names = ["hehe", "smile"], i = Math.random() < 0.5 ? 0 : 1;
		s.src = "/sticker/" + names[i] + ".webp";
		s.addEventListener("click", function () { i = 1 - i; s.src = "/sticker/" + names[i] + ".webp"; });
	})();
</script>`;

function sticker(name: string) {
	const b64 = STICKERS[name];
	if (!b64) return null;
	const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
	return new Response(bytes, { headers: { "content-type": "image/webp", "cache-control": "public, max-age=604800" } });
}

async function page(c: Ctx, title: string, body: string, status = 200) {
	let flashHtml = "";
	if (c.s?.data.flash) {
		flashHtml = `<div class="flash">${h(c.s.data.flash)}</div>`;
		delete c.s.data.flash;
		await saveSession(c.s);
	}
	const user = c.s?.user_id ? await getStudent(c.s.user_id) : null;
	const logout = user
		? `<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${h(c.s!.csrf)}">
			<span class="small muted">${h(user.full_name)}</span> <button class="btn link" type="submit">Chiqish</button></form>`
		: "";
	const html = `<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(title)}</title><style>${STYLE}</style></head>
<body><main><header><a href="/">📝 Test</a>${logout}</header>${flashHtml}${body}${FOOTER}</main></body></html>`;
	return respond(c, new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
}

function respond(c: Ctx, res: Response) {
	res.headers.set("cache-control", "no-store");
	res.headers.set("x-frame-options", "DENY");
	res.headers.set("referrer-policy", "no-referrer");
	if (c.setCookie) res.headers.append("set-cookie", c.setCookie);
	return res;
}

const redirect = (c: Ctx, to: string) => respond(c, new Response(null, { status: 303, headers: { location: to } }));
const csrfInput = (s: Session) => `<input type="hidden" name="_csrf" value="${h(s.csrf)}">`;

// Kirgandan keyin qaytiladigan sahifa (faqat test sahifalari).
const nextUrl = (s: Session) => (typeof s.data.next === "string" && /^\/t\/\d+$/.test(s.data.next) ? s.data.next : "/");

// ---------------- Kirish ----------------

async function loginPage(c: Ctx) {
	if (c.s?.user_id) return redirect(c, "/");
	const s = await ensureSession(c);
	const pub = await all("SELECT title FROM tests WHERE public=1 AND active=1 ORDER BY id DESC");
	const pubHtml = pub.length
		? `<h2>Ochiq testlar</h2><div class="card"><ul class="list">${pub.map((t) => `<li><span>${h(t.title)}</span></li>`).join("")}</ul></div>`
		: "";
	return page(c, "Kirish", `<div class="card stack">
		<h1>Testga kirish</h1>
		<p class="muted">Testlarni saytda yechib tayyorlanish uchun Telegram orqali kiring.</p>
		<form method="post" action="/login/start">${csrfInput(s)}<button class="btn primary" type="submit">Telegram orqali kirish</button></form>
	</div>${pubHtml}`);
}

async function loginStart(c: Ctx) {
	if (!(await form(c))) return redirect(c, "/login");
	await env.DB.batch([
		env.DB.prepare("DELETE FROM telegram_logins WHERE created_at<?").bind(Date.now() - 86_400_000),
		env.DB.prepare("DELETE FROM web_sessions WHERE created_at<?").bind(Date.now() - SESSION_TTL),
	]);
	const token = randomToken(18);
	const { code, options } = codeOptions();
	await run(
		"INSERT INTO telegram_logins (token, code, options, created_at) VALUES (?, ?, ?, ?)",
		token, code, options.join(","), Date.now(),
	);
	c.s!.data.login = token;
	await saveSession(c.s!);
	return redirect(c, "/login/wait");
}

const currentLogin = (c: Ctx) =>
	c.s?.data.login ? one("SELECT * FROM telegram_logins WHERE token=? AND created_at>?", c.s.data.login, fresh()) : null;

async function loginWait(c: Ctx) {
	const row = await currentLogin(c);
	if (!row || row.status === "done" || row.status === "failed") {
		await flash(c, "Telegram orqali kirish uchun tugmani qaytadan bosing.");
		return redirect(c, "/login");
	}
	if (row.status === "contact") {
		const buttons = String(row.options).split(",").map((n) => `<form method="post" action="/login/confirm">${csrfInput(c.s!)}
			<input type="hidden" name="choice" value="${h(n)}"><button class="btn" type="submit">${h(n)}</button></form>`);
		return page(c, "Telegram orqali kirish", `<div class="card stack">
			<h1>Raqamni tanlang</h1>
			<p>Telegram botda ko'rsatilgan raqamni bosing:</p>
			<div class="nums">${buttons.join("")}</div>
			<p class="small muted">Noto'g'ri raqam tanlansa, kirish bekor qilinadi.</p>
		</div>`);
	}
	const botLink = `https://t.me/${env.BOT_USERNAME}?start=web_${row.token}`;
	// Kompyuterdan kirganlar uchun: telefon kamerasi bilan skanerlab botni ochadi.
	const qr = qrcode(0, "M");
	qr.addData(botLink);
	qr.make();
	return page(c, "Telegram orqali kirish", `<div class="card stack">
		<h1>Telegram orqali kirish</h1>
		<ol style="padding-left: 20px; margin: 0">
			<li>Telegram botni oching va <b>Start</b> ni bosing.</li>
			<li>Botga telefon raqamingizni yuboring.</li>
			<li>Shu sahifada uchta raqam chiqadi — botdagisiga mosini bosing.</li>
		</ol>
		<a class="btn primary" href="${h(botLink)}" target="_blank" rel="noopener">Telegram botni ochish</a>
		<div class="qr"><div>${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
			<p class="small muted">Kompyuterdamisiz? Telefon kamerasi bilan skanerlang — bot telefonda ochiladi.</p></div>
		<p class="small muted">Telefon raqamingiz kutilmoqda…</p>
	</div>
	<script>
		(function poll() {
			fetch("/login/status", { cache: "no-store" })
				.then(function (r) { return r.json(); })
				.then(function (d) { if (d.status !== ${JSON.stringify(row.status)}) location.reload(); else setTimeout(poll, 2000); })
				.catch(function () { setTimeout(poll, 4000); });
		})();
	</script>`);
}

async function loginStatus(c: Ctx) {
	const row = await currentLogin(c);
	return respond(c, Response.json({ status: row ? row.status : "expired" }));
}

async function loginConfirm(c: Ctx) {
	const f = await form(c);
	const row = f ? await currentLogin(c) : null;
	const s = await ensureSession(c);
	delete s.data.login;
	if (!row || row.status !== "contact") {
		s.data.flash = "Kirish so'rovi eskirgan. Qaytadan urinib ko'ring.";
		await saveSession(s);
		return redirect(c, "/login");
	}
	const ok = Number(f!.get("choice")) === row.code;
	const done = await one(
		"UPDATE telegram_logins SET status=? WHERE token=? AND status='contact' RETURNING token",
		ok ? "done" : "failed", row.token,
	);
	if (!ok || !done) {
		await notify(row.chat_id, "❌ Saytda noto'g'ri raqam tanlandi. Kirish uchun saytda qaytadan urinib ko'ring.");
		s.data.flash = "Raqam mos kelmadi. Qaytadan urinib ko'ring.";
		await saveSession(s);
		return redirect(c, "/login");
	}

	// kirgandan keyin sessiya yangilanadi (eski sessiya id si boshqa birovda bo'lsa ham ishlamasin)
	const next = nextUrl(s);
	await run("DELETE FROM web_sessions WHERE id=?", s.id);
	const phone = "+" + String(row.phone ?? "").replace(/\D/g, "");
	if (await getStudent(row.telegram_id)) {
		await run("UPDATE students SET phone=?, username=? WHERE user_id=?", phone, row.username, row.telegram_id);
		await notify(row.chat_id, "✅ Saytga kirdingiz.");
		await newSession(c, row.telegram_id);
		return redirect(c, next);
	}
	await notify(row.chat_id, "✅ Raqam tasdiqlandi. Saytda ism-familiyangizni yozing.");
	await newSession(c, null, {
		next,
		pending: { id: row.telegram_id, name: row.name ?? "", username: row.username, phone },
	});
	return redirect(c, "/register");
}

// Botda hech qachon ism yozmagan talaba: ism-familiyasini saytda yozadi.
async function register(c: Ctx) {
	const pending = c.s?.data.pending;
	if (!pending) return redirect(c, "/login");
	let error = "";
	let name: string = pending.name;
	if (c.request.method === "POST") {
		const f = await form(c);
		if (!f) return redirect(c, "/register");
		name = String(f.get("name") ?? "").trim().slice(0, 120);
		if (name.length >= 3) {
			await run(
				"INSERT INTO students (user_id, full_name, username, phone) VALUES (?, ?, ?, ?) " +
					"ON CONFLICT(user_id) DO UPDATE SET full_name=excluded.full_name, username=excluded.username, phone=excluded.phone",
				pending.id, name, pending.username ?? null, pending.phone,
			);
			const s = c.s!;
			s.user_id = pending.id;
			delete s.data.pending;
			const next = nextUrl(s);
			delete s.data.next;
			await saveSession(s);
			return redirect(c, next);
		}
		error = `<p style="color: var(--bad)">Iltimos, to'liq ism-familiyangizni yozing.</p>`;
	}
	return page(c, "Ro'yxatdan o'tish", `<form class="card stack" method="post" action="/register">${csrfInput(c.s!)}
		<h1>Ism-familiyangiz</h1>
		<p class="muted">Telegram tasdiqlandi. O'qituvchi natijangizni shu ism bilan ko'radi.</p>
		${error}
		<input type="text" name="name" value="${h(name)}" required minlength="3" maxlength="120" autofocus>
		<button class="btn primary" type="submit">Davom etish</button>
	</form>`);
}

async function logout(c: Ctx) {
	if (await form(c)) await run("DELETE FROM web_sessions WHERE id=?", c.s!.id);
	c.setCookie = "sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
	return redirect(c, "/login");
}

// ---------------- Talaba sahifalari ----------------

async function home(c: Ctx) {
	const userId = c.s!.user_id!;
	const [open, done] = await Promise.all([
		all(
			`SELECT t.id, t.code, t.title FROM tests t
			 WHERE t.active=1 AND (t.public=1 OR t.id IN (
			   SELECT tg.test_id FROM test_groups tg JOIN group_members m ON m.group_id=tg.group_id WHERE m.user_id=?))
			 ORDER BY t.public DESC, t.id DESC`,
			userId,
		),
		all(
			`SELECT t.code, t.title, r.score, r.total FROM results r JOIN tests t ON t.id=r.test_id
			 WHERE r.user_id=? ORDER BY r.finished_at DESC LIMIT 50`,
			userId,
		),
	]);
	const openList = open.length
		? `<ul class="list">${open.map((t) => `<li><span>${h(t.title)}</span><a href="/t/${h(t.code)}">Yechish →</a></li>`).join("")}</ul>`
		: `<p class="muted">Hozircha yangi test yo'q.</p>`;
	const doneList = done.length
		? `<div class="card"><ul class="list">${done.map((r) => `<li><span>${h(r.title)}</span>
			<b>${r.score}/${r.total} (${Math.round((r.score * 100) / r.total)}%)</b></li>`).join("")}</ul></div>`
		: "";
	return page(c, "Testlar", `<form class="card stack" method="get" action="/t">
			<h1>Test kodi</h1>
			<div class="row"><input type="text" name="code" inputmode="numeric" pattern="\\d+" placeholder="Masalan: 12345" required>
			<button class="btn primary" type="submit">Boshlash</button></div>
		</form>
		<h2>Testlar</h2><div class="card">${openList}</div>
		${done.length ? "<h2>Botda topshirilgan testlar</h2>" + doneList : ""}`);
}

// Saytda test — tayyorgarlik uchun: 20 tadan savolli qismlar, cheksiz qayta yechish, natija shu yerda ko'rinadi.
// O'qituvchiga yuborilmaydi va botdagi rasmiy natijaga (results) ta'sir qilmaydi.
const PART = 20;

const partLabel = (part: number, total: number) =>
	part ? `${part}-qism (${(part - 1) * PART + 1}–${Math.min(part * PART, total)})` : `Barcha savollar (${total} ta)`;

// Test, login va ochiqlikni tekshiradi. Muammo bo'lsa tayyor javob qaytaradi.
async function practiceTest(c: Ctx, code: string): Promise<{ res: Response } | { test: Row; questions: Row[]; userId: number }> {
	const test = await getTest(code);
	if (!test) {
		return { res: await page(c, "Topilmadi", `<div class="card"><h1>Test topilmadi</h1><p class="muted">Kodni tekshiring.</p><a class="btn" href="/">Orqaga</a></div>`, 404) };
	}
	if (!c.s?.user_id) {
		const s = await ensureSession(c);
		s.data.next = `/t/${test.code}`;
		await saveSession(s);
		return { res: redirect(c, "/login") };
	}
	if (!test.active) {
		return { res: await page(c, test.title, `<div class="card"><h1>${h(test.title)}</h1><p>🔴 Bu test yopilgan.</p><a class="btn" href="/">Orqaga</a></div>`) };
	}
	return { test, questions: await getQuestions(test.id), userId: c.s.user_id };
}

// part: 0 — barcha savollar, 1.. — 20 tadan qismlar
function partSlice(questions: Row[], part: number) {
	const parts = Math.ceil(questions.length / PART);
	if (!Number.isInteger(part) || part < 0 || part > parts) return null;
	const offset = part ? (part - 1) * PART : 0;
	return { parts, offset, slice: part ? questions.slice(offset, offset + PART) : questions };
}

const notFound = (c: Ctx) =>
	page(c, "Topilmadi", `<div class="card"><h1>Sahifa topilmadi</h1><a class="btn" href="/">Bosh sahifa</a></div>`, 404);

async function testOverview(c: Ctx, code: string) {
	const r = await practiceTest(c, code);
	if ("res" in r) return r.res;
	const { test, questions, userId } = r;
	const parts = Math.ceil(questions.length / PART);
	if (parts <= 1) return redirect(c, `/t/${test.code}/1`);
	const attempts = await all(
		"SELECT id, part, score, total FROM web_attempts WHERE user_id=? AND test_id=? ORDER BY id DESC",
		userId, test.id,
	);
	const item = (part: number) => {
		const mine = attempts.filter((a) => a.part === part);
		const stat = mine.length
			? `Oxirgi: <a href="/t/${h(test.code)}/r/${mine[0].id}">${mine[0].score}/${mine[0].total}</a> · ` +
				`eng yaxshi: ${Math.max(...mine.map((a) => a.score))}/${mine[0].total} · ${mine.length} marta`
			: "Hali yechilmagan";
		return `<li><div><b>${h(partLabel(part, questions.length))}</b><div class="small muted">${stat}</div></div>
			<a class="btn link" href="/t/${h(test.code)}/${part || "all"}">Yechish</a></li>`;
	};
	const list = Array.from({ length: parts }, (_, i) => item(i + 1)).join("") + item(0);
	return page(c, test.title, `<h1>${h(test.title)}</h1>
		<p class="muted">${questions.length} ta savol, ${PART} tadan qismlarga bo'lingan. Har bir qismni xohlagancha qayta yechish mumkin —
		natija va to'g'ri javoblar oxirida ko'rsatiladi.</p>
		<div class="card"><ul class="list">${list}</ul></div>`);
}

async function partPage(c: Ctx, code: string, partArg: string) {
	const r = await practiceTest(c, code);
	if ("res" in r) return r.res;
	const { test, questions, userId } = r;
	const part = partArg === "all" ? 0 : Number(partArg);
	const p = partSlice(questions, part);
	if (!p) return notFound(c);

	let answers: string[] = [];
	let error = "";
	if (c.request.method === "POST") {
		const f = await form(c);
		if (!f) return redirect(c, `/t/${test.code}/${partArg}`);
		answers = p.slice.map((_, i) => String(f.get(`q${i}`) ?? ""));
		const valid = p.slice.every((q, i) => q.options.split("\n").some((o: string) => o[0] === answers[i]));
		if (valid) {
			const score = p.slice.filter((q, i) => q.correct === answers[i]).length;
			const row = await one(
				"INSERT INTO web_attempts (user_id, test_id, part, answers, score, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
				userId, test.id, part, answers.join(""), score, p.slice.length, Date.now(),
			);
			return redirect(c, `/t/${test.code}/r/${row!.id}`);
		}
		error = `<div class="flash">Iltimos, hamma savolga javob bering.</div>`;
	}

	// Bitta-bitta savol: javob bosilganda to'g'ri/xato darhol ko'rinadi, keyin "Keyingi".
	// Oxirgi savoldan keyin javoblar yuboriladi va natija sahifasi ochiladi.
	const last = p.slice.length - 1;
	const items = p.slice.map((q, i) => {
		const opts = (q.options as string).split("\n").map((o) =>
			`<button type="button" class="opt pick" data-l="${h(o[0])}"><span class="mark"></span><span>${h(o)}</span></button>`);
		return `<div class="card step" data-i="${i}" data-c="${h(q.correct)}"${i ? " hidden" : ""}>
			<div class="small muted">${i + 1} / ${p.slice.length}</div>
			<div class="q">${p.offset + i + 1}. ${h(q.text)}</div>
			${opts.join("")}
			<input type="hidden" name="q${i}" value="${h(answers[i] ?? "")}">
			<div class="verdict" hidden></div>
			<button type="button" class="btn primary next" hidden>${i === last ? "Natijani ko'rish" : "Keyingi →"}</button>
		</div>`;
	});
	const back = p.parts > 1 ? `<a href="/t/${h(test.code)}">← Barcha qismlar</a>` : `<a href="/">← Bosh sahifa</a>`;
	return page(c, test.title, `<p class="small">${back}</p>
		<h1>${h(test.title)}</h1>
		<p class="muted">${h(partLabel(part, questions.length))} · <span id="tally">✓ 0 · ✗ 0</span></p>
		<div class="bar"><div id="progress"></div></div>
		${error}
		<form id="quiz" method="post" action="/t/${h(test.code)}/${part || "all"}">${csrfInput(c.s!)}
			${items.join("")}
		</form>
		<script>
			(function () {
				var form = document.getElementById("quiz"), steps = form.querySelectorAll(".step");
				var ok = 0, bad = 0, total = steps.length;
				function tally(done) {
					document.getElementById("tally").textContent = "✓ " + ok + " · ✗ " + bad;
					document.getElementById("progress").style.width = (done * 100 / total) + "%";
				}
				steps.forEach(function (step, i) {
					var correct = step.dataset.c, picks = step.querySelectorAll(".pick"), next = step.querySelector(".next");
					picks.forEach(function (b) {
						b.addEventListener("click", function () {
							if (step.dataset.done) return;
							step.dataset.done = "1";
							var l = b.dataset.l, right = l === correct;
							step.querySelector("input[type=hidden]").value = l;
							picks.forEach(function (x) {
								x.disabled = true;
								if (x.dataset.l === correct) { x.classList.add("ok"); x.querySelector(".mark").textContent = "✓"; }
								else if (x === b) { x.classList.add("bad"); x.querySelector(".mark").textContent = "✗"; }
							});
							var v = step.querySelector(".verdict");
							v.hidden = false;
							v.className = "verdict " + (right ? "good" : "wrong");
							v.textContent = right ? "✓ To'g'ri!" : "✗ Noto'g'ri. To'g'ri javob: " + correct;
							right ? ok++ : bad++;
							tally(i + 1);
							next.hidden = false;
							next.focus();
						});
					});
					next.addEventListener("click", function () {
						if (i === total - 1) { next.disabled = true; form.submit(); return; }
						step.hidden = true;
						steps[i + 1].hidden = false;
						window.scrollTo(0, 0);
					});
				});
			})();
		</script>`);
}

async function attemptPage(c: Ctx, code: string, attemptId: number) {
	const r = await practiceTest(c, code);
	if ("res" in r) return r.res;
	const { test, questions, userId } = r;
	const a = await one("SELECT * FROM web_attempts WHERE id=? AND user_id=? AND test_id=?", attemptId, userId, test.id);
	const p = a ? partSlice(questions, a.part) : null;
	if (!a || !p) return notFound(c);
	const answers = String(a.answers).split("");
	const pct = Math.round((a.score * 100) / a.total);
	const base = `/t/${h(test.code)}`;

	const items = p.slice.map((q, i) => {
		const right = answers[i] === q.correct;
		const opts = (q.options as string).split("\n").map((o) => {
			const cls = o[0] === q.correct ? " ok" : o[0] === answers[i] ? " bad" : "";
			const mark = o[0] === q.correct ? "✓" : o[0] === answers[i] ? "✗" : "";
			return `<div class="opt${cls}"><span class="mark">${mark}</span><span>${h(o)}</span></div>`;
		});
		return `<div class="card ${right ? "right" : "wrong"}"><div class="q">${p.offset + i + 1}. ${h(q.text)}</div>${opts.join("")}</div>`;
	});
	const wrong = p.slice.length - a.score;
	const next = a.part && a.part < p.parts
		? `<a class="btn primary" href="${base}/${a.part + 1}">Keyingi qism →</a>` : "";
	return page(c, test.title, `<div class="card stack" style="text-align: center">
			<p class="muted">${h(test.title)} · ${h(partLabel(a.part, questions.length))}</p>
			<div class="score">${a.score}/${a.total}</div>
			<p class="muted">${pct}% to'g'ri${wrong ? `, ${wrong} ta xato` : " — barchasi to'g'ri! 🎉"}</p>
			<div class="actions">
				<a class="btn" href="${base}/${a.part || "all"}">↻ Qayta yechish</a>
				${next}
				${p.parts > 1 ? `<a class="btn" href="${base}">Barcha qismlar</a>` : `<a class="btn" href="/">Bosh sahifa</a>`}
			</div>
		</div>
		${wrong ? `<p class="small"><label><input type="checkbox" id="only-wrong"> Faqat xatolarni ko'rsatish</label></p>` : ""}
		<div id="review">${items.join("")}</div>
		<script>
			var cb = document.getElementById("only-wrong");
			if (cb) cb.addEventListener("change", function () { document.getElementById("review").classList.toggle("only-wrong", cb.checked); });
		</script>`);
}

// ---------------- Yo'naltirish ----------------

export async function handleWeb(request: Request, url: URL): Promise<Response> {
	const c: Ctx = { request, url, s: await loadSession(request), setCookie: null };
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const post = request.method === "POST";
	const testMatch = path.match(/^\/t\/(\d{1,10})(?:\/(\d{1,3}|all)|\/r\/(\d{1,12}))?$/);

	if (testMatch) {
		const [, code, part, attempt] = testMatch;
		if (part && (post || request.method === "GET")) return partPage(c, code, part);
		if (!post && attempt) return attemptPage(c, code, Number(attempt));
		if (!post && !part && !attempt) return testOverview(c, code);
	}
	if (post) {
		if (path === "/login/start") return loginStart(c);
		if (path === "/login/confirm") return loginConfirm(c);
		if (path === "/register") return register(c);
		if (path === "/logout") return logout(c);
	} else {
		const st = path.match(/^\/sticker\/(\w+)\.webp$/);
		if (st) return sticker(st[1]) ?? notFound(c);
		if (path === "/") return c.s?.user_id ? home(c) : c.s?.data.pending ? redirect(c, "/register") : loginPage(c);
		if (path === "/login") return loginPage(c);
		if (path === "/login/wait") return loginWait(c);
		if (path === "/login/status") return loginStatus(c);
		if (path === "/register") return register(c);
		if (path === "/t") return redirect(c, `/t/${(url.searchParams.get("code") ?? "").replace(/\D/g, "")}`);
	}
	return page(c, "Topilmadi", `<div class="card"><h1>Sahifa topilmadi</h1><a class="btn" href="/">Bosh sahifa</a></div>`, 404);
}

// ---------------- Bot tomoni ----------------

// /start web_<token>: so'rov shu Telegram foydalanuvchisiga bog'lanadi va telefon raqami so'raladi.
export async function onWebLoginStart(chatId: number, user: TgUser, token: string) {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 120);
	const row = /^[A-Za-z0-9_-]{16,64}$/.test(token)
		? await one(
			`UPDATE telegram_logins SET telegram_id=?, chat_id=?, name=?, username=?, status='started'
			 WHERE token=? AND status IN ('new', 'started') AND created_at>? RETURNING token`,
			user.id, chatId, name, user.username ?? null, token, fresh(),
		)
		: null;
	if (!row) return send(chatId, "Havola eskirgan. Saytda «Telegram orqali kirish» tugmasini qaytadan bosing.");
	await tg("sendMessage", {
		chat_id: chatId,
		text: "Saytga kirish uchun pastdagi tugma orqali telefon raqamingizni yuboring.",
		reply_markup: {
			keyboard: [[{ text: "📱 Telefon raqamni yuborish", request_contact: true }]],
			resize_keyboard: true,
			one_time_keyboard: true,
		},
	});
}

// Telefon raqami keldi: saytda bosiladigan raqam ko'rsatiladi.
export async function onWebLoginContact(chatId: number, user: TgUser, contact: TgContact) {
	if (contact.user_id !== user.id) return send(chatId, "Iltimos, pastdagi tugma orqali o'zingizning raqamingizni yuboring.");
	const row = await one(
		`UPDATE telegram_logins SET phone=?, status='contact'
		 WHERE token=(SELECT token FROM telegram_logins WHERE telegram_id=? AND status='started' AND created_at>?
		              ORDER BY created_at DESC LIMIT 1)
		 RETURNING code`,
		String(contact.phone_number ?? "").slice(0, 40), user.id, fresh(),
	);
	await tg("sendMessage", {
		chat_id: chatId,
		text: row
			? `Saytda shu raqamni bosing:\n\n<b>${row.code}</b>`
			: "Kirish so'rovi topilmadi yoki eskirgan. Saytda «Telegram orqali kirish» tugmasini qaytadan bosing.",
		parse_mode: "HTML",
		reply_markup: { remove_keyboard: true },
	});
}
