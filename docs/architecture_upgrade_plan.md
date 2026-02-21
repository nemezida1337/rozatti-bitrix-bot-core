# План архитектурного апгрейда бота

Дата: 2026-02-21  
Статус: согласование/в работу  
Горизонт: 3-4 недели

## 1) Цель

Сделать архитектуру устойчивой к росту нагрузки и масштабированию, сохранив модель "Cortex = мозг, Node = исполнитель":
- убрать риски дублей/рассинхрона при нескольких инстансах;
- уменьшить latency и блокировки event loop;
- выровнять контракт стадий и действий между Cortex и CRM;
- сделать качество бота измеримым и защищенным от скрытых регрессий.

## 2) Текущее состояние (кратко)

Основные риски:
- локальные lock/idempotency/session-store не готовы к multi-instance;
- синхронный файловый I/O в hot path;
- лишний debug REST (`profile`) в Bitrix client на каждом новом client instance;
- неполный stage mapping (`LOST` из Cortex не маппится в CRM STATUS_ID);
- replay в CI может проходить на маленьком fixture и маскировать деградации.

## 3) Целевая архитектура

Слои:
1. `Ingress`: Bitrix webhooks (`/bitrix/events`) + валидация.
2. `Orchestrator`: только маршрутизация и запуск use-case команд.
3. `Use Cases`: `qualify`, `quote`, `collect_contact`, `create_order_abcp`, `convert_lead`.
4. `AI Brain`: Python Cortex (policy + hardening + intents/stages/actions).
5. `Execution`: Bitrix CRM/Openlines, ABCP API.
6. `State`: Redis (locks, idempotency, session snapshot cache).
7. `Observability`: технические и бизнес-метрики + replay quality gates.

## 4) Этапы внедрения

### Этап 0. Guardrails и операционная безопасность (1-2 дня)

Что делаем:
- исключаем runtime-артефакты из git (`_runtime/*`);
- переводим debug-profile в Bitrix client под env-флаг (по умолчанию off);
- фиксируем единый policy логирования PII.

DoD:
- в `git status` нет runtime-мусора по умолчанию;
- в прод-режиме нет вызовов `profile` без явного флага;
- лог-политика описана в `docs`.

### Этап 1. Shared state и синхронизация (4-5 дней)

Что делаем:
- вводим Redis для:
  - distributed lock по `domain+dialogId`,
  - idempotency ключей заказа/ответа,
  - актуального session snapshot;
- сохраняем file-store только как fallback/архив.

DoD:
- при 2+ инстансах нет дублей ответов/заказов в e2e tests;
- idempotency работает межпроцессно;
- отключаем in-memory lock как primary.

### Этап 2. I/O и производительность hot path (3-4 дня)

Что делаем:
- убираем sync FS операции из request path;
- добавляем async слой доступа к store/session + кэш в памяти с TTL;
- профилируем latency до/после.

DoD:
- p95 обработки входящего сообщения снижен минимум на 20-30%;
- в hot path нет `readFileSync/writeFileSync`/`existsSync`.

### Этап 3. Рефактор orchestration на use-case команды (5-6 дней)

Что делаем:
- делим `handler/index.js` на команды:
  - `HandleIncomingMessage`,
  - `RunDecisionGate`,
  - `RunCortexFlow`,
  - `ExecuteCrmSync`,
  - `ExecuteAbcpOrder`;
- оставляем в orchestrator только порядок вызовов и обработку ошибок.

DoD:
- каждый use-case покрыт изолированными тестами;
- размер `handler/index.js` существенно уменьшен;
- ошибки локализованы по слоям (AI/CRM/ABCP/State).

### Этап 4. Контракт Cortex ↔ Node ↔ CRM (2-3 дня)

Что делаем:
- формализуем enum intents/actions/stages и поддерживаем их в одном месте;
- добавляем явный маппинг `LOST -> STATUS_ID` в CRM;
- валидируем вход/выход Cortex схемой (fail-fast + fallback).

DoD:
- нет "неизвестных" стадий в runtime;
- все stage/action в replay имеют валидный execution path;
- `LOST` корректно пишется в лид.

### Этап 5. Усиление quality gates (2-3 дня)

Что делаем:
- в replay tests вводим `min_cases` и fail при слишком маленьком датасете;
- разделяем CI режимы:
  - smoke fixture (быстрый),
  - extended replay (nightly/по кнопке);
- отчеты по mismatch публикуем как артефакт.

DoD:
- CI не может "позеленеть" на 5-10 кейсах при отсутствии основного датасета;
- nightly показывает динамику качества по ключевым intent/stage/action.

### Этап 6. Rollout и стабилизация (3-4 дня)

Что делаем:
- staged rollout:
  - shadow 100%,
  - canary 20/50/100%;
- контроль ошибок/бизнес-метрик после каждого шага.

DoD:
- нет деградации конверсии и SLA ответа;
- дублей заказов/ответов нет;
- можно безопасно отключить legacy ветки.

## 5) Метрики контроля

Технические:
- p50/p95 latency на сообщение;
- доля ошибок Cortex/Bitrix/ABCP;
- количество duplicate reply/order;
- hit-rate idempotency.

Бизнес:
- конверсия `NEW -> PRICING -> FINAL -> DEAL`;
- доля корректной квалификации (`OEM_QUERY`, `VIN_HARD_PICK`, `CLARIFY_NUMBER_TYPE`);
- доля эскалаций на менеджера и время до реакции.

## 6) Порядок реализации (рекомендуемый)

1. Этап 0  
2. Этап 1  
3. Этап 2  
4. Этап 4  
5. Этап 5  
6. Этап 3  
7. Этап 6

Причина: сначала закрываем риски надежности и контрактов, затем оптимизируем структуру кода.

## 7) Минимальный MVP на ближайшую неделю

Сделать обязательно:
- Этап 0 полностью;
- Этап 1 (Redis lock + idempotency);
- Этап 4 (`LOST` mapping + контракт enum);
- Этап 5 (`min_cases` guard в replay).

Ожидаемый результат:
- стабильный прод без дублей;
- предсказуемое поведение стадий;
- CI реально защищает качество.
