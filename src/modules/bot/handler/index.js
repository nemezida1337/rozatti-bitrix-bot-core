// src/modules/bot/handler/index.js
//
// V2-only оркестратор:
// - сериализация по dialogId (один чат = один поток)
// - stale-guard по messageId (если пришёл старый эвент — игнорируем)
// - уважение leadDecisionGate (не зовём Cortex/flows, когда нельзя)
// - вызов вынесенных flows без изменения бизнес-логики

import { makeBitrixClient } from "../../../core/bitrixClient.js";
import { logger } from "../../../core/logger.js";
import { normalizeIncomingMessage } from "../../../core/messageModel.js";
import { getPortal } from "../../../core/store.js";
import { saveSession } from "../sessionStore.js";

import { buildContext } from "./context.js";
import { buildDecision } from "./decision.js";
import { runCortexTwoPassFlow } from "./flows/cortexTwoPassFlow.js";
import { runFastOemFlow } from "./flows/fastOemFlow.js";
import { runManagerOemTriggerFlow } from "./flows/managerOemTriggerFlow.js";
import { sendChatReplyIfAllowed } from "./shared/chatReply.js";
import { resolveSmallTalk } from "./shared/smallTalk.js";


// -----------------------------
// Simple in-memory mutex by key
// -----------------------------
const _locks = new Map();

async function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  // Не даём упавшему предыдущему обработчику порвать очередь.
  const current = prev.catch(() => {}).then(() => fn());
  _locks.set(key, current);

  try {
    return await current;
  } finally {
    // Очистка хвоста только если он всё ещё указывает на этот job.
    if (_locks.get(key) === current) _locks.delete(key);
  }
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}


function ensureSession(dialogId, session) {
  if (session) {
    session.state = session.state || {};
    if (typeof session.abcp === "undefined") session.abcp = null;
    if (!Array.isArray(session.state.oems)) session.state.oems = [];
    if (!Array.isArray(session.state.offers)) session.state.offers = [];
    if (typeof session.mode === "undefined") session.mode = "auto";
    if (typeof session.manualAckSent === "undefined") session.manualAckSent = false;
    if (!Array.isArray(session.oem_candidates)) session.oem_candidates = [];
    if (typeof session.lastSeenLeadOem === "undefined") session.lastSeenLeadOem = null;
    return session;
  }

  return {
    dialogId,
    leadId: null,
    phone: null,
    abcp: null,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
    state: {
      stage: "NEW",
      client_name: null,
      last_reply: null,
      oems: [],
      offers: [],
      chosen_offer_id: null,
    },
    updatedAt: Date.now(),
  };
}

export async function processIncomingBitrixMessage({ body, portal, domain }) {
  const normalized = normalizeIncomingMessage(body) || {};
  // Стабильный ключ для локов
  const dialogId = normalized?.dialogId || "unknown";
  const domainKey =
    domain ||
    normalized?.portal ||
    body?._portal ||
    body?.auth?.domain ||
    body?.data?.AUTH?.domain ||
    portal?.domain ||
    "unknown";

  const lockKey = `${domainKey}__${dialogId}`;

  return withLock(lockKey, async () => {
    // Берём самый свежий portal из store (tokens могли обновиться)
    const portalCfg = portal || (domainKey !== "unknown" ? getPortal(domainKey) : null) || {};

    const ctx = await buildContext({ body, portal: portalCfg, domain: domainKey });

    if (!ctx?.domain || !ctx?.portal?.baseUrl || !ctx?.portal?.accessToken) {
      logger.warn(
        { domainKey, dialogId, hasToken: !!ctx?.portal?.accessToken },
        "[V2] no portal token/baseUrl — skip",
      );
      return;
    }

    const api = makeBitrixClient({
      domain: ctx.domain,
      baseUrl: ctx.portal.baseUrl,
      accessToken: ctx.portal.accessToken,
    });

    const session = ensureSession(ctx?.message?.dialogId || dialogId, ctx.session);
    ctx.session = session;
    const msgId = toInt(ctx?.message?.messageId);
    const lastMsgId = toInt(session?.lastProcessedMessageId);

    if (msgId && lastMsgId && msgId <= lastMsgId) {
      logger.warn(
        { dialogId, msgId, lastMsgId },
        "[V2] stale message ignored",
      );
      return;
    }

    // Обновляем tracking до выполнения (чтобы при дублях не улетали 2 ответа)
    if (msgId) session.lastProcessedMessageId = msgId;
    session.lastProcessedAt = Date.now();

    // --- MANUAL trigger (manager filled OEM in lead) ---
    const manualByStatus =
      !!ctx?.lead?.statusId &&
      Array.isArray(ctx?.manualStatuses) &&
      ctx.manualStatuses.includes(ctx.lead.statusId);

    const manualLock = manualByStatus || session?.mode === "manual";

    if (manualLock) {
      // если менеджер записал OEM в лид — auto start
      const handled = await runManagerOemTriggerFlow({
        api,
        portalDomain: ctx.domain,
        portalCfg: ctx.portal,
        dialogId: ctx.message.dialogId,
        session,
        baseCtx: "modules/bot/handler/v2",
      });

      saveSession(ctx.domain, ctx.message.dialogId, session);

      if (handled) {
        logger.info({ dialogId }, "[V2] handled by manager OEM trigger");
      } else {
        logger.info({ dialogId }, "[V2] manual lock: no trigger, silent");
      }
      return;
    }

    // --- Fast OEM flow (simple OEM query, NEW stage) ---
    const canRunFastOem = !ctx?.message?.isSystemLike && !ctx?.message?.isForwarded;
    const fastHandled = canRunFastOem
      ? await runFastOemFlow({
          api,
          portalDomain: ctx.domain,
          portalCfg: ctx.portal,
          dialogId: ctx.message.dialogId,
          chatId: ctx.message.chatId,
          text: ctx.message.text,
          session,
          baseCtx: "modules/bot/handler/v2",
        })
      : false;

    if (fastHandled) {
      logger.info({ dialogId }, "[V2] handled by fast OEM flow");
      return;
    }

    // --- Decision gate ---
    const { gateInput, decision } = buildDecision(ctx);

    // --- Small talk / off-topic / how-to (client-only) ---
    const smallTalk =
      gateInput?.authorType === "client" &&
      ctx?.message?.text &&
      !ctx?.hasImage &&
      (!ctx?.detectedOems || ctx.detectedOems.length === 0)
        ? resolveSmallTalk(ctx.message.text)
        : null;

    if (smallTalk) {
      await sendChatReplyIfAllowed({
        api,
        portalDomain: ctx.domain,
        portalCfg: ctx.portal,
        dialogId: ctx.message.dialogId,
        leadId: session.leadId,
        message: smallTalk.reply,
      });

      session.lastSmallTalkIntent = smallTalk.intent;
      session.lastSmallTalkTopic = smallTalk.topic || null;
      session.lastSmallTalkAt = Date.now();
      saveSession(ctx.domain, ctx.message.dialogId, session);

      logger.info({ dialogId, smallTalkIntent: smallTalk.intent }, "[V2] handled by small talk");
      return;
    }

    logger.info(
      { dialogId, gateInput, decision },
      "[V2] DECISION",
    );

    // Если gate запрещает — ничего не делаем (важно: no greetings reply)
    if (!decision?.shouldCallCortex) {
      // Если нужно зафиксировать one-time ack/manual flag — это будет отдельным этапом
      saveSession(ctx.domain, ctx.message.dialogId, session);
      return;
    }

    // --- Default: Cortex 2-pass flow ---
    await runCortexTwoPassFlow({
      api,
      portalDomain: ctx.domain,
      portalCfg: ctx.portal,
      dialogId: ctx.message.dialogId,
      chatId: ctx.message.chatId,
      text: ctx.message.text,
      session,
      baseCtx: "modules/bot/handler/v2",
    });

    return;
  });
}
