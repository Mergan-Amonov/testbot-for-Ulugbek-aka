# Telegram test bot

O'qituvchi test yuklaydi -> talabalar bot orqali yechadi -> har bir natija o'qituvchiga keladi.

## O'rnatish
1. @BotFather da yangi bot yarating, tokenni oling.
2. @userinfobot ga yozib o'z Telegram ID ingizni bilib oling.
3. `.env.example` dan nusxa olib `.env` qiling va to'ldiring.
4. `pip install -r requirements.txt`
5. `python bot.py`

## Claude / ChatGPT bilan test tuzish
1. Botda `/prompt` -> tayyor promptni nusxa oling, mavzu va sonini yozib Claude/ChatGPT ga yuboring.
2. AI javobini nusxa oling.
3. Botda `/newtest` -> test nomi -> matnni yuboring (yoki .txt fayl) -> `/done`.

Bot raqamlash (1., 2)), **qalin** shrift, ``` bloklar, "To'g'ri javob: B) ..." kabi
ko'rinishlarni o'zi tozalaydi.

## O'qituvchi
- `/newtest` -> test nomi -> savollar -> `/done`. Bot test kodi va havola beradi.
- `/mytests`, `/results KOD`, `/close KOD`, `/open KOD`, `/delete KOD`

Savol formati (savollar orasida bo'sh qator):
```
O'zbekiston poytaxti qaysi?
A) Samarqand
B) Toshkent
C) Buxoro
Javob: B
```
yoki to'g'ri variant oldiga `*`: `*B) Toshkent`.

## Talaba
Havolani bosadi (yoki /start + kod), ism-familiyasini yozadi, savollarga tugmalar bilan javob beradi.
Har bir talaba testni bir marta topshiradi. `/name` — ismni o'zgartirish.
