import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "testbot",
		compatibilityDate: "2026-10-06",
		entrypoint,
		workersDev: true,
		observability: { logs: { enabled: true } },
		// har daqiqada navbatdagi xabarlarni (guruhga yuborilgan testlar) jo'natadi
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],
		env: {
			DB: bindings.d1({ name: "testbot-db" }),
			BOT_TOKEN: bindings.secret(),
			WEBHOOK_SECRET: bindings.secret(),
			ADMIN_IDS: bindings.text("768225297,1375907081"),
			BOT_USERNAME: bindings.text("english_test_practise_bot"),
			// talabalar testni yechadigan sayt (shu worker o'zi)
			SITE_URL: bindings.text("https://testbot.anki-bot.workers.dev"),
		},
	},
});
