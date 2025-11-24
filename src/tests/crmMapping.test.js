// src/tests/crmMapping.test.js
//
// Unit-тесты для CRM-слоя, где можно обойтись без Bitrix:
//  - buildLeadFieldsFromSession
//  - parseFullNameStandalone (разбор ФИО)
//
// Запуск: node --test src/tests/crmMapping.test.js

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLeadFieldsFromSession,
} from "../modules/crm/leads.js";

import {
  parseFullName as parseFullNameStandalone,
} from "../modules/crm/contactService.js";

test("buildLeadFieldsFromSession: базовый случай с именем, телефоном и адресом", () => {
  const session = {
    name: "Иванов Иван Петрович",
    phone: "+7 (900) 000-00-00",
    address: "Москва, ул. Пушкина, д. 1",
    lastQuery: "Нужны колодки на W204",
    state: {
      stage: "PRICING",
      client_name: "Иванов Иван Петрович",
    },
  };

  const dialogMeta = {
    dialogId: "chat-123",
    source: "OPENLINES",
  };

  const fields = buildLeadFieldsFromSession(session, dialogMeta);

  assert.equal(
    fields.TITLE,
    "Запрос запчастей: Иванов Иван Петрович",
  );
  assert.equal(fields.NAME, "Иванов Иван Петрович");
  assert.equal(fields.SOURCE_ID, "OPENLINES");
  assert.equal(fields.COMMENTS, "Нужны колодки на W204");

  assert.ok(Array.isArray(fields.PHONE));
  assert.equal(fields.PHONE[0].VALUE, "+7 (900) 000-00-00");
  assert.equal(fields.PHONE[0].VALUE_TYPE, "WORK");

  assert.equal(fields.ADDRESS, "Москва, ул. Пушкина, д. 1");
});

test("buildLeadFieldsFromSession: если имени нет — TITLE по умолчанию", () => {
  const session = {
    phone: "+7 (900) 000-00-00",
    lastQuery: "Нужны колодки",
  };

  const fields = buildLeadFieldsFromSession(session, {});

  assert.equal(fields.TITLE, "Запрос запчастей (бот)");
  assert.equal(fields.NAME, "");
  assert.equal(fields.SOURCE_ID, "OPENLINES"); // из crmSettings по умолчанию
  assert.equal(fields.COMMENTS, "Нужны колодки");
});

test("parseFullNameStandalone: Фамилия Имя Отчество", () => {
  const full = "Иванов Иван Петрович";

  const { firstName, lastName, middleName } =
    parseFullNameStandalone(full);

  assert.equal(firstName, "Иван");
  assert.equal(lastName, "Иванов");
  assert.equal(middleName, "Петрович");
});

test("parseFullNameStandalone: Имя Фамилия", () => {
  const full = "Иван Петров";

  const { firstName, lastName, middleName } =
    parseFullNameStandalone(full);

  assert.equal(firstName, "Иван");
  assert.equal(lastName, "Петров");
  assert.equal(middleName, "");
});

test("parseFullNameStandalone: только одно слово", () => {
  const full = "Однослово";

  const { firstName, lastName, middleName } =
    parseFullNameStandalone(full);

  assert.equal(firstName, "Однослово");
  assert.equal(lastName, "");
  assert.equal(middleName, "");
});

test("parseFullNameStandalone: пустые и мусорные строки", () => {
  const { firstName, lastName, middleName } =
    parseFullNameStandalone("   ");

  assert.equal(firstName, "");
  assert.equal(lastName, "");
  assert.equal(middleName, "");
});
