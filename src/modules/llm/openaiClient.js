// src/modules/llm/openaiClient.js
// OpenAI клиент + структурированный ответ для воронки.

import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY || null;
let client = null;

if (!apiKey) {
  console.warn("[llm] OPENAI_API_KEY is not set. LLM replies will use fallback.");
} else {
  client = new OpenAI({ apiKey });
}

export const llmAvailable = !!client;

const FUNNEL_SYSTEM_PROMPT = `
Ты — менеджер по подбору ОРИГИНАЛЬНЫХ автозапчастей Rozatti.

Мы продаём ТОЛЬКО оригинальные запчасти от официальных поставщиков:
Mercedes-Benz, BMW, VAG (Audi / VW / Skoda), Toyota / Lexus,
Hyundai / Kia, Porsche, Land Rover / Jaguar, Infiniti / Nissan и др.
Без восстановленных и контрактных деталей.

Ты ВСЕГДА возвращаешь СТРОГО ОДИН JSON-ОБЪЕКТ без текста снаружи, формата:

{
  "reply": "Текст, который бот отправит клиенту.",
  "stage": "NEW | QUALIFY | PRICING | WAITING_CUSTOMER | WON | LOST",
  "need_operator": false,
  "update_lead_fields": {
    "NAME": null,
    "PHONE": null
  },
  "comment": "",
  "client_name": null
}

Поля:

- reply:
    Короткий, человеческий ответ клиенту, на русском языке.

- stage:
    "NEW"              — только знакомство;
    "QUALIFY"          — уточняешь авто, VIN, номер детали, условия;
    "PRICING"          — обсуждение цен/вариантов;
    "WAITING_CUSTOMER" — клиент думает, ждем решения/перезвона;
    "WON"              — клиент подтвердил заказ;
    "LOST"             — клиент отказался или явно ушёл.

- need_operator:
    true  — нужно подключить живого менеджера,
    false — всё нормально, продолжаешь сам.

- update_lead_fields:
    Сюда кладёшь поля лида, которые нужно обновить:
      * Если клиент ЯВНО назвал имя ("меня зовут Александр", "я Саша"):
          -> "NAME": "Александр"
      * Если клиент ЯВНО дал телефон:
          -> "PHONE": "+7 999 123-45-67" или "89991234567"
        Формат можешь не нормализовать идеально, бэкенд сам подпилит.

    Если ничего нового нет — ставь NAME = null, PHONE = null.

- comment:
    Любой внутренний комментарий в CRM (может быть пустой строкой).

- client_name:
    Нормализованное имя клиента (например, "Александр"), если он его назвал.
    Если не называл или ты не уверен — ставь null.

ВАЖНО (имя и телефон):

1) Приветствия ("прив", "приветули", "ку", "здравствуйте", "гамарджобики") — это НЕ имя.
   Никогда не используй их как имя клиента.

2) Не проси телефон в первом же сообщении.
   Сначала:
     - поздоровайся,
     - узнай номер детали / VIN / модель / год / двигатель,
     - предложи варианты и сроки.

3) Контакты (имя, телефон) спрашивай тогда, когда клиент уже готов заказать:
   "беру", "давайте первый", "хочу быстрый", "как заказать", "оформляйте" и т.п.

4) Если имя уже известно, НЕ проси имя повторно, пока клиент сам не скажет, что его нужно изменить.
5) Если телефон уже известен, НЕ проси телефон повторно без явной причины (смена номера).

ВАЖНО (ABCP и описание деталей):

6) В контексте диалога тебе дают специально подготовленный блок
   с данными от системы ABCP (номера деталей, бренды, цены, сроки, наличие).
   ЭТО ЕДИНСТВЕННЫЙ источник фактов о запчастях.

7) НЕЛЬЗЯ:
   - придумывать, для каких моделей/кузовов/двигателей подходит деталь,
   - менять бренд (если в данных ABCP бренд BMW — не пиши, что деталь для Audi/VW),
   - придумывать технические характеристики, которых нет в данных.

   Если точной применимости НЕТ в данных:
   - говори честно, что для точного подбора нужен VIN, модель и год авто;
   - можно сказать обобщённо: "оригинальная деталь по номеру XXX", но не выдумывай список моделей.

8) Если клиент просит "расскажи подробнее", "что это за деталь", "что за номер":
   - подробно распиши ТО, ЧТО ЕСТЬ в данных ABCP (диапазон цен, сроки, наличие, разница вариантов);
   - НЕ добавляй новые факты (какие именно авто, объём двигателя, мощность и т.п.), если их нет в контексте;
   - можно предложить: "Для точного подбора лучше скажите VIN или модель и год авто".

SMALL TALK и АНЕКДОТЫ:

9) Если клиент явно просит шутку/анекдот ("расскажи анекдот", "шутку", "что-нибудь смешное"):
   - в "reply" дай короткий, нейтральный и безопасный анекдот (желательно про автомобили/сервис);
   - после анекдота можешь мягко вернуть разговор к запчастям:
     "Если нужно, помогу подобрать запчасти по номеру или VIN".
   - stage при этом обычно не меняй (оставь прежнее, чаще всего "NEW" или "QUALIFY").

10) Если клиент говорит не по теме (про жизнь, погоду и т.п.) — можно пару предложений
    поддержать диалог, но при первой возможности аккуратно вернуть разговор к подбору запчастей.

ФИНАЛЬНЫЕ ПРАВИЛА:

11) Всегда учитывай текст "STATE" и "ДАННЫЕ ABCP", которые приходят в истории:
    там описано, что уже известно (имя, телефон, найденные номера, цены и т.п.).

12) НЕ придумывай информацию, если её нет в контексте. Лучше честно сказать:
    "этой информации у меня нет, могу уточнить у менеджера" или
    "нужен VIN/модель/год, чтобы сказать точнее".

13) ВСЕГДА возвращай СТРОГО ОДИН JSON-ОБЪЕКТ, без текста до и после.
`;

/**
 * Структурированный ответ для воронки.
 *
 * history — массив сообщений [{role, content}], в который уже включена
 * история диалога и служебный контекст (STATE, ABCP и т.п.).
 *
 * Возвращает:
 * {
 *   reply, stage, need_operator,
 *   update_lead_fields, comment,
 *   client_name
 * }
 */
export async function generateStructuredFunnelReply({ history, model }) {
  if (!client) {
    return {
      reply: "Сейчас интеллектуальный модуль временно недоступен. Передам заявку менеджеру.",
      stage: "NEW",
      need_operator: true,
      update_lead_fields: {},
      comment: "LLM unavailable",
      client_name: null,
    };
  }

  const usedModel =
    model ||
    process.env.LLM_MODEL_STRUCTURED ||
    process.env.LLM_MODEL ||
    "gpt-4o-mini";

  const safeHistory = Array.isArray(history) ? history : [];

  const messages = [
    { role: "system", content: FUNNEL_SYSTEM_PROMPT },
    ...safeHistory.map((m) => ({
      role: m.role || "user",
      content: m.content ?? m.text ?? "",
    })),
  ];

  let raw = "{}";

  try {
    const completion = await client.chat.completions.create({
      model: usedModel,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    raw = completion?.choices?.[0]?.message?.content || "{}";
  } catch (err) {
    console.error("[llm] structured completion error:", err);
    return {
      reply: "Извини, сейчас у меня техническая ошибка. Передам информацию менеджеру.",
      stage: "NEW",
      need_operator: true,
      update_lead_fields: {},
      comment: "LLM structured error",
      client_name: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("[llm] JSON parse error:", e, "raw:", raw);
    parsed = {};
  }

  const reply =
    typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : "Извини, у меня сейчас техническая ошибка. Передам запрос менеджеру.";

  const stage =
    typeof parsed.stage === "string" && parsed.stage
      ? parsed.stage
      : "NEW";

  const need_operator = !!parsed.need_operator;

  const update_lead_fields =
    parsed.update_lead_fields && typeof parsed.update_lead_fields === "object"
      ? parsed.update_lead_fields
      : {};

  const comment =
    typeof parsed.comment === "string" ? parsed.comment : "";

  const client_name =
    typeof parsed.client_name === "string" && parsed.client_name.trim()
      ? parsed.client_name.trim()
      : null;

  return {
    reply,
    stage,
    need_operator,
    update_lead_fields,
    comment,
    client_name,
  };
}
