import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

const originalCreate = axios.create;
const originalEnv = {
  ABCP_DOMAIN: process.env.ABCP_DOMAIN,
  ABCP_KEY: process.env.ABCP_KEY,
  ABCP_USERPSW_MD5: process.env.ABCP_USERPSW_MD5,
  ABCP_ORDER_CLEAR_BASKET: process.env.ABCP_ORDER_CLEAR_BASKET,
  ABCP_SHIPMENT_METHOD_ID: process.env.ABCP_SHIPMENT_METHOD_ID,
  ABCP_SHIPMENT_ADDRESS_ID: process.env.ABCP_SHIPMENT_ADDRESS_ID,
  ABCP_PAYMENT_METHOD_ID: process.env.ABCP_PAYMENT_METHOD_ID,
  ABCP_SHIPMENT_OFFICE_ID: process.env.ABCP_SHIPMENT_OFFICE_ID,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

process.env.ABCP_DOMAIN = "abcp.test";
process.env.ABCP_KEY = "login";
process.env.ABCP_USERPSW_MD5 = "pass";
delete process.env.ABCP_SHIPMENT_METHOD_ID;
delete process.env.ABCP_SHIPMENT_ADDRESS_ID;
delete process.env.ABCP_PAYMENT_METHOD_ID;
delete process.env.ABCP_SHIPMENT_OFFICE_ID;

const calls = [];
let postImpl = async () => ({ data: { status: 1 } });
let getImpl = async () => ({ data: [] });

axios.create = () => ({
  post: (url, body, cfg) => {
    calls.push({ method: "post", url, body, cfg });
    return postImpl(url, body, cfg);
  },
  get: (url, cfg) => {
    calls.push({ method: "get", url, cfg });
    return getImpl(url, cfg);
  },
});

const { createAbcpOrderFromSession } = await import("../modules/external/pricing/abcpOrder.js");

test.after(() => {
  axios.create = originalCreate;
  restoreEnv();
});

function parseFormBody(raw) {
  return new URLSearchParams(String(raw || ""));
}

test("abcpOrder: creates order on selected offer", { concurrency: false }, async () => {
  calls.length = 0;

  getImpl = async (url) => {
    if (url === "/basket/shipmentMethods") return { data: [{ id: 11, name: "СДЭК" }] };
    if (url === "/basket/shipmentAddresses") return { data: [] };
    return { data: [] };
  };

  postImpl = async (url) => {
    if (url === "/basket/order") {
      return {
        data: {
          status: 1,
          orders: [{ number: "A-1001" }],
        },
      };
    }
    return { data: { status: 1 } };
  };

  const result = await createAbcpOrderFromSession({
    dialogId: "chat-1",
    session: {
      state: {
        chosen_offer_id: 2,
        offers: [
          { id: 1, brand: "Febi", oem: "01089", supplierCode: "S1", itemKey: "K1" },
          { id: 2, brand: "Kyb", oem: "333305", supplierCode: "S2", itemKey: "K2" },
        ],
      },
    },
    llm: { stage: "ABCP_CREATE", chosen_offer_id: 2 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.orderNumbers, ["A-1001"]);

  const addCall = calls.find((x) => x.method === "post" && x.url === "/basket/add");
  assert.ok(addCall, "basket/add must be called");
  const addBody = parseFormBody(addCall.body);
  assert.equal(addBody.get("positions[0][brand]"), "Kyb");
  assert.equal(addBody.get("positions[0][number]"), "333305");
  assert.equal(addBody.get("positions[0][supplierCode]"), "S2");
  assert.equal(addBody.get("positions[0][itemKey]"), "K2");

  const orderCall = calls.find((x) => x.method === "post" && x.url === "/basket/order");
  assert.ok(orderCall, "basket/order must be called");
  const orderBody = parseFormBody(orderCall.body);
  assert.equal(orderBody.get("shipmentMethod"), "11");
  assert.equal(orderBody.get("shipmentAddress"), "0");
});

test("abcpOrder: returns reason when no selected offers", { concurrency: false }, async () => {
  calls.length = 0;
  const result = await createAbcpOrderFromSession({
    session: {
      state: {
        chosen_offer_id: null,
        offers: [{ id: 1, brand: "A", oem: "B", supplierCode: "C", itemKey: "D" }],
      },
    },
    llm: { stage: "ABCP_CREATE" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_SELECTED_OFFERS");
  assert.equal(calls.length, 0);
});

test("abcpOrder: returns reason when offer is not orderable", { concurrency: false }, async () => {
  calls.length = 0;
  const result = await createAbcpOrderFromSession({
    session: {
      state: {
        chosen_offer_id: 1,
        offers: [{ id: 1, brand: "A", oem: "B" }],
      },
    },
    llm: { stage: "ABCP_CREATE", chosen_offer_id: 1 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_ORDERABLE_POSITIONS");
  assert.equal(calls.length, 0);
});

