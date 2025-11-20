# Bitrix Bot Core (модульный каркас)

1) Установите зависимости:
   npm i
   copy .env.example .env   # заполните .env (BASE_URL, OAuth Client ID/Secret)

2) Поднимите публичный HTTPS (Cloudflare Tunnel/ngrok) и пропишите BASE_URL.

3) В Битрикс24 создайте Локальное приложение и укажите Installation event handler URL:
   ${BASE_URL}/bitrix/events
   Событие ONAPPINSTALL придёт в этот эндпоинт — токены сохраняются в data/portals.json.

4) Запуск:
   npm run dev
   # проверка: GET /healthz

5) Бот:
   Регистрация вызывается при ONAPPINSTALL (modules/bot/register.js, imbot.register).
   Для каналов — imopenlines.bot.session.* (приветствие/перевод/завершение).

6) CRM:
   Пример — crm.lead.add (нужен scope crm).

*** Дальше добавляем модули: external/vin/*, external/pricing/*, CRM и т.п.
