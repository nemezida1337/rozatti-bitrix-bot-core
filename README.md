# Rozatti Bitrix Bot Core

Node.js-бот для Bitrix24 (OpenLines) + Python HF-Cortex для AI-воронки продаж запчастей.

## Что делает проект

- принимает входящие события Bitrix24 на `POST /bitrix/events`;
- обрабатывает сообщения клиента через V2-оркестратор (`src/modules/bot/handler/*`);
- на простых OEM-запросах делает быстрый путь (ABCP + Cortex);
- на сложных кейсах использует двухпроходный Cortex flow;
- обновляет лид/контакт/товарные строки в CRM Bitrix24;
- хранит сессии диалогов и диагностические дампы на диске.

## Актуальная структура

```text
src/
  index.js
  core/
    app.js
    bitrixClient.js
    env.js
    eventBus.js
    hfCortexClient.js
    logger.js
    messageModel.js
    oauth.js
    store.js
  http/routes/
    bitrix.js
  config/
    settings.crm.js
  modules/
    bot/
      register.js
      register.core.js
      sessionStore.js
      extractLeadFromEvent.js
      oemDetector.js
      leadDecisionGate.js
      handler/
        index.js
        context.js
        decision.js
        flows/
          fastOemFlow.js
          cortexTwoPassFlow.js
          managerOemTriggerFlow.js
        shared/
          chatReply.js
          cortex.js
          leadOem.js
          session.js
    crm/
      leadStateService.js
      leads/
        safeUpdateLeadAndContact.js
        updateLeadService.js
      contact/
        contactService.js
    external/pricing/
      abcp.js
    openlines/
      api.js
  tests/
    *.test.js

hf_cortex_py/
  app.py
  core/
  flows/lead_sales/
  tests/
```

## Требования

- Node.js 20+
- npm 10+
- Python 3.10+ (для `hf_cortex_py`)
- доступ к Bitrix24 (local app + OAuth)
- доступ к ABCP API
- ключ OpenAI (если используете HF-Cortex с реальным LLM)

## Установка

```bash
npm install
```

Для Python-сервиса:

```bash
cd hf_cortex_py
python -m venv .venv
# Windows:
.venv\Scripts\activate
pip install -r requirements.txt
```

## Конфигурация `.env` (Node)

Создайте `.env` в корне проекта по примеру `.env.example`.

Рекомендуемые профили:

- `.env` — локальная разработка
- `.env.debug` — диагностика (временные дампы/повышенный лог-уровень)
- `.env.prod` — боевой профиль
- шаблоны: `.env.debug.example`, `.env.prod.example`

Ключевые переменные:

```env
PORT=8080
BASE_URL=https://your-public-url.example.com

BITRIX_CLIENT_ID=local.xxxxx
BITRIX_CLIENT_SECRET=xxxxxxxx
BITRIX_OAUTH_URL=https://oauth.bitrix.info/oauth/token/
BITRIX_OAUTH_REDIRECT=${BASE_URL}/oauth/callback
BITRIX_DEBUG_PROFILE=0
TOKENS_FILE=./data/portals.json
SESSION_CACHE_TTL_MS=3000
STORE_CACHE_TTL_MS=1500
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=bitrixbot
REDIS_ENABLED=1

LOG_LEVEL=info
LOG_DIR=./logs

# безопасные дефолты для прода
EVENT_DUMP=0
HF_CORTEX_DUMP=0

# HF-Cortex bridge (Node -> Python)
HF_CORTEX_ENABLED=true
HF_CORTEX_URL=http://127.0.0.1:9000/api/hf-cortex/lead_sales
HF_CORTEX_TIMEOUT_MS=20000
HF_CORTEX_API_KEY=change-me
BOT_DIALOG_LOCK_TTL_MS=45000
BOT_DIALOG_LOCK_WAIT_MS=45000
BOT_DIALOG_LOCK_POLL_MS=120

# ABCP
ABCP_DOMAIN=abcpXXXX.public.api.abcp.ru
ABCP_USERLOGIN=api@abcpXXXX
ABCP_USERPSW_MD5=<md5>
ABCP_KEY=api@abcpXXXX
ABCP_ORDER_LOCK_TTL_MS=45000
ABCP_ORDER_LOCK_WAIT_MS=45000
ABCP_ORDER_LOCK_POLL_MS=120
```

Минимальные отличия профилей:

- `.env.prod`: `LOG_LEVEL=info`, `EVENT_DUMP=0`, `HF_CORTEX_DUMP=0`
- `.env.debug`: `LOG_LEVEL=debug`, `EVENT_DUMP=1`, `HF_CORTEX_DUMP=1`, `BITRIX_ALLOW_ONIMMESSAGEADD=1`, `BITRIX_DEBUG_PROFILE=1`

## Конфигурация `hf_cortex_py`

`hf_cortex_py/app.py` читает переменные из окружения/`.env`:

- `OPENAI_API_KEY`
- `HF_CORTEX_TOKEN` (опционально, токен на входящий API Python-сервиса)
- `HF_CORTEX_HOST` (по умолчанию `127.0.0.1`)
- `HF_CORTEX_PORT` (по умолчанию `9000`)

## Запуск

### Node-сервис

```bash
npm run dev
# или
node src/index.js
# или с конкретным env-файлом
node --env-file=.env.prod src/index.js
```

Проверка:

```bash
curl http://localhost:8080/healthz
```

### HF-Cortex (Python)

```bash
cd hf_cortex_py
.venv\Scripts\activate
uvicorn app:app --host 127.0.0.1 --port 9000 --reload
```

### Windows helper scripts

- `dev.ps1` — локальный dev-пайплайн (туннель + запуск бота)
- `start-tunnel-once.ps1` — старт Cloudflare Quick Tunnel
- `run-bot.ps1` — локальный запуск Node-сервиса (поддерживает `-EnvFile`)
- `update-base-url.ps1` — обновление `BASE_URL` в `.env`

Примеры:

```powershell
.\dev.ps1 -Port 8080 -EnvFile ".env.debug"
.\run-bot.ps1 -Port 8080 -EnvFile ".env.prod"
```

## Поток обработки (V2)

1. Bitrix отправляет событие в `src/http/routes/bitrix.js`.
2. Для `onimbotmessageadd` вызывается `processIncomingBitrixMessage` из `src/modules/bot/handler/index.js`.
3. Оркестратор:
   - сериализует обработку по `domain + dialogId`;
   - собирает контекст (`context.js`);
   - вычисляет gate-решение (`decision.js` + `leadDecisionGate.js`);
   - запускает один из flows:
     - `fastOemFlow.js`
     - `cortexTwoPassFlow.js`
     - `managerOemTriggerFlow.js`.
4. Обновление CRM выполняет `safeUpdateLeadAndContact.js`.
5. Ответ в чат отправляется через OpenLines API.

## CRM-конфиг

Файл: `src/config/settings.crm.js`

Здесь задаются:

- коды UF-полей (`leadFields`);
- маппинг стадий `stage -> STATUS_ID` (`stageToStatusId`);
- ручные статусы (`manualStatuses`), где чат-ответы подавляются (silent enrichment).

## Хранилища и дампы

- `data/portals.json` — OAuth токены порталов
- `data/sessions/` — сессии диалогов
- `data/events/` — дампы входящих Bitrix событий (если включено)
- `data/cortex/` — дампы request/response Node <-> HF-Cortex (если включено)
- `logs/` — логи приложения и утилит

## Тесты

Node:

```bash
npm test
```

Для quality-gate replay/eval можно задать минимальный размер датасета:

```bash
DIALOG_EVAL_MIN_CASES=300 node --test src/tests/dialogDatasetEval.test.js
DIALOG_REPLAY_MIN_CASES=300 node --test src/tests/dialogActionContractReplay.test.js
```

Python:

```bash
cd hf_cortex_py
pytest -q
```

Примечание: часть Python replay-тестов использует реальный вызов LLM и требует `OPENAI_API_KEY`.

## Линт

```bash
npm run lint
```
