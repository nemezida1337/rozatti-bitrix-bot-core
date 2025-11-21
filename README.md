# Rozatti Bitrix Bot Core

Node.js-бот для Bitrix24, который:

- принимает сообщения из Открытых линий и чатов Bitrix24;
- через LLM (OpenAI) понимает запрос клиента (OEM, VIN, текст);
- подбирает **оригинальные автозапчасти** по OEM через **ABCP API**;
- возвращает клиенту структурированный ответ с вариантами цены и сроков поставки.

Фокус: оригинальные детали (VAG, Mercedes-Benz, BMW и др.) и сценарий «продавец-консультант» для компании **Rozatti**.

---

## 1. Быстрый старт

1. Установить зависимости:

    npm install

2. Создать `.env` на основе `.env.example`:

    cp .env.example .env
    # Windows:
    # copy .env.example .env

3. Поднять публичный HTTPS-URL (туннель, домен) и прописать в `.env`:

    BASE_URL=https://your-public-url.example.com

4. Настроить локальное приложение Bitrix24 и указать:

    Installation event handler URL: ${BASE_URL}/bitrix/events

5. Запустить бота:

    npm run dev
    # или
    node src/index.js

6. Проверить здоровье:

    curl http://localhost:8080/healthz

---

## 2. Архитектура (упрощённо)

Bitrix24 → HTTP webhook (/bitrix/events) → handler_llm_manager →  
LLM (проход №1, понимание запроса) → ABCP (поиск по OEM) →  
normalizeAbcpResponse (цены + сроки) → LLM (проход №2, готовый текст) →  
ответ клиенту через imbot.message.add / openlines.

Основные модули:

- src/core/ — сервер, env, логгер
- src/modules/bot/handler_llm_manager.js — входная точка для событий Bitrix
- src/modules/llm/openaiClient.js — клиент OpenAI + SYSTEM_PROMPT
- src/modules/llm/llmFunnelEngine.js — подготовка контекста, история, стадии воронки
- src/modules/external/pricing/abcp.js — интеграция с ABCP и нормализация результатов

---

## 3. LLM-воронка (коротко)

Модель всегда возвращает один JSON-объект вида:

    {
      "action": "reply" | "abcp_lookup" | "ask_name" | "ask_phone" | "handover_operator",
      "reply": "строка для клиента",
      "stage": "NEW" | "PRICING" | "CONTACT" | "FINAL",
      "need_operator": false,
      "update_lead_fields": {},
      "client_name": null,
      "oems": ["6C0601147CYTI"]
    }

- На первом проходе, если в тексте есть OEM, action = "abcp_lookup" и заполняется массив oems.
- На втором проходе в контексте есть abcp_data, и action = "reply" с готовым текстом с вариантами.

---

## 4. ABCP интеграция

Файл: src/modules/external/pricing/abcp.js

- /search/brands — определяем brand по OEM
- /search/articles — получаем предложения, фильтруем только оригиналы
- normalizeAbcpResponse:
  - вытаскивает цену, количество
  - сроки берёт строго из deadlineReplace / deadline (например, «до 18 дней», «до 7 раб.дн.»)
  - при отсутствии текстовых сроков использует deliveryPeriod* как fallback
  - сортирует предложения по цене (от дешёвых к дорогим)

Результат передаётся в LLM в поле abcp_data, откуда модель строит текст вида:

    <OEM> —
    вариант 1: <цена> руб., срок до N рабочих дней.
    вариант 2: <цена> руб., срок до M рабочих дней.

---

## 5. Файл .env (основные переменные)

Пример (сокращённый):

    PORT=8080
    BASE_URL=https://your-public-url.example.com

    BITRIX_CLIENT_ID=local.xxxxx
    BITRIX_CLIENT_SECRET=xxxxxxxx
    BITRIX_OAUTH_URL=https://oauth.bitrix.info/oauth/token/
    BITRIX_OAUTH_REDIRECT=${BASE_URL}/oauth/callback

    TOKENS_FILE=./data/portals.json

    OPENAI_API_KEY=sk-proj-...
    OPENAI_MODEL=gpt-4.1-mini
    LLM_MODEL=gpt-4.1-mini
    LLM_MODEL_STRUCTURED=gpt-4.1-mini

    ABCP_DOMAIN=abcpXXXX.public.api.abcp.ru
    ABCP_USERLOGIN=api@abcpXXXX
    ABCP_USERPSW_MD5=md5-хэш
    ABCP_KEY=api@abcpXXXX

---

## 6. Безопасность

- `.env`, `data/portals.json`, `data/sessions/` и `logs/` добавлены в `.gitignore`.
- Рекомендуется использовать pre-commit hook, который запрещает коммитить секреты (ключи OpenAI, ABCP, токены порталов).

---

## 7. Лицензия

Внутренний проект компании Rozatti. Использование вне компании требует отдельного согласования.
