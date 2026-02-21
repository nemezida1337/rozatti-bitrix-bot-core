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
  ABCP_TS_CLIENT_ID: process.env.ABCP_TS_CLIENT_ID,
  ABCP_TS_AGREEMENT_ID: process.env.ABCP_TS_AGREEMENT_ID,
  ABCP_TS_DELIVERY_METHOD_ID: process.env.ABCP_TS_DELIVERY_METHOD_ID,
  ABCP_TS_PICKUP_OFFICE_ID: process.env.ABCP_TS_PICKUP_OFFICE_ID,
  ABCP_TS_SHIPMENT_ADDRESS_ID: process.env.ABCP_TS_SHIPMENT_ADDRESS_ID,
  ABCP_TS_NEW_CLIENT_MARKET_TYPE: process.env.ABCP_TS_NEW_CLIENT_MARKET_TYPE,
  ABCP_TS_NEW_CLIENT_PASSWORD: process.env.ABCP_TS_NEW_CLIENT_PASSWORD,
  ABCP_TS_NEW_CLIENT_CITY: process.env.ABCP_TS_NEW_CLIENT_CITY,
  ABCP_TS_NEW_CLIENT_FILIAL_ID: process.env.ABCP_TS_NEW_CLIENT_FILIAL_ID,
  ABCP_TS_NEW_CLIENT_PROFILE_ID: process.env.ABCP_TS_NEW_CLIENT_PROFILE_ID,
  ABCP_TS_NEW_CLIENT_EMAIL: process.env.ABCP_TS_NEW_CLIENT_EMAIL,
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
delete process.env.ABCP_TS_CLIENT_ID;
delete process.env.ABCP_TS_AGREEMENT_ID;
delete process.env.ABCP_TS_DELIVERY_METHOD_ID;
delete process.env.ABCP_TS_PICKUP_OFFICE_ID;
delete process.env.ABCP_TS_SHIPMENT_ADDRESS_ID;
delete process.env.ABCP_TS_NEW_CLIENT_MARKET_TYPE;
delete process.env.ABCP_TS_NEW_CLIENT_PASSWORD;
delete process.env.ABCP_TS_NEW_CLIENT_CITY;
delete process.env.ABCP_TS_NEW_CLIENT_FILIAL_ID;
delete process.env.ABCP_TS_NEW_CLIENT_PROFILE_ID;
delete process.env.ABCP_TS_NEW_CLIENT_EMAIL;

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
  const clearCall = calls.find((x) => x.method === "post" && x.url === "/basket/clear");
  assert.equal(clearCall, undefined, "basket/clear should not be called by default");
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

test("abcpOrder: enriches Cortex offer from session.abcp before ordering", { concurrency: false }, async () => {
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
          orders: [{ number: "A-3001" }],
        },
      };
    }
    return { data: { status: 1 } };
  };

  const result = await createAbcpOrderFromSession({
    dialogId: "chat-enrich-1",
    session: {
      state: {
        chosen_offer_id: 1,
        offers: [
          {
            id: 1,
            oem: "61217726563",
            brand: "BMW",
            price: 12400,
            delivery_days: 14,
          },
        ],
      },
      abcp: {
        "61217726563": {
          offers: [
            {
              oem: "61217726563",
              brand: "BMW",
              price: 12400,
              minDays: 14,
              supplierCode: 11880411,
              itemKey: "ITEMKEY-61217726563-1",
              numberFix: "61217726563",
            },
          ],
        },
      },
    },
    llm: {
      stage: "ABCP_CREATE",
      chosen_offer_id: 1,
      offers: [
        {
          id: 1,
          oem: "61217726563",
          brand: "BMW",
          price: 12400,
          delivery_days: 14,
        },
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.orderNumbers, ["A-3001"]);

  const addCall = calls.find((x) => x.method === "post" && x.url === "/basket/add");
  assert.ok(addCall, "basket/add must be called");

  const addBody = parseFormBody(addCall.body);
  assert.equal(addBody.get("positions[0][brand]"), "BMW");
  assert.equal(addBody.get("positions[0][number]"), "61217726563");
  assert.equal(addBody.get("positions[0][supplierCode]"), "11880411");
  assert.equal(addBody.get("positions[0][itemKey]"), "ITEMKEY-61217726563-1");
});

test("abcpOrder: returns BASKET_ADD_FAILED when basket/add is rejected", { concurrency: false }, async () => {
  calls.length = 0;

  postImpl = async (url) => {
    if (url === "/basket/add") return { data: { status: 0, errorMessage: "bad position" } };
    return { data: { status: 1 } };
  };
  getImpl = async () => ({ data: [] });

  const result = await createAbcpOrderFromSession({
    dialogId: "chat-add-fail",
    session: {
      state: {
        chosen_offer_id: 1,
        offers: [{ id: 1, brand: "A", oem: "B123456", supplierCode: "S", itemKey: "K" }],
      },
    },
    llm: { stage: "ABCP_CREATE", chosen_offer_id: 1 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "BASKET_ADD_FAILED");
  const orderCall = calls.find((x) => x.method === "post" && x.url === "/basket/order");
  assert.equal(orderCall, undefined, "basket/order should not be called on add error");
});

test("abcpOrder: idempotency blocks duplicate order submission", { concurrency: false }, async () => {
  calls.length = 0;

  postImpl = async (url) => {
    if (url === "/basket/order") {
      return {
        data: {
          status: 1,
          orders: [],
        },
      };
    }
    return { data: { status: 1 } };
  };
  getImpl = async (url) => {
    if (url === "/basket/shipmentMethods") return { data: [{ id: 12 }] };
    if (url === "/basket/shipmentAddresses") return { data: [{ id: 44 }] };
    return { data: [] };
  };

  const payload = {
    dialogId: "chat-idem-1",
    session: {
      state: {
        chosen_offer_id: 9,
        offers: [{ id: 9, code: "CODE-9" }],
      },
    },
    llm: { stage: "ABCP_CREATE", chosen_offer_id: 9 },
  };

  const first = await createAbcpOrderFromSession(payload);
  assert.equal(first.ok, false);
  assert.equal(first.reason, "ORDER_ACCEPTED_WITHOUT_NUMBER");

  const callsAfterFirst = calls.length;
  const second = await createAbcpOrderFromSession(payload);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "ORDER_ALREADY_SUBMITTED_RECENTLY");
  assert.equal(calls.length, callsAfterFirst, "second call should not hit ABCP API");
});

test("abcpOrder: falls back to TS API when basket v1 is disabled", { concurrency: false }, async () => {
  calls.length = 0;

  postImpl = async (url) => {
    if (url === "/basket/add") {
      const err = new Error("Orders v1 disabled");
      err.response = {
        status: 500,
        data: { errorCode: 403, errorMessage: "Access is denied. Orders v1 disabled." },
      };
      throw err;
    }
    if (url === "/ts/cart/create") return { data: { id: 3001 } };
    if (url === "/ts/orders/createByCart") return { data: { number: "TS-9001" } };
    return { data: { status: 1 } };
  };

  getImpl = async (url, cfg) => {
    if (url === "/cp/users") {
      return { data: [{ userId: 777, phone: cfg?.params?.phone || null }] };
    }
    if (url === "/ts/agreements/list") {
      return { data: { list: [{ id: 888, clientId: 777 }] } };
    }
    if (url === "/ts/deliveryMethod/forCo") {
      return {
        data: {
          list: [
            {
              id: 4,
              type: "pickup",
              offices: [{ id: 91, address: "Test office" }],
              addresses: [],
            },
          ],
        },
      };
    }
    return { data: [] };
  };

  const result = await createAbcpOrderFromSession({
    dialogId: "chat-ts-fallback",
    session: {
      state: {
        chosen_offer_id: 7,
        offers: [
          {
            id: 7,
            brand: "LAND ROVER",
            oem: "102123458",
            numberFix: "102123458",
            supplierCode: 11849297,
            itemKey: "K7",
            description: "Запчасть 102123458",
          },
        ],
      },
      phone: "+79990000001",
    },
    llm: { stage: "ABCP_CREATE", chosen_offer_id: 7 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.orderNumbers, ["TS-9001"]);

  const tsOrderCall = calls.find((x) => x.method === "post" && x.url === "/ts/orders/createByCart");
  assert.ok(tsOrderCall, "ts/orders/createByCart must be called");
  const tsOrderBody = parseFormBody(tsOrderCall.body);
  assert.equal(tsOrderBody.get("delivery[methodId]"), "4");
  assert.equal(tsOrderBody.get("positions[0]"), "3001");
  assert.equal(tsOrderBody.get("clientId"), "777");
  assert.equal(tsOrderBody.get("agreementId"), "888");
});

test("abcpOrder: creates new ABCP client when not found by phone", { concurrency: false }, async () => {
  calls.length = 0;

  let cpUsersCalls = 0;

  postImpl = async (url, _body) => {
    if (url === "/basket/add") {
      const err = new Error("Orders v1 disabled");
      err.response = {
        status: 500,
        data: { errorCode: 403, errorMessage: "Access is denied. Orders v1 disabled." },
      };
      throw err;
    }
    if (url === "/cp/user/new") return { data: { status: 1, userCode: "BOT-10001" } };
    if (url === "/ts/cart/create") return { data: { id: 4444 } };
    if (url === "/ts/orders/createByCart") return { data: { number: "TS-9002" } };
    return { data: { status: 1 } };
  };

  getImpl = async (url) => {
    if (url === "/cp/users") {
      cpUsersCalls += 1;
      if (cpUsersCalls <= 2) return { data: [] };
      return { data: [{ userId: 9012, phone: "79997776655" }] };
    }
    if (url === "/ts/agreements/list") return { data: { list: [] } };
    if (url === "/ts/deliveryMethod/forCo") {
      return {
        data: {
          list: [
            {
              id: 4,
              type: "pickup",
              offices: [{ id: 91, address: "Test office" }],
              addresses: [],
            },
          ],
        },
      };
    }
    return { data: [] };
  };

  const result = await createAbcpOrderFromSession({
    dialogId: "chat-ts-create-client",
    session: {
      state: {
        chosen_offer_id: 7,
        client_name: "Иван Петров",
        offers: [
          {
            id: 7,
            brand: "LAND ROVER",
            oem: "102123458",
            numberFix: "102123458",
            supplierCode: 11849297,
            itemKey: "K7",
            description: "Запчасть 102123458",
          },
        ],
      },
      phone: "+79997776655",
    },
    llm: { stage: "ABCP_CREATE", chosen_offer_id: 7 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.orderNumbers, ["TS-9002"]);

  const createUserCall = calls.find((x) => x.method === "post" && x.url === "/cp/user/new");
  assert.ok(createUserCall, "cp/user/new must be called");

  const createUserBody = parseFormBody(createUserCall.body);
  assert.equal(createUserBody.get("mobile"), "79997776655");
  assert.equal(createUserBody.get("name"), "Иван");
  assert.equal(createUserBody.get("surname"), "Петров");

  const tsOrderCall = calls.find((x) => x.method === "post" && x.url === "/ts/orders/createByCart");
  assert.ok(tsOrderCall, "ts/orders/createByCart must be called");
  const tsOrderBody = parseFormBody(tsOrderCall.body);
  assert.equal(tsOrderBody.get("clientId"), "9012");
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
