import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

const originalCreate = axios.create;
const originalEnv = {
  ABCP_DOMAIN: process.env.ABCP_DOMAIN,
  ABCP_KEY: process.env.ABCP_KEY,
  ABCP_USERPSW_MD5: process.env.ABCP_USERPSW_MD5,
  ABCP_RETRY_MAX_ATTEMPTS: process.env.ABCP_RETRY_MAX_ATTEMPTS,
  ABCP_RETRY_BASE_MS: process.env.ABCP_RETRY_BASE_MS,
};

let stubGetImpl = async () => ({ data: [] });

function restoreEnv() {
  if (originalEnv.ABCP_DOMAIN === undefined) delete process.env.ABCP_DOMAIN;
  else process.env.ABCP_DOMAIN = originalEnv.ABCP_DOMAIN;

  if (originalEnv.ABCP_KEY === undefined) delete process.env.ABCP_KEY;
  else process.env.ABCP_KEY = originalEnv.ABCP_KEY;

  if (originalEnv.ABCP_USERPSW_MD5 === undefined) delete process.env.ABCP_USERPSW_MD5;
  else process.env.ABCP_USERPSW_MD5 = originalEnv.ABCP_USERPSW_MD5;

  if (originalEnv.ABCP_RETRY_MAX_ATTEMPTS === undefined) delete process.env.ABCP_RETRY_MAX_ATTEMPTS;
  else process.env.ABCP_RETRY_MAX_ATTEMPTS = originalEnv.ABCP_RETRY_MAX_ATTEMPTS;

  if (originalEnv.ABCP_RETRY_BASE_MS === undefined) delete process.env.ABCP_RETRY_BASE_MS;
  else process.env.ABCP_RETRY_BASE_MS = originalEnv.ABCP_RETRY_BASE_MS;
}

process.env.ABCP_DOMAIN = "abcp.test";
process.env.ABCP_KEY = "login";
process.env.ABCP_USERPSW_MD5 = "pass";

axios.create = () => ({
  get: (url, cfg) => stubGetImpl(url, cfg),
});

const mod = await import("../modules/external/pricing/abcp.js");

test.after(() => {
  axios.create = originalCreate;
  restoreEnv();
});

test("abcp: extractOEMsFromText filters phones/noise and deduplicates", { concurrency: false }, () => {
  const out = mod.extractOEMsFromText("мой тел +7 (999) 111-22-33, oem aa-111-22, второй aa11122");
  assert.deepEqual(out, ["AA11122"]);
});

test("abcp: searchManyOEMs groups offers by real OEM and normalizes delivery/qty", { concurrency: false }, async () => {
  const calls = [];
  stubGetImpl = async (url, { params }) => {
    calls.push({ url, params });

    if (url === "/search/brands") {
      return { data: [{ brand: "BMW" }] };
    }
    if (url === "/search/articles") {
      return {
        data: [
          { isOriginal: false, price: 9999 },
          { isOriginal: true, number: "ALT111", price: 100, quantity: 0, deadlineReplace: "до 7 раб.дн." },
          // Критичный формат ABCP: "до 9 р.дн." (раньше могло падать в fallback deliveryPeriod=269)
          { isOriginal: true, number: "ALT222", price: 110, deadlineReplace: "до 9 р.дн.", deliveryPeriod: 269 },
          { isOriginal: true, number: "REQ123", price: 120, deliveryMin: 5, deliveryMax: 0 },
          { isOriginal: true, article: "REQ123", cost: 130, deadline: "до 18 дней", qty: true },
        ],
      };
    }
    return { data: [] };
  };

  const out = await mod.searchManyOEMs(["req123"]);
  assert.deepEqual(Object.keys(out).sort(), ["ALT111", "ALT222", "REQ123"]);
  assert.equal(out.ALT111.offers.length, 1);
  assert.equal(out.ALT111.offers[0].quantity, 1);
  assert.equal(out.ALT111.offers[0].minDays, 7);
  assert.equal(out.ALT222.offers[0].minDays, 9);
  assert.equal(out.ALT222.offers[0].maxDays, 9);
  assert.equal(out.REQ123.offers.length, 2);
  assert.equal(out.REQ123.offers[0].price, 120);
  assert.equal(out.REQ123.offers[1].maxDays, 18);
  assert.equal(calls.some((c) => c.url === "/search/brands"), true);
  assert.equal(calls.some((c) => c.url === "/search/articles"), true);
});

test("abcp: handles empty brands, brandless row, no-results and brand-expected errors", { concurrency: false }, async () => {
  stubGetImpl = async (url, { params }) => {
    if (url === "/search/brands" && params.number === "EMPTY01") return { data: [] };
    if (url === "/search/brands" && params.number === "NOBRAND1") return { data: [{ foo: "bar" }] };
    if (url === "/search/brands" && params.number === "NORES01") return { data: [{ brand: "BMW" }] };
    if (url === "/search/brands" && params.number === "ERR002") return { data: [{ brand: "BMW" }] };

    if (url === "/search/articles" && params.number === "NORES01") {
      const err = new Error("not found");
      err.response = { status: 404, data: { errorCode: 301 } };
      err.config = { url, params };
      throw err;
    }
    if (url === "/search/articles" && params.number === "ERR002") {
      const err = new Error("brand required");
      err.response = { status: 400, data: { errorCode: 2 } };
      err.config = { url, params };
      throw err;
    }
    return { data: [] };
  };

  const out = await mod.searchManyOEMs(["EMPTY01", "NOBRAND1", "NORES01", "ERR002"]);
  assert.deepEqual(Object.keys(out).sort(), ["EMPTY01", "ERR002", "NOBRAND1", "NORES01"]);
  assert.equal(out.EMPTY01.offers.length, 0);
  assert.equal(out.NOBRAND1.offers.length, 0);
  assert.equal(out.NORES01.offers.length, 0);
  assert.equal(out.ERR002.offers.length, 0);
});

test("abcp: abcpLookupFromText uses LLM OEM list and fallback text extraction", { concurrency: false }, async () => {
  stubGetImpl = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return { data: [{ isOriginal: true, number: params.number, price: 777, deadline: "5 дней" }] };
    }
    return { data: [] };
  };

  const fromLlm = await mod.abcpLookupFromText("ignored text", [" zzz111 "]);
  assert.equal(Object.keys(fromLlm)[0], "ZZZ111");

  const fromText = await mod.abcpLookupFromText("ищу req-7788", []);
  assert.equal(Object.keys(fromText)[0], "REQ7788");
});

test("abcp: handles queryBrands error", { concurrency: false }, async () => {
  stubGetImpl = async (url, { params }) => {
    if (url === "/search/brands") {
      const err = new Error("brands fail");
      err.response = { status: 500, data: { x: 1 } };
      err.config = { url, params };
      throw err;
    }
    return { data: [] };
  };

  const out = await mod.searchManyOEMs(["ERR001"]);
  assert.equal(out.ERR001.offers.length, 0);
});

test("abcp: limits 429 retries for search/articles", { concurrency: false }, async () => {
  process.env.ABCP_RETRY_MAX_ATTEMPTS = "2";
  process.env.ABCP_RETRY_BASE_MS = "0";

  let articleCalls = 0;
  stubGetImpl = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      articleCalls += 1;
      const err = new Error("too many requests");
      err.response = { status: 429, data: { errorCode: 429 } };
      err.config = { url, params };
      throw err;
    }
    return { data: [] };
  };

  const out = await mod.searchManyOEMs(["R42901"]);
  assert.equal(out.R42901.offers.length, 0);
  assert.equal(articleCalls, 2);
});
