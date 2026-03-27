export const DEFAULT_SIMULATOR_INSTRUCTION = "你是一个模拟客户，正在与 SDR（销售开发代表）沟通。你的目标是根据给定的背景信息，模拟真实的客户行为。请保持自然、有逻辑，并根据对方的回复进行互动。";
export const DEFAULT_SCORING_INSTRUCTION = "请根据以下 SDR 与客户的对话记录，对 SDR 的表现进行评分（0-100 分）。评分标准包括：专业度、响应速度、需求挖掘能力、引导能力。请输出 JSON：{\"score\": 整数, \"reason\": \"评分理由\"}。";

export function buildSimulatorPrompt(config, direction, conversation) {
  const lines = conversation.map((message) => `${message.role === "user" ? "客户" : "SDR"}: ${message.content}`);
  return [
    `背景信息: 方向: ${direction.title || direction.topic || config.topic || "未命名方向"}`,
    `对话主题: ${direction.topic || config.topic || direction.title || "未命名主题"}`,
    `用户画像: ${direction.userDescription || config.userDescription || "普通潜在客户"}`,
    `历史摘要: ${direction.historySummary || config.historySummary || "无"}`,
    `当前对话历史: ${lines.join("\n") || "无"}`,
    "请输出你作为客户的下一句话。只输出对话内容，不要有其他解释。",
  ].join(" ");
}

export function buildScoringPrompt(config, direction, conversation) {
  const lines = conversation.map((message) => `${message.role === "user" ? "客户" : "SDR"}: ${message.content}`);
  return [
    `测试方向: ${direction.title || direction.topic || config.topic || "未命名方向"}`,
    `对话主题: ${direction.topic || config.topic || direction.title || "未命名主题"}`,
    `待评估对话记录: ${lines.join("\n")}`,
    "请根据指令进行评分。输出格式必须为 JSON: { \"score\": 0-100的整数, \"reason\": \"评分理由\" }",
  ].join(" ");
}
