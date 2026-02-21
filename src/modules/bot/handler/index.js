// src/modules/bot/handler/index.js
//
// V2-only оркестратор:
// - сериализация по dialogId (один чат = один поток)
// - stale-guard по messageId (если пришёл старый эвент — игнорируем)
// - уважение leadDecisionGate (не зовём Cortex/flows, когда нельзя)
// - вызов вынесенных flows без изменения бизнес-логики

import { makeBitrixClient } from "../../../core/bitrixClient.js";
import { withRedisLock } from "../../../core/distributedState.js";
import { logger } from "../../../core/logger.js";
import { normalizeIncomingMessage } from "../../../core/messageModel.js";
import { getPortalAsync } from "../../../core/store.js";
import { safeUpdateLeadAndContact } from "../../crm/leads.js";
import { saveSessionAsync } from "../sessionStore.js";

import { buildContext } from "./context.js";
import { buildDecision } from "./decision.js";
import { runCortexTwoPassFlow } from "./flows/cortexTwoPassFlow.js";
import { runFastOemFlow } from "./flows/fastOemFlow.js";
import { runManagerOemTriggerFlow } from "./flows/managerOemTriggerFlow.js";
import { sendChatReplyIfAllowed } from "./shared/chatReply.js";
import {
  isFastOemPathEnabled,
  resolveClassifierModeForDialog,
  shouldRunShadowForDialog,
} from "./shared/classificationMode.js";
import {
  appendSessionHistoryTurn,
  buildRepeatFollowupReply,
  detectRepeatFollowup,
  inferMessageAuthorRole,
} from "./shared/historyContext.js";
import {
  MARKETPLACE_PRICE_SYNC_REPLY,
  isMarketplacePriceSyncNotification,
} from "./shared/serviceNotifications.js";
import { applyLlmToSession } from "./shared/session.js";
import {
  normalizeSmallTalkText,
  resolveSmallTalk,
  shouldSkipSmallTalkReply,
} from "./shared/smallTalk.js";

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

function toPositiveIntOrDefault(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function buildGateReply(decision) {
  if (!decision?.shouldReply) return null;

  if (decision?.replyType === "MANUAL_ACK") {
    if (decision?.waitReason === "VIN_WAIT_OEM") {
      return "Принял VIN. Передаю менеджеру на подбор, скоро вернусь с вариантами.";
    }
    if (decision?.waitReason === "PHOTO_WAIT_OEM" || decision?.waitReason === "COMPLEX_WAIT_OEM") {
      return "Принял вложение. Передаю менеджеру на подбор, скоро вернусь с вариантами.";
    }
    return "Принял запрос. Передаю менеджеру на подбор.";
  }

  if (decision?.replyType === "AUTO_START") {
    return "Принял запрос, начинаю подбор.";
  }

  if (decision?.replyType === "PRICING_OBJECTION_PRICE") {
    return "Понял по цене. Могу подобрать дешевле: напишите бюджет или номера вариантов, которые рассмотреть.";
  }

  if (decision?.replyType === "PRICING_OBJECTION_DELIVERY") {
    return "Понял по сроку. Могу подобрать быстрее: напишите желаемый срок или номера вариантов.";
  }

  if (decision?.replyType === "PRICING_FOLLOWUP") {
    return "Запрос в работе. Чтобы продолжить, выберите номер варианта из списка (можно несколько).";
  }

  if (decision?.replyType === "PRICING_NEED_SELECTION") {
    return "Чтобы продолжить, выберите номер варианта из списка (можно несколько).";
  }

  return null;
}

function toShortRouteLabel(decision) {
  if (!decision) return "unknown";
  if (decision.shouldCallCortex) return "cortex";
  const reason = decision.replyType || decision.waitReason || "silent";
  return `gate:${reason}`;
}

function isTruthy(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function buildShadowPreview({ ctx, gateInput, targetMode }) {
  const isLegacyTarget = targetMode === "legacy";
  const { decision: targetDecision } = buildDecision(ctx, {
    legacyNodeClassificationOverride: isLegacyTarget,
  });

  if (!isLegacyTarget) {
    return {
      targetMode: "cortex",
      route: toShortRouteLabel(targetDecision),
      callsCortex: !!targetDecision?.shouldCallCortex,
      replyType: targetDecision?.replyType || null,
      waitReason: targetDecision?.waitReason || null,
      smallTalkIntent: null,
      serviceNotice: false,
    };
  }

  const serviceNotice = isMarketplacePriceSyncNotification({
    text: ctx?.message?.text,
    chatEntityType: ctx?.message?.chatEntityType,
    userFlags: ctx?.message?.userFlags,
    isSystemLike: !!ctx?.message?.isSystemLike,
    isForwarded: !!ctx?.message?.isForwarded,
  });

  const smallTalk =
    gateInput?.authorType === "client" &&
    ctx?.message?.text &&
    !ctx?.hasImage &&
    (!ctx?.detectedOems || ctx.detectedOems.length === 0)
      ? resolveSmallTalk(ctx.message.text)
      : null;

  let route = toShortRouteLabel(targetDecision);
  if (serviceNotice) route = "service_notice";
  else if (smallTalk) route = `smalltalk:${smallTalk.intent || "UNKNOWN"}`;

  return {
    targetMode: "legacy",
    route,
    callsCortex: !serviceNotice && !smallTalk && !!targetDecision?.shouldCallCortex,
    replyType: targetDecision?.replyType || null,
    waitReason: targetDecision?.waitReason || null,
    smallTalkIntent: smallTalk?.intent || null,
    serviceNotice: !!serviceNotice,
  };
}

function ensureSession(dialogId, session) {
  if (session) {
    session.state = session.state || {};
    if (typeof session.abcp === "undefined") session.abcp = null;
    if (typeof session.dealId === "undefined") session.dealId = null;
    if (!Array.isArray(session.state.oems)) session.state.oems = [];
    if (!Array.isArray(session.state.offers)) session.state.offers = [];
    if (typeof session.mode === "undefined") session.mode = "auto";
    if (typeof session.manualAckSent === "undefined") session.manualAckSent = false;
    if (!Array.isArray(session.oem_candidates)) session.oem_candidates = [];
    if (typeof session.lastSeenLeadOem === "undefined") session.lastSeenLeadOem = null;
    if (typeof session.leadOemBaselineInitialized === "undefined") {
      session.leadOemBaselineInitialized = false;
    }
    if (!Array.isArray(session.history)) session.history = [];
    return session;
  }

  return {
    dialogId,
    leadId: null,
    dealId: null,
    phone: null,
    abcp: null,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
    leadOemBaselineInitialized: false,
    history: [],
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

  const runInProcessLock = async () =>
    withLock(lockKey, async () => {
      // Берём самый свежий portal из store (tokens могли обновиться)
      const portalCfg =
        portal || (domainKey !== "unknown" ? await getPortalAsync(domainKey) : null) || {};

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
        logger.warn({ dialogId, msgId, lastMsgId }, "[V2] stale message ignored");
        return;
      }

      // Обновляем tracking до выполнения (чтобы при дублях не улетали 2 ответа)
      if (msgId) session.lastProcessedMessageId = msgId;
      session.lastProcessedAt = Date.now();

      const authorRole = inferMessageAuthorRole(ctx?.message || {});
      const incomingDealId = toInt(ctx?.message?.dealId);
      if (incomingDealId && incomingDealId > 0) {
        session.dealId = incomingDealId;
      }
      const classifierMode = resolveClassifierModeForDialog(ctx?.message?.dialogId || dialogId);
      const legacyNodeClassification = classifierMode === "legacy";
      const fastOemPathEnabled = isFastOemPathEnabled(process.env, legacyNodeClassification);
      const shadowEnabled = shouldRunShadowForDialog(ctx?.message?.dialogId || dialogId);
      const repeatFollowup = detectRepeatFollowup({
        session,
        text: ctx?.message?.text,
        authorRole,
        hasImage: !!ctx?.hasImage,
        detectedOems: Array.isArray(ctx?.detectedOems) ? ctx.detectedOems : [],
      });

      appendSessionHistoryTurn(session, {
        role: authorRole,
        text: ctx?.message?.text || "",
        messageId: msgId,
        kind: "incoming",
        ts: Date.now(),
      });

      const sendAndTrackBotReply = async (message, kind = null) => {
        const text = String(message || "").trim();
        if (!text) return;

        const sent = await sendChatReplyIfAllowed({
          api,
          portalDomain: ctx.domain,
          portalCfg: ctx.portal,
          dialogId: ctx.message.dialogId,
          leadId: session.leadId,
          dealId: session.dealId,
          message: text,
        });
        if (!sent) return;

        appendSessionHistoryTurn(session, {
          role: "bot",
          text,
          messageId: null,
          kind: kind || "bot_reply",
          ts: Date.now(),
        });
      };

      const dealId = incomingDealId || toInt(session?.dealId);
      if (dealId && dealId > 0) {
        session.dealId = dealId;
        await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);
        logger.info(
          { dialogId, dealId: String(dealId) },
          "[V2] deal-bound chat: bot reply disabled",
        );
        return;
      }

      // Полное отключение бота для отдельных статусов (например, "Постоянный клиент")
      const botDisabledByStatus =
        !!ctx?.lead?.statusId &&
        Array.isArray(ctx?.botDisabledStatuses) &&
        ctx.botDisabledStatuses.includes(ctx.lead.statusId);

      if (botDisabledByStatus) {
        await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);
        logger.info(
          { dialogId, statusId: ctx?.lead?.statusId },
          "[V2] bot disabled by lead status",
        );
        return;
      }

      if (repeatFollowup) {
        const repeatReply = buildRepeatFollowupReply({
          session,
          followup: repeatFollowup,
        });

        await sendAndTrackBotReply(repeatReply, "repeat_followup");
        await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);

        logger.info(
          {
            dialogId,
            promptType: repeatFollowup.promptType,
            gapTurns: repeatFollowup.gap_turns,
          },
          "[V2] handled by repeat followup context",
        );
        return;
      }

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

        await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);

        if (handled) {
          logger.info({ dialogId }, "[V2] handled by manager OEM trigger");
        } else {
          logger.info({ dialogId }, "[V2] manual lock: no trigger, silent");
        }
        return;
      }

      // --- Marketplace service notifications (no OEM/Cortex path) ---
      if (legacyNodeClassification) {
        const servicePriceSyncNotice = isMarketplacePriceSyncNotification({
          text: ctx?.message?.text,
          chatEntityType: ctx?.message?.chatEntityType,
          userFlags: ctx?.message?.userFlags,
          isSystemLike: !!ctx?.message?.isSystemLike,
          isForwarded: !!ctx?.message?.isForwarded,
        });

        if (servicePriceSyncNotice) {
          const serviceReply = MARKETPLACE_PRICE_SYNC_REPLY;

          // Сначала отвечаем в чат (пока лид ещё не в manual-стадии),
          // затем переводим лид в "Взять в работу!".
          await sendAndTrackBotReply(serviceReply, "service_notice");

          const serviceLlm = {
            stage: "IN_WORK",
            action: "service_notice",
            reply: serviceReply,
            oems: [],
            update_lead_fields: {},
            product_rows: [],
            offers: [],
            chosen_offer_id: null,
            contact_update: null,
          };

          await safeUpdateLeadAndContact({
            portal: ctx.domain,
            dialogId: ctx.message.dialogId,
            chatId: ctx.message.chatId,
            session,
            llm: serviceLlm,
            lastUserMessage: ctx.message.text,
            usedBackend: "RULE_SERVICE_NOTICE",
          });

          applyLlmToSession(session, serviceLlm);
          session.mode = "manual";
          session.manualAckSent = false;
          await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);

          logger.info(
            { dialogId, leadId: session.leadId },
            "[V2] handled by marketplace service notice (legacy node classifier)",
          );
          return;
        }
      }

      // --- Fast OEM flow (simple OEM query, NEW stage) ---
      const canRunFastOem =
        fastOemPathEnabled && !ctx?.message?.isSystemLike && !ctx?.message?.isForwarded;
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
      const { gateInput, decision } = buildDecision(ctx, {
        legacyNodeClassificationOverride: legacyNodeClassification,
      });
      const shadowTargetMode = legacyNodeClassification ? "cortex" : "legacy";
      const shadowPreview = shadowEnabled
        ? buildShadowPreview({ ctx, gateInput, targetMode: shadowTargetMode })
        : null;
      const shouldLogShadowMatch = isTruthy(process.env.HF_CORTEX_SHADOW_LOG_MATCH);

      const logShadowComparison = ({ actualRoute, actualDecision = null }) => {
        if (!shadowPreview) return;

        const targetCallsCortex = !!shadowPreview.callsCortex;
        const normalizedActualRoute = String(actualRoute || "unknown");
        const actualCallsCortex = normalizedActualRoute.startsWith("cortex");

        let diverged = targetCallsCortex !== actualCallsCortex;
        if (!diverged && !targetCallsCortex && !actualCallsCortex) {
          diverged = shadowPreview.route !== normalizedActualRoute;
        }

        if (!diverged && !shouldLogShadowMatch) return;

        const logPayload = {
          dialogId,
          messageId: msgId,
          classifierMode,
          actualRoute: normalizedActualRoute,
          actualIntent: actualDecision?.intent || session?.lastCortexDecision?.intent || null,
          actualAction: actualDecision?.action || session?.lastCortexDecision?.action || null,
          actualStage: actualDecision?.stage || session?.lastCortexDecision?.stage || null,
          shadowTargetMode: shadowPreview.targetMode,
          shadowRoute: shadowPreview.route,
          shadowCallsCortex: targetCallsCortex,
          shadowReplyType: shadowPreview.replyType,
          shadowWaitReason: shadowPreview.waitReason,
          shadowSmallTalkIntent: shadowPreview.smallTalkIntent,
          shadowServiceNotice: shadowPreview.serviceNotice,
          legacyRoute: shadowPreview.targetMode === "legacy" ? shadowPreview.route : null,
          legacyCallsCortex: shadowPreview.targetMode === "legacy" ? targetCallsCortex : null,
        };

        if (diverged) {
          logger.warn(logPayload, "[V2][SHADOW] divergence legacy vs cortex");
        } else {
          logger.info(logPayload, "[V2][SHADOW] match legacy vs cortex");
        }
      };

      // --- Small talk / off-topic / how-to (client-only) ---
      const smallTalk =
        legacyNodeClassification &&
        gateInput?.authorType === "client" &&
        ctx?.message?.text &&
        !ctx?.hasImage &&
        (!ctx?.detectedOems || ctx.detectedOems.length === 0)
          ? resolveSmallTalk(ctx.message.text)
          : null;

      if (smallTalk) {
        const isDuplicate = shouldSkipSmallTalkReply({
          session,
          rawText: ctx.message.text,
          intent: smallTalk.intent,
          topic: smallTalk.topic || null,
        });

        if (!isDuplicate) {
          await sendAndTrackBotReply(smallTalk.reply, "smalltalk");
        }

        session.lastSmallTalkIntent = smallTalk.intent;
        session.lastSmallTalkTopic = smallTalk.topic || null;
        session.lastSmallTalkAt = Date.now();
        session.lastSmallTalkTextNormalized = normalizeSmallTalkText(ctx.message.text || "");
        await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);

        logger.info(
          { dialogId, smallTalkIntent: smallTalk.intent, smallTalkDedup: isDuplicate },
          "[V2] handled by small talk",
        );
        return;
      }

      logger.info({ dialogId, gateInput, decision }, "[V2] DECISION");

      // Если gate запрещает — ничего не делаем (важно: no greetings reply)
      if (!decision?.shouldCallCortex) {
        if (decision?.mode === "manual" || decision?.mode === "auto") {
          session.mode = decision.mode;
        }

        const gateReply = buildGateReply(decision);
        if (gateReply) {
          await sendAndTrackBotReply(gateReply, "gate_reply");

          if (decision?.replyType === "MANUAL_ACK") {
            session.manualAckSent = true;
          }
        }

        await saveSessionAsync(ctx.domain, ctx.message.dialogId, session);
        logShadowComparison({ actualRoute: toShortRouteLabel(decision) });
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

      logShadowComparison({
        actualRoute: session?.lastCortexRoute || "cortex",
        actualDecision: session?.lastCortexDecision || null,
      });

      return;
    });

  const distributedLockTtlMs = toPositiveIntOrDefault(process.env.BOT_DIALOG_LOCK_TTL_MS, 45000);
  const distributedLockWaitMs = toPositiveIntOrDefault(process.env.BOT_DIALOG_LOCK_WAIT_MS, 45000);
  const distributedLockPollMs = toPositiveIntOrDefault(process.env.BOT_DIALOG_LOCK_POLL_MS, 120);

  return withRedisLock(
    {
      scope: "dialog_lock",
      key: lockKey,
      ttlMs: distributedLockTtlMs,
      waitTimeoutMs: distributedLockWaitMs,
      pollMs: distributedLockPollMs,
    },
    runInProcessLock,
  );
}
