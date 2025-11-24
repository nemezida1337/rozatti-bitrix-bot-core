# Rozatti Bitrix Bot Core · HF-OS ядро

Node.js‑бот для Bitrix24, который:

- принимает сообщения из Открытых линий и чатов Bitrix24;
- через LLM (OpenAI) **понимает намерения клиента** (OEM, VIN, общие запросы);
- подбирает **оригинальные автозапчасти** по OEM через **ABCP API**;
- создает и обновляет лиды/контакты в Bitrix24;
- ведёт **воронку продаж** от первого сообщения до готового заказа;
- логирует все шаги в COMMENTS‑поле лида и внутренний EventBus.

Проект создаётся как ядро **HF‑OS (HF‑Technologies AI‑ОС бизнеса)**.  
Автомобильная тематика (Rozatti, оригинальные запчасти) — первый боевой полигон.

---

## 1. Быстрый старт

### 1.1. Требования

- Node.js 20+
- npm 10+
- Доступ к порталу Bitrix24 (on‑cloud/on‑premise)
- Доступ к ABCP API (домен, логин, ключ)
- Ключ OpenAI (или совместимой LLM)

### 1.2. Установка зависимостей

```bash
npm install
```

### 1.3. Конфигурация `.env`

Создайте `.env` на основе `.env.example`:

```bash
cp .env.example .env
# Windows:
# copy .env.example .env
```

Критичные переменные (сокращённо):

```env
PORT=8080
BASE_URL=https://your-public-url.example.com

BITRIX_CLIENT_ID=local.xxxxx
BITRIX_CLIENT_SECRET=xxxxxxxx
BITRIX_OAUTH_URL=https://oauth.bitrix.info/oauth/token/
BITRIX_OAUTH_REDIRECT=${BASE_URL}/oauth/callback

TOKENS_FILE=./data/portals.json

OPENAI_API_KEY=sk-proj-...
LLM_MODEL=gpt-4.1-mini
LLM_MODEL_STRUCTURED=gpt-4.1-mini

ABCP_DOMAIN=abcpXXXX.public.api.abcp.ru
ABCP_USERLOGIN=api@abcpXXXX
ABCP_USERPSW_MD5=<md5-хэш>
ABCP_KEY=api@abcpXXXX
```

### 1.4. Публичный URL и Bitrix24

1. Поднимите HTTPS‑туннель/домен до локального сервера, пропишите в `.env`:

   ```env
   BASE_URL=https://your-public-url.example.com
   ```

2. В локальном приложении Bitrix24 укажите:

   - **Installation event handler URL**:  
     `https://your-public-url.example.com/bitrix/events`

### 1.5. Запуск бота

```bash
# дев-режим с перезапуском
npm run dev

# или обычный запуск
node src/index.js
```

Проверка здоровья:

```bash
curl http://localhost:8080/healthz
```

---

## 2. Архитектура (упрощённо)

**Поток сообщений:**

1. Bitrix24 → HTTP webhook `/bitrix/events`
2. `handler_llm_manager`:
   - нормализует входящее сообщение;
   - грузит/создаёт сессию диалога;
   - вызывает LLM‑воронку (проход №1);
   - при необходимости вызывает ABCP;
   - вызывает LLM‑воронку (проход №2) с данными ABCP;
   - обновляет CRM (лид + контакт);
   - отправляет ответ клиенту через OpenLines API;
   - логирует события в EventBus и COMMENTS лида.

**Слои:**

- `src/core/`
  - `logger.js` — pino‑логгер
  - `eventBus.js` — in‑memory EventBus HF‑OS
  - `bitrixClient.js` — обёртка над REST Bitrix24
  - `messageModel.js` — нормализация входящих сообщений
- `src/modules/bot/`
  - `handler_llm_manager.js` — входная точка для событий Bitrix
  - `sessionStore.js` — хранение сессий (по portal + dialogId)
- `src/modules/llm/`
  - `openaiClient.js` — клиент OpenAI + строгий LLM‑контракт
  - `llmFunnelEngine.js` — подготовка контекста, стадии, история
- `src/modules/external/pricing/`
  - `abcp.js` — интеграция с ABCP и нормализация результатов
- `src/modules/crm/`
  - `leads.js` — создание/обновление лида, product rows, COMMENTS‑лог
  - `contactService.js` — работа с Контактами Bitrix24 (ФИО, телефон, адрес)

---

## 3. LLM‑воронка и строгий контракт

### 3.1. Общая идея

LLM всегда возвращает **один JSON‑объект** без текста вокруг.  
Это гарантируется `SYSTEM_PROMPT` в `openaiClient.js` и нормализатором `normalizeLLMResponse`.

### 3.2. Формат ответа LLM

Тип `LLMFunnelResponse` (упрощённо):

```jsonc
{
  "action": "reply" | "abcp_lookup" | "ask_name" | "ask_phone" | "handover_operator",
  "stage": "NEW" | "PRICING" | "CONTACT" | "FINAL",
  "reply": "строка для клиента",
  "need_operator": false,
  "update_lead_fields": {
    "NAME": "Иванов Иван",
    "PHONE": "+7...",
    "ADDRESS": "Москва, ..."
  },
  "client_name": "Иванов Иван",
  "oems": ["A0000000000", "4N0907998"],

  "product_rows": [
    {
      "PRODUCT_NAME": "Название позиции",
      "PRICE": 12345.67,
      "QUANTITY": 1,
      "CURRENCY_ID": "RUB"
    }
  ],

  "product_picks": [
    {
      "idx": 0,
      "qty": 1,
      "item": {
        "oem": "A0000000000",
        "brand": "MB",
        "name": "Название детали",
        "priceNum": 12345.67,
        "daysText": "до 7 раб.дн."
      }
    }
  ]
}
```

Ключевые моменты:

- `action="abcp_lookup"` — модель просит сделать запрос в ABCP по `oems`.
- `action="reply"` — готовый ответ клиенту.
- `ask_name` / `ask_phone` — стадии сбора контактов.
- `handover_operator` — эскалация на живого менеджера (edge‑кейсы).

Все «грязные»/нестабильные поля приводятся к контракту через:

- `normalizeLLMResponse`
- `validateLLMFunnelResponse`

Если LLM сломал JSON — клиент получает безопасный fallback‑ответ без падения сервера.

---

## 4. ABCP интеграция

Файл: `src/modules/external/pricing/abcp.js`

- `/search/brands` — определяет бренд по OEM.
- `/search/articles` — получает список предложений.
- Нормализация:
  - оставляет **оригинальные** позиции;
  - парсит сроки через `deadlineReplace` / текстовые поля (`"до 7 раб.дн."`, `"до 18 дней"`);
  - при отсутствии текстового срока использует числовые поля (`deliveryPeriod*`) как fallback;
  - сортирует предложения по цене (от дешёвых к дорогим);
  - возвращает структуру вида:

    ```js
    {
      "A0000000000": {
        offers: [
          {
            oem: "A0000000000",
            brand: "MB",
            name: "Оригинальное название",
            priceNum: 9700,
            daysText: "до 7 раб.дн.",
            minDays: 5,
            maxDays: 7
          },
          ...
        ]
      },
      ...
    }
    ```

Эта структура передаётся во второй проход LLM через `llmFunnelEngine` (как `abcp` в контексте).

---

## 5. CRM‑слой (лиды и контакты)

### 5.1. Настройки CRM

Файл: `config/settings.crm.js`:

```js
export const crmSettings = {
  sourceId: "OPENLINES",
  leadFields: {
    OEM: "UF_CRM_1762873310878" // поле для OEM-списка
  },
  stageToStatusId: {
    NEW: "NEW",
    PRICING: "IN_PROCESS",
    CONTACT: "IN_PROCESS",
    FINAL: "IN_PROCESS"
  }
};
```

### 5.2. Лиды (`src/modules/crm/leads.js`)

- `createLeadsApi(rest)`:
  - `createLeadFromSession` — создаёт лид из данных сессии;
  - `updateLead` — частичное обновление полей лида;
  - `setLeadStage` — маппит LLM‑стадии на `STATUS_ID`;
  - `setProductRows` / `setProductRowsFromSelection` — записи товаров;
  - `appendComment` — аккуратное добавление строк в `COMMENTS`;
  - `ensureLeadForDialog` — гарантирует наличие лида для диалога.

- `safeUpdateLeadAndContact(...)`:
  - гарантирует лид (`ensureLeadForDialog`);
  - обновляет поля лида по `LLMFunnelResponse` (имя, телефон, адрес, OEM, COMMENTS);
  - двигает стадийность;
  - пишет товары (если LLM уже отдаёт `product_rows` / `product_picks`);
  - синхронизирует Контакт (через `ContactService`);
  - добавляет **структурированную строку COMMENTS‑лога**.

### 5.3. Контакты (`src/modules/crm/contactService.js`)

- `parseFullName(full)` — грубый разбор ФИО `"Фамилия Имя Отчество"` → `NAME` / `LAST_NAME` / `SECOND_NAME`.
- `normalizePhone(phoneRaw)` — нормализация телефона к формату Bitrix.
- `findContactByPhone(phoneRaw)` — поиск контакта по телефону.
- `createContact`, `updateContact` — работа с `crm.contact.*`.
- `linkContactToLead` — установка `CONTACT_ID` у лида.
- `syncContactFromLead` — основная функция синхронизации Контакта по данным лида/сессии.

---

## 6. EventBus и COMMENTS‑лог

### 6.1. EventBus (`src/core/eventBus.js`)

Простой in‑memory EventBus с событиями:

- `USER_MESSAGE` — входящее сообщение клиента;
- `LLM_RESPONSE` — структурированный ответ LLM (pass=1/2);
- `ABCP_RESULT` — итоговый результат ABCP‑поиска;
- `OL_SEND` — исходящее сообщение бота в Открытые линии;
- `SESSION_UPDATED` — обновление сессии;
- `LEAD_CREATED`, `LEAD_UPDATED`, `LEAD_COMMENT_APPENDED`;
- `PRODUCT_ROWS_SET`;
- `CRM_SAFE_UPDATE_DONE`.

EventBus сейчас используется как:

- ядро логирования для HF‑аналитики;
- заготовка под HF‑CaseStore / внешнюю шину (Kafka/Rabbit/БД).

### 6.2. COMMENTS‑лог лида

Каждый шаг LLM‑воронки порождает **компактную строку**, которая добавляется в `COMMENTS`:

```text
[2025-11-24T09:33:12.345Z] stage=PRICING action=abcp_lookup name="Иван Иванов" phone="+7900..." msg="нужны колодки..." reply="Вот варианты..." oems="A123...,4N09..."
```

Это даёт:

- быстрый просмотр истории прямо в карточке лида;
- материал для HF‑аналитики (HF‑OS уровень);
- прозрачность работы бота для менеджеров.

---

## 7. Тесты (unit‑уровень)

Тесты написаны на встроенном `node:test` (без дополнительных библиотек).

Файлы:

- `src/tests/llmContract.test.js`
  - тестирует:
    - `normalizeLLMResponse`
    - `validateLLMFunnelResponse`
    - поведение на валидных/битых ответах, старом формате `response` и т.п.

- `src/tests/crmMapping.test.js`
  - тестирует:
    - `buildLeadFieldsFromSession`
    - `parseFullNameStandalone` (из `contactService`)

Запуск:

```bash
npm test
# под капотом:
# node --test src/tests/**/*.test.js
```

---

## 8. Дальнейший roadmap (HF‑OS)

Текущий статус ядра:

- LLM‑контракт — строгий, нормализуемый и валидируемый;
- CRM‑слой вынесен в сервисы (`LeadsApi`, `ContactService`);
- EventBus — централизованная шина событий;
- COMMENTS‑лог — структурирован и пригоден для HF‑аналитики;
- Unit‑тесты покрывают ключевые точки (LLM‑контракт + CRM‑маппинг).

План развития:

1. **HF‑CaseStore** — отдельный модуль, который:
   - собирает события EventBus в «кейсы» диалогов;
   - сохраняет их в файлы/БД;
   - готовит фичи для HF‑аналитики и обучения.

2. **HF‑Супер‑Продавец**
   - HF‑фичи для LLM (HF‑метрики, вероятности закрытия, паттерны поведения);
   - персонализация ответов и стратегии продаж.

3. **HF‑индексация и аналитика**
   - агрегирование кейсов;
   - поиск по похожим сценариям;
   - отчёты по конверсии бота/менеджеров.

4. **BPM, геймификация, DI/DDD**
   - вынесение доменной логики в отдельные bounded contexts;
   - DI‑контейнер для конфигурируемости;
   - игровой слой (очки, задачи, рейтинги для менеджеров).

---

## 9. Безопасность

- `.env`, `data/portals.json`, `data/sessions/` и `logs/` находятся в `.gitignore`.
- Рекомендуется:
  - не хранить реальные ключи в репозитории;
  - использовать pre‑commit hooks для проверки на секреты;
  - ограничивать доступ к токен‑файлам и логам.

---

## 10. Лицензия

Внутренний проект компании **Rozatti / HF‑Technologies**.  
Использование вне компании требует отдельного согласования.
