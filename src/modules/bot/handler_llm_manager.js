// (псевдокод)
const analysis = await llmFunnelEngine.run(session, message, context);

// 1) текст клиенту
await sendToChat(analysis.reply);

// 2) ABCP
if (analysis.need_abcp) {
  const offers = await abcp.searchMany(analysis.abcp_oems, ...);
  session.offers = offers; // чтоб LLM видела на следующем шаге
}

// 3) CRM
if (analysis.crm_update) {
  await crm.updateLeadOrContact(analysis.crm_update);
  if (analysis.crm_update.NAME) session.name = analysis.crm_update.NAME;
  if (analysis.crm_update.PHONE) session.phone = normalize(analysis.crm_update.PHONE);
}

// 4) сохранить stage, intent в сессию
