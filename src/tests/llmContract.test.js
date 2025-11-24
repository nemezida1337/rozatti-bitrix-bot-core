// src/tests/llmContract.test.js
//
// Unit-тесты для LLM-контракта:
//  - normalizeLLMResponse
//  - validateLLMFunnelResponse
//
// Запуск: node --test src/tests/llmContract.test.js

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeLLMResponse,
  validateLLMFunnelResponse,
  LLM_ACTIONS,
  LLM_STAGES,
} from "../modules/llm/openaiClient.js";

test("normalizeLLMResponse: базовый валидный объект проходит без сюрпризов", () => {
  const raw = {
    action: LLM_ACTIONS.REPLY,
    stage: LLM_STAGES.PRICING,
    reply: "Привет, клиент!",
    need_operator: false,
    update_lead_fields: {
      NAME: "Иван Иванов",
      PHONE: "+7 (900) 000-00-00",
    },
    client_name: "Иван Иванов",
    oems: ["a1234567890", "  4n0907998   "],
    product_rows: [
      {
        PRODUCT_NAME: "Тестовая деталь",
        PRICE: 12345,
        QUANTITY: 1,
        CURRENCY_ID: "RUB",
      },
    ],
    product_picks: [
      {
        idx: 0,
        qty: 1,
        item: {
          oem: "A1234567890",
          brand: "MB",
          name: "Деталь",
          priceNum: 12345,
          daysText: "до 7 раб.дн.",
        },
      },
    ],
  };

  const res = normalizeLLMResponse(raw);

  assert.equal(res.action, LLM_ACTIONS.REPLY);
  assert.equal(res.stage, LLM_STAGES.PRICING);
  assert.equal(res.reply, "Привет, клиент!");
  assert.equal(res.need_operator, false);
  assert.equal(res.client_name, "Иван Иванов");

  assert.deepEqual(res.update_lead_fields, {
    NAME: "Иван Иванов",
    PHONE: "+7 (900) 000-00-00",
  });

  // OEM должны быть в верхнем регистре и без мусора
  assert.deepEqual(res.oems, ["A1234567890", "4N0907998"]);

  assert.equal(res.product_rows.length, 1);
  assert.equal(res.product_rows[0].PRODUCT_NAME, "Тестовая деталь");

  assert.equal(res.product_picks.length, 1);
  assert.equal(res.product_picks[0].idx, 0);
});

test("normalizeLLMResponse: неизвестный action/stage → безопасные значения по умолчанию", () => {
  const raw = {
    action: "WTF_ACTION",
    stage: "UNKNOWN_STAGE",
    reply: "Что-то странное",
    need_operator: "not boolean",
    update_lead_fields: null,
    client_name: "",
    oems: ["X1", "  ", 123, "a1"],
  };

  const res = normalizeLLMResponse(raw);

  // fallback action/stage
  assert.equal(res.action, LLM_ACTIONS.REPLY);
  assert.equal(res.stage, LLM_STAGES.NEW);

  // reply нормализуется
  assert.equal(res.reply, "Что-то странное");

  // need_operator приводится к boolean
  assert.equal(res.need_operator, false);

  // update_lead_fields — всегда объект
  assert.deepEqual(res.update_lead_fields, {});

  // client_name пустой → null
  assert.equal(res.client_name, null);

  // OEM: фильтр по длине, строкам и пустым значениям
  // "X1" и "a1" слишком короткие (2 символа) → отсекаются
  assert.deepEqual(res.oems, []);
});

test("normalizeLLMResponse: старый формат с полем response корректно конвертируется", () => {
  const raw = {
    response: {
      A1111111111: "есть в наличии от 10 000 до 12 000 руб.",
      A2222222222: {
        price_range: {
          min: 15000,
          max: 20000,
          currency: "руб.",
        },
      },
    },
    need_operator: true,
  };

  const res = normalizeLLMResponse(raw);

  assert.equal(res.action, LLM_ACTIONS.REPLY);
  assert.equal(res.stage, LLM_STAGES.PRICING); // из normalizeLLMResponse для старого формата
  assert.equal(res.need_operator, true);
  assert.equal(typeof res.reply, "string");
  assert.ok(res.reply.includes("A1111111111"));
  assert.ok(res.reply.includes("A2222222222"));

  // OEM ключи должны быть в oems
  assert.deepEqual(res.oems.sort(), ["A1111111111", "A2222222222"].sort());
});

test("normalizeLLMResponse: пустой/некорректный вход → безопасный fallback", () => {
  const res1 = normalizeLLMResponse(null);
  assert.equal(res1.action, LLM_ACTIONS.REPLY);
  assert.equal(res1.stage, LLM_STAGES.NEW);
  assert.equal(typeof res1.reply, "string");
  assert.deepEqual(res1.update_lead_fields, {});
  assert.deepEqual(res1.oems, []);

  const res2 = normalizeLLMResponse("wtf");
  assert.equal(res2.action, LLM_ACTIONS.REPLY);
  assert.equal(res2.stage, LLM_STAGES.NEW);
});

test("validateLLMFunnelResponse: ok = true для полного объекта", () => {
  const raw = {
    action: LLM_ACTIONS.REPLY,
    stage: LLM_STAGES.CONTACT,
    reply: "Супер, давайте продолжим",
    need_operator: false,
    update_lead_fields: {},
    client_name: null,
    oems: [],
  };

  const { ok, value, errors } = validateLLMFunnelResponse(raw);

  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.equal(value.action, LLM_ACTIONS.REPLY);
  assert.equal(value.stage, LLM_STAGES.CONTACT);
});

test("validateLLMFunnelResponse: ok = false и ошибки, если ключевые поля отсутствуют", () => {
  const raw = {
    // action нет
    stage: "",
    // reply нет
  };

  const { ok, value, errors } = validateLLMFunnelResponse(raw);

  assert.equal(ok, false);
  assert.ok(errors.length >= 2); // нет action и reply

  // value при этом всё равно нормализованный LLMFunnelResponse
  assert.equal(value.action, LLM_ACTIONS.REPLY);
  assert.equal(value.stage, LLM_STAGES.NEW);
  assert.equal(typeof value.reply, "string");
});
