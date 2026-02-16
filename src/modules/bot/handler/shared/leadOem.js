// src/modules/bot/handler/shared/leadOem.js

import { logger } from "../../../../core/logger.js";
import { crmSettings } from "../../../settings.crm.js";

const CTX = "modules/bot/handler/shared/leadOem";

export async function readLeadOem({ api, leadId }) {
  const oemField = crmSettings?.leadFields?.OEM;
  if (!leadId || !oemField) return null;

  try {
    const lead = await api.call("crm.lead.get", { id: leadId });
    const raw = lead?.[oemField];
    if (!raw) return null;
    const val = String(raw).trim();
    return val || null;
  } catch (err) {
    logger.warn(
      { ctx: `${CTX}.readLeadOem`, leadId, err: err?.message || String(err) },
      "Не смогли прочитать OEM из лида",
    );
    return null;
  }
}

export function isManagerOemTrigger(session, currentLeadOem) {
  const prev = session?.lastSeenLeadOem ? String(session.lastSeenLeadOem).trim() : "";
  const now = currentLeadOem ? String(currentLeadOem).trim() : "";
  return !prev && !!now;
}
