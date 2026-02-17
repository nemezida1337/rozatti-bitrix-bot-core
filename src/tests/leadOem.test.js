import assert from "node:assert/strict";
import test from "node:test";

import { isManagerOemTrigger, readLeadOem } from "../modules/bot/handler/shared/leadOem.js";
import { crmSettings } from "../modules/settings.crm.js";

test("leadOem.readLeadOem: returns null when leadId is missing", async () => {
  const api = {
    async call() {
      throw new Error("api.call should not be used");
    },
  };

  const oem = await readLeadOem({ api, leadId: null });
  assert.equal(oem, null);
});

test("leadOem.readLeadOem: reads and trims OEM from lead", async () => {
  const oemField = crmSettings.leadFields.OEM;
  const api = {
    async call(method, payload) {
      assert.equal(method, "crm.lead.get");
      assert.deepEqual(payload, { id: 801 });
      return {
        ID: 801,
        [oemField]: "  6Q0820803D  ",
      };
    },
  };

  const oem = await readLeadOem({ api, leadId: 801 });
  assert.equal(oem, "6Q0820803D");
});

test("leadOem.readLeadOem: returns null when crm.lead.get throws", async () => {
  const api = {
    async call() {
      throw new Error("network fail");
    },
  };

  const oem = await readLeadOem({ api, leadId: 802 });
  assert.equal(oem, null);
});

test("leadOem.isManagerOemTrigger: true only for empty->filled transition", () => {
  assert.equal(isManagerOemTrigger({ lastSeenLeadOem: null }, "OEM123"), true);
  assert.equal(isManagerOemTrigger({ lastSeenLeadOem: "OEMOLD" }, "OEM123"), false);
  assert.equal(isManagerOemTrigger({ lastSeenLeadOem: "" }, " "), false);
});

