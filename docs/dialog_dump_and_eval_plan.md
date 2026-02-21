# План: дамп диалогов за 60 дней и тесты поведения бота

Дата фиксации: 2026-02-20
Статус: в работе

Обновление: 2026-02-21
- Выполнен line-scoped дамп за 14 дней для линий `Telegram_bot(6)`, `Telegram(40)`, `Telegram_Groups(42)`, `Drom(10)`, `Avito(26)`.
- Для `Drom` найден отдельный рабочий путь выгрузки:
  - `crm.lead.list` c `SOURCE_ID=10|DROMCONNECTOR`
  - `crm.lead.get` -> `IM.VALUE` (`imol|DromConnector|10|...`)
  - `imopenlines.crm.chat.getlastid` (+ fallback `imopenlines.dialog.get` с `USER_CODE`)
  - `imopenlines.session.history.get` по `CHAT_ID`
- Актуальный объединенный дамп линий:
  - `data/tmp/bitrix-dialogs-lines/2026-02-21T13-27-29-706Z`
- Построен датасет и eval:
  - `data/tmp/dialog-tests/2026-02-21T13-30-22-264Z`
  - `checked=360`, `failed=3`, `pass_rate=99.17%`

Обновление: 2026-02-21 (расширение таксономии human-dataset)
- Источник: `data/tmp/bitrix-dialogs-lines-human/2026-02-21T13-40-55-057Z`.
- В `buildDialogCases` добавлен класс `TEXT_CONTEXT_FOLLOWUP` и расширена разметка `SERVICE_ACK`.
- В `dialogDatasetEval` обновлены ожидания для mixed `VIN+OEM` и добавлена валидация `TEXT_CONTEXT_FOLLOWUP`.
- Новый датасет и eval:
  - `data/tmp/dialog-tests/2026-02-21T14-09-23-850Z`
  - `checked=837`, `failed=0`, `pass_rate=100%`
  - `review_cases=390` (сокращено с `886`).

Обновление: 2026-02-21 (сырые Telegram-чаты)
- Добавлен конвертер `src/scripts/convertRawTelegramChats.js` (HTML export -> `dialog_turns.jsonl`).
- Добавлен npm-script:
  - `npm run convert:telegram-raw`
- Последняя конвертация:
  - вход: `сырые чаты/chats`
  - выход: `data/tmp/telegram-raw-dialogs/2026-02-21T14-35-20-793Z`
  - `chats_scanned=967`, `chats_included=881`, `turns_written=14810`
- На базе этого дампа собран датасет:
  - `data/tmp/dialog-tests/2026-02-21T14-36-02-795Z`
  - `high_confidence=1837`, `review=800`
  - eval: `checked=1837`, `failed=0`, `pass_rate=100%`

Обновление: 2026-02-21 (merged dataset для regression-replay)
- Добавлен merge-скрипт:
  - `src/scripts/mergeDialogCaseDatasets.js`
  - `npm run merge:dialog-cases`
- Собран merged набор из Bitrix-human + Telegram-raw:
  - входы:
    - `data/tmp/dialog-tests/2026-02-21T14-09-23-850Z`
    - `data/tmp/dialog-tests/2026-02-21T14-36-02-795Z`
  - caps:
    - `max_per_kind_source=300`
    - `max_per_kind_total=500`
  - результат:
    - `data/tmp/dialog-tests-merged/2026-02-21T14-40-02-537Z`
    - `high_confidence=1760`, `review=1175`
  - eval:
    - `checked=1760`, `failed=0`, `pass_rate=100%`

## Цель
Снять локальный дамп диалогов менеджеров и клиентов за последние 60 дней, построить из них тест-кейсы и получить отчёт, где текущая логика бота совпадает с ожидаемым поведением, а где расходится.

## Этап 1. Дамп диалогов (Bitrix24)
- [x] Добавить скрипт `src/scripts/dumpBitrixDialogs.js`.
- [x] Поддержать период `--days 60` (или `--from/--to`).
- [x] Поддержать сущности: `lead` и `deal` (через `--entity`).
- [x] Снимать чаты по CRM-сущности через `imopenlines.crm.chat.get`.
- [x] Снимать историю через `imopenlines.session.history.get`, fallback на `im.dialog.messages.get`.
- [x] Сохранять:
- `data/tmp/bitrix-dialogs/<ts>/raw/dialogs_raw.jsonl`
- `data/tmp/bitrix-dialogs/<ts>/normalized/dialog_turns.jsonl`
- `data/tmp/bitrix-dialogs/<ts>/manifest.json`
- [x] Добавить ограничение скорости (`--rps`) и аккуратный лог ошибок.
- [ ] Добавить retry для временных ошибок API.

## Этап 2. Построение кейсов для тестов
- [x] Добавить скрипт `src/scripts/buildDialogCases.js`.
- [x] Читать `dialog_turns.jsonl`, строить пары "вход клиента -> ответ менеджера".
- [x] Классифицировать high-confidence кейсы:
- `OEM_FLOW`
- `VIN_HANDOVER`
- `VIN_SERVICE_ACK`
- `SMALLTALK_HOWTO`
- `SMALLTALK_OFFTOPIC`
- `SERVICE_ACK`
- `STATUS_TRACKING`
- `NO_STOCK_REPLY`
- `REPEAT_FOLLOWUP` (с учетом предыдущих сообщений в диалоге)
- [x] Сохранять:
- `data/tmp/dialog-tests/<ts>/high_confidence_cases.json`
- `data/tmp/dialog-tests/<ts>/review_cases.json`
- `data/tmp/dialog-tests/<ts>/summary.md`
- [x] Обновлять указатель `data/tmp/dialog-tests/LATEST.txt`.

## Этап 3. Автотест на реальных кейсах
- [x] Добавить тест `src/tests/dialogDatasetEval.test.js`.
- [x] Тест читает `LATEST.txt` (или `DIALOG_CASES_FILE`) и прогоняет кейсы.
- [x] Проверки:
- `OEM_FLOW` -> ожидаем `requestType=OEM`, `shouldCallCortex=true`
- `VIN_HANDOVER` -> ожидаем `requestType=VIN`, `mode=manual`
- `SMALLTALK_*` -> ожидаем корректный `resolveSmallTalk(...)`
- `STATUS_TRACKING` -> ожидаем `HOWTO`-интент по статусным вопросам
- `REPEAT_FOLLOWUP` -> проверка наличия контекста предыдущих сообщений
- [x] Итог: отчёт о pass/fail по кейсам (`eval/*.json|.md`).

## Этап 4. Прогон и анализ
- [x] Снять пилотный дамп (7 дней) и проверить качество кейсов.
- [ ] Снять полный дамп (60 дней).
- [ ] Получить финальный отчёт по отклонениям для правок логики бота.

## Локальные ограничения безопасности
- Сырые дампы и производные данные хранятся только в `data/tmp/*`.
- Эти пути не должны попадать в git.
