import assert from "node:assert/strict";
import test from "node:test";

import { detectOemsFromText, isSimpleOemQuery } from "../modules/bot/oemDetector.js";

test("detectOemsFromText detects typical OEM inside phrase", () => {
  const text = "добрый день 5QM411105R сможет привезти?";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, ["5QM411105R"]);
  assert.equal(isSimpleOemQuery(text, oems), true);
});

test("detectOemsFromText does NOT treat RU phone number as OEM", () => {
  const phoneText1 = "+79889945791";
  const phoneText2 = "8 (988) 994-57-91";

  assert.deepEqual(detectOemsFromText(phoneText1), []);
  assert.deepEqual(detectOemsFromText(phoneText2), []);
  assert.equal(isSimpleOemQuery(phoneText1), false);
});

test("detectOemsFromText still detects numeric OEM (e.g., BMW 11 digits)", () => {
  const text = "63128363505";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, ["63128363505"]);
  assert.equal(isSimpleOemQuery(text, oems), true);
});

test("VIN text is never treated as simple OEM query", () => {
  const text = "VIN: WBAVL31020VN97388";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, []);
  assert.equal(isSimpleOemQuery(text, oems), false);
});

test("detectOemsFromText filters lowercase russian 'вин' + VIN from OEM list", () => {
  const text = "вин WDD2211761A308475, номер A221421201207";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, ["A221421201207"]);
});

test("VIN keyword without code does not block simple OEM query", () => {
  const text = "Пришлю вин позже, номер 5N0071680B041";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, ["5N0071680B041"]);
  assert.equal(isSimpleOemQuery(text, oems), true);
});

test("hyphenated VIN with keyword is not treated as simple OEM query", () => {
  const text = "VIN: WDD-2211761-A308475";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, []);
  assert.equal(isSimpleOemQuery(text, oems), false);
});

test("detectOemsFromText ignores URL/UTM service tokens", () => {
  const text = "https://site.ru/?utm_source=chat30792&utm_campaign=QWERTY123456";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, []);
});

test("detectOemsFromText ignores explicit order number phrase", () => {
  const text = "Добрый день, номер заказа 102123458";
  const oems = detectOemsFromText(text);
  assert.deepEqual(oems, []);
});
