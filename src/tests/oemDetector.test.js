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
  // Может что-то детектнуться из кусков, но isSimpleOemQuery обязан вернуть false.
  assert.equal(isSimpleOemQuery(text, oems), false);
});
