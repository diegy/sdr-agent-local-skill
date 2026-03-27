import { delay, formatLocalDateTime, generateUuidLike, randomAlphaNumeric } from "./utils.mjs";

const SDR_UPSTREAM_TIMEOUT_MS = 30000;
const WEBSITE_WEBIM_TIMEOUT_MS = 70000;
const SDR_IDLE_FLUSH_MS = 1200;
const WEBIM_POLL_INTERVAL_MS = 1200;
const webImSessionStore = new Map();

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodePossiblyNestedJson(value, maxDepth = 3) {
  let current = value;

  for (let i = 0; i < maxDepth; i += 1) {
    if (typeof current !== "string") break;
    const trimmed = current.trim();
    if (!trimmed) break;

    const parsed = tryParseJson(trimmed);
    if (parsed === current) break;
    current = parsed;
  }

  return current;
}

function appendUnique(target, seen, value) {
  const normalized = String(value || "").trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  target.push(normalized);
}

function extractTextParts(payload) {
  const seen = new Set();
  const parts = [];
  const decoded = decodePossiblyNestedJson(payload);
  const contentKeys = new Set(["content", "text", "answer", "message", "output", "result", "parts", "delta"]);

  const visit = (node, parentKey) => {
    const current = decodePossiblyNestedJson(node);

    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed) return;
      if (!parentKey || !contentKeys.has(parentKey)) return;
      appendUnique(parts, seen, trimmed);
      return;
    }

    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, parentKey));
      return;
    }

    if (!current || typeof current !== "object") return;

    const prioritizedEntries = [
      ["data", current.data],
      ["output", current.output],
      ["answer", current.answer],
      ["result", current.result],
      ["message", current.message],
      ["content", current.content],
      ["text", current.text],
      ["delta", current.delta],
    ];

    prioritizedEntries.forEach(([key, value]) => {
      if (value !== undefined) visit(value, key);
    });

    for (const [key, value] of Object.entries(current)) {
      if (["data", "output", "answer", "result", "message", "content", "text", "delta"].includes(key)) continue;
      visit(value, key);
    }
  };

  visit(decoded);
  return parts;
}

function isDeltaPayload(payload) {
  if (!payload || typeof payload !== "object") return false;

  if (payload.delta === true) return true;

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return choices.some((choice) => choice && typeof choice === "object" && choice.delta !== undefined);
}

function randomVisitorId() {
  return randomAlphaNumeric(32);
}

function createWebImTraceId() {
  return `fs-online-consult-web-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function getTraceIdFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return String(parsed.searchParams.get("traceId") || "").trim();
  } catch {
    return "";
  }
}

function pickHeader(headers, name) {
  const normalizedTarget = name.toLowerCase();
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === normalizedTarget);
  return match ? match[1] : "";
}

function normalizeHeaders(headers) {
  const result = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    result[key] = String(value);
  });
  return result;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SDR_UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = SDR_UPSTREAM_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();
  const data = text ? tryParseJson(text) : null;

  if (!response.ok) {
    const error = new Error(`请求失败: ${response.status} ${response.statusText}`);
    error.details = data;
    throw error;
  }

  return data;
}

function parseImChatRuntime(url) {
  const parsedUrl = new URL(url);
  const extraDataRaw = parsedUrl.searchParams.get("extraData") || "{}";
  const extraData = tryParseJson(extraDataRaw);
  const extraDataRecord = extraData && typeof extraData === "object" ? extraData : {};
  const serviceSessionParams = extraDataRecord.serviceSessionParams && typeof extraDataRecord.serviceSessionParams === "object"
    ? extraDataRecord.serviceSessionParams
    : {};

  return {
    webImId: parsedUrl.searchParams.get("webImId") || "",
    sourceType: String(extraDataRecord.sourceType || "DEFAULT"),
    outCookie: String(extraDataRecord.outCookie || ""),
    visitorId: String(serviceSessionParams.visitor_id || ""),
    randomDateNum: Number(extraDataRecord.randomDateNum || Date.now()),
    extraData: extraDataRecord,
  };
}

function buildImChatUrl(templateUrl, overrides) {
  const parsedUrl = new URL(templateUrl);
  const runtime = parseImChatRuntime(templateUrl);
  const extraData = {
    ...runtime.extraData,
    serviceSessionParams: {
      ...(runtime.extraData.serviceSessionParams || {}),
      visitor_id: overrides.visitorId,
    },
    randomDateNum: overrides.randomDateNum,
  };
  parsedUrl.searchParams.set("extraData", JSON.stringify(extraData));
  return parsedUrl.toString();
}

function buildWebImHeaders(state, extraHeaders = {}) {
  return normalizeHeaders({
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": pickHeader(state.baseHeaders, "accept-language") || "zh-CN",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": pickHeader(state.baseHeaders, "user-agent") || "Mozilla/5.0",
    Referer: state.imchatUrl,
    "Source-Type": state.sourceType,
    "Out-Cookie": state.outCookie,
    ...(pickHeader(state.baseHeaders, "cookie") ? { Cookie: pickHeader(state.baseHeaders, "cookie") } : {}),
    ...(state.fsToken ? { "fs-token": state.fsToken } : {}),
    ...(extraHeaders || {}),
  });
}

async function initializeWebImSession(options) {
  const existingSession = webImSessionStore.get(options.conversationKey);
  if (existingSession) return existingSession;

  const referer = pickHeader(options.headers, "referer");
  if (!referer || !/\/open\/imchat\//i.test(referer)) {
    throw new Error("官网客服模式缺少 Referer，无法初始化 WebIM 会话。");
  }

  const visitorId = randomVisitorId();
  const randomDateNum = Date.now();
  const imchatUrl = buildImChatUrl(referer, { visitorId, randomDateNum });
  const runtime = parseImChatRuntime(imchatUrl);

  if (!runtime.webImId) {
    throw new Error("官网客服模式缺少 webImId，无法初始化 WebIM 会话。");
  }

  const state = {
    key: options.conversationKey,
    url: options.url,
    webImId: runtime.webImId,
    imchatUrl,
    sourceType: runtime.sourceType,
    outCookie: runtime.outCookie,
    visitorId,
    fsToken: "",
    baseHeaders: { ...options.headers },
  };

  const generateUserUrl = `https://www.fxiaoke.com/online/consult/comm/auth/generateUser?traceId=${createWebImTraceId()}&webImId=${state.webImId}&customParams=&updateParams=&_=${Date.now()}`;
  const generateUserResponse = await fetchJson(generateUserUrl, {
    method: "GET",
    headers: buildWebImHeaders(state),
  }, options.timeoutMs);

  const fsToken = String(generateUserResponse?.data?.fsToken || "");
  if (!fsToken) {
    throw new Error("官网客服模式初始化失败：未拿到 fsToken。");
  }
  state.fsToken = fsToken;

  const initialMessagesUrl = `https://www.fxiaoke.com/online/consult/comm/chat/getMessages?traceId=${createWebImTraceId()}&webImId=${state.webImId}`;
  const initialMessagesResponse = await fetchJson(initialMessagesUrl, {
    method: "POST",
    headers: buildWebImHeaders(state, { "Content-Type": "application/json; charset=UTF-8" }),
    body: JSON.stringify({ untilMessageId: null, num: 20, fromMessageId: null }),
  }, options.timeoutMs);

  const initialMessages = Array.isArray(initialMessagesResponse?.data?.messages)
    ? initialMessagesResponse.data.messages
    : [];
  const lastMessage = initialMessages[0];
  state.lastMessageId = String(lastMessage?.messageId || "");
  state.lastVersion = state.lastMessageId;

  webImSessionStore.set(options.conversationKey, state);
  return state;
}

function extractWebImAssistantText(message) {
  const content = message?.content;
  if (typeof content !== "string") return "";

  if (message?.msgType === "artifact") {
    const parsed = decodePossiblyNestedJson(content);
    const artifacts = Array.isArray(parsed?.data?.artifacts)
      ? parsed.data.artifacts
      : Array.isArray(parsed?.artifacts)
        ? parsed.artifacts
        : [];

    const parts = artifacts
      .flatMap((artifact) => Array.isArray(artifact?.parts) ? artifact.parts : [])
      .map((part) => String(part?.content || "").trim())
      .filter(Boolean);

    if (parts.length > 0) {
      return Array.from(new Set(parts)).join("\n");
    }
  }

  return content.trim();
}

function extractWebImArtifactTextCandidates(payload) {
  const decoded = decodePossiblyNestedJson(payload);
  if (!decoded || typeof decoded !== "object") return [];

  const collectFromArtifacts = (artifacts) => artifacts
    .flatMap((artifact) => Array.isArray(artifact?.parts) ? artifact.parts : [])
    .map((part) => String(part?.content || "").trim())
    .filter(Boolean);

  const directArtifactParts = decoded.artifact && typeof decoded.artifact === "object"
    ? collectFromArtifacts([decoded.artifact])
    : [];
  const finishArtifactParts = Array.isArray(decoded.data?.artifacts)
    ? collectFromArtifacts(decoded.data.artifacts)
    : [];

  return Array.from(new Set([...directArtifactParts, ...finishArtifactParts]));
}

async function readStreamToSseEvents(response, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      await onEvent(rawEvent);
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    await onEvent(buffer);
  }
}

async function streamWebImArtifact(state, sendData, timeoutMs) {
  const preMsgId = String(sendData?.assistantConfig?.preMsgId || sendData?.assistantConfig?.preMessageId || "");
  const preMessageId = String(sendData?.assistantConfig?.preMessageId || preMsgId);
  const msgId = String(sendData?.msgId || "");

  if (!preMsgId || !preMessageId || !msgId) return "";

  const response = await fetchWithTimeout(
    `https://www.fxiaoke.com/online/consult/comm/chat/getSSEMessageArtifact?traceId=${createWebImTraceId()}&webImId=${state.webImId}`,
    {
      method: "POST",
      headers: buildWebImHeaders(state, {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        webImId: state.webImId,
        preMsgId,
        preMessageId,
        msgId,
      }),
    },
    timeoutMs,
  );

  const candidates = new Set();
  await readStreamToSseEvents(response, async (rawEvent) => {
    const dataLines = [];
    rawEvent.split("\n").forEach((line) => {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    });
    const payload = dataLines.join("\n").trim();
    if (!payload) return;

    extractWebImArtifactTextCandidates(payload).forEach((candidate) => candidates.add(candidate));
  });

  return Array.from(candidates).sort((a, b) => b.length - a.length)[0] || "";
}

async function fetchWebImMessages(state, timeoutMs) {
  const response = await fetchJson(
    `https://www.fxiaoke.com/online/consult/comm/chat/getMessages?traceId=${createWebImTraceId()}&webImId=${state.webImId}`,
    {
      method: "POST",
      headers: buildWebImHeaders(state, { "Content-Type": "application/json; charset=UTF-8" }),
      body: JSON.stringify({ untilMessageId: null, num: 20 }),
    },
    timeoutMs,
  );

  const messages = Array.isArray(response?.data?.messages) ? response.data.messages : [];
  if (messages.length > 0) {
    state.lastMessageId = String(messages[0]?.messageId || state.lastMessageId || "");
    state.lastVersion = String(messages[0]?.messageId || state.lastVersion || "");
  }
  return messages;
}

async function pollWebImReply(state, userMessageId, userCreateTime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let collectedTexts = [];
  let lastChangeAt = 0;
  let latestMessages = [];
  let sawUpdate = false;
  let lastObservedVersion = state.lastVersion || "";
  let lastCheckVersion = "";

  while (Date.now() < deadline) {
    const checkUpdateResponse = await fetchJson(
      `https://www.fxiaoke.com/online/consult/comm/chat/checkUpdate?webImId=${state.webImId}`,
      {
        method: "POST",
        headers: buildWebImHeaders(state, {
          Accept: "*/*",
          "Content-Type": "application/json; charset=UTF-8",
        }),
        body: JSON.stringify({
          version: state.lastVersion || "",
          direction: "out",
          webImId: state.webImId,
        }),
      },
      timeoutMs,
    );

    const updateData = checkUpdateResponse?.data || {};
    const hasUpdate = Boolean(updateData.needUpdateMessages);
    const newVersion = String(updateData.version || "");
    if (hasUpdate) sawUpdate = true;
    if (newVersion) lastCheckVersion = newVersion;

    if (hasUpdate || !latestMessages.length) {
      latestMessages = await fetchWebImMessages(state, timeoutMs);
      if (newVersion) {
        state.lastVersion = newVersion;
        lastObservedVersion = newVersion;
      }

      const candidateTexts = latestMessages
        .filter((message) => !message?.isUpMsg)
        .filter((message) => Number(message?.createTime || 0) >= userCreateTime)
        .filter((message) => String(message?.messageId || "") !== userMessageId)
        .map((message) => extractWebImAssistantText(message))
        .map((text) => text.trim())
        .filter(Boolean);

      const mergedTexts = Array.from(new Set(candidateTexts));
      if (mergedTexts.join("\n") !== collectedTexts.join("\n")) {
        collectedTexts = mergedTexts;
        lastChangeAt = Date.now();
      }
    }

    if (collectedTexts.length > 0 && lastChangeAt && Date.now() - lastChangeAt >= SDR_IDLE_FLUSH_MS) {
      return {
        text: collectedTexts.join("\n"),
        diagnostics: {
          mode: "website-webim",
          messageCount: latestMessages.length,
          sessionId: state.sessionId,
          webImId: state.webImId,
        },
      };
    }

    await delay(WEBIM_POLL_INTERVAL_MS);
  }

  return {
    text: collectedTexts.join("\n"),
    diagnostics: {
      mode: "website-webim",
      reason: collectedTexts.length > 0 ? "收到部分回复后超时" : "等待官网客服回复超时",
      sessionId: state.sessionId,
      webImId: state.webImId,
      sawUpdate,
      lastObservedVersion,
      lastCheckVersion,
    },
  };
}

export function shouldUseMinimalAgentStudioDebugBody(body) {
  if (!body || typeof body !== "object") return false;

  const variableNames = Array.isArray(body.variables)
    ? body.variables
      .map((variable) => String(variable?.name || "").trim())
      .filter(Boolean)
    : [];
  const hasRichChannelContext = variableNames.some((name) => (
    /^channel$/i.test(name) ||
    /^online_consult_/i.test(name) ||
    /^chat_group_messages$/i.test(name)
  ));

  return (
    String(body.businessName || "").trim().toLowerCase() === "debug" &&
    String(body.searchSource || "").trim() === "Fs" &&
    body.debug === true &&
    typeof body.apiName === "string" &&
    body.apiName.trim().length > 0 &&
    !hasRichChannelContext
  );
}

export function isWebsiteCustomerServiceMode(url, headers, body) {
  const referer = String(headers?.Referer || headers?.referer || "").trim();
  return (
    /\/online\/consult\/comm\/chat\/sendMessage/i.test(String(url || "")) ||
    (
      /\/open\/imchat\//i.test(referer) &&
      body &&
      typeof body === "object" &&
      (body.serviceSessionParams || body.msgType === "T" || typeof body.content === "string")
    )
  );
}

function buildAgentStudioDebugBody(templateBody, options) {
  const now = new Date();
  const currentDateTime = formatLocalDateTime(now);
  const currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

  const body = {
    businessName: typeof templateBody.businessName === "string" ? templateBody.businessName : "debug",
    apiName: templateBody.apiName,
    version: typeof templateBody.version === "number" ? templateBody.version : 2,
    variables: [
      { name: "AI.agent.currentDateTime", value: currentDateTime },
      { name: "AI.agent.currentZone", value: currentZone },
    ],
    searchSource: typeof templateBody.searchSource === "string" ? templateBody.searchSource : "Fs",
    debug: true,
    sessionId: options.sessionId,
    source: typeof templateBody.source === "string" ? templateBody.source : "send",
    content: [{ type: "text", text: options.userMessage }],
  };

  if (options.turnIndex === 0) {
    body.role = "user";
    body.messageId = generateUuidLike();
    body.createTime = Date.now();
    body._id = generateUuidLike();
  }

  return body;
}

export function prepareSdrRequest(parsedRequest, options) {
  const bodyTemplate = JSON.parse(JSON.stringify(parsedRequest.body || {}));
  const apiName = typeof bodyTemplate.apiName === "string" ? bodyTemplate.apiName : "";
  const useAgentStudioDebugMode = shouldUseMinimalAgentStudioDebugBody(bodyTemplate);
  const useWebsiteMode = isWebsiteCustomerServiceMode(parsedRequest.url, parsedRequest.headers, bodyTemplate);
  const hasConversationId = Boolean(
    !useAgentStudioDebugMode &&
    !useWebsiteMode && (
      bodyTemplate.conversationId !== undefined ||
      bodyTemplate.variables?.some?.((variable) => /conversationId/i.test(variable?.name || ""))
    ),
  );

  return {
    bodyTemplate,
    apiName,
    useAgentStudioDebugMode,
    useWebsiteMode,
    hasConversationId,
    sessionTemplateValue: bodyTemplate.sessionId,
    conversationTemplateValue: bodyTemplate.conversationId,
  };
}

export function buildTurnBody(requestState, options) {
  const body = JSON.parse(JSON.stringify(requestState.bodyTemplate || {}));

  if (requestState.useWebsiteMode) {
    body.content = options.userMessage;
    body.msgType = typeof body.msgType === "string" ? body.msgType : "T";
    if (!body.serviceSessionParams || typeof body.serviceSessionParams !== "object") {
      body.serviceSessionParams = {};
    }
    return body;
  }

  if (requestState.useAgentStudioDebugMode) {
    return buildAgentStudioDebugBody(body, {
      userMessage: options.userMessage,
      sessionId: options.sessionId,
      turnIndex: options.turnIndex,
    });
  }

  body.content = [{ type: "text", text: options.userMessage }];
  if (body.messageId !== undefined) body.messageId = generateUuidLike();
  if (body._id !== undefined) body._id = generateUuidLike();
  if (body.createTime !== undefined) body.createTime = Date.now();
  if (body.timestamp !== undefined) body.timestamp = Date.now();

  body.sessionId = options.sessionId;
  if (options.conversationId) {
    body.conversationId = options.conversationId;
  }

  if (Array.isArray(body.variables)) {
    const now = new Date();
    const currentDateTime = formatLocalDateTime(now);
    const currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

    body.variables.forEach((variable) => {
      if (!variable || typeof variable !== "object") return;

      if (variable.name === "chat_group_messages") {
        variable.value = JSON.stringify((options.conversation || []).map((message) => ({
          name: message.role === "user" ? "模拟客户" : "SDR",
          content: message.content,
          timestamp: message.timestamp || Date.now(),
        })));
      } else if (variable.name === "online_consult_sessionId") {
        variable.value = options.sessionId;
      } else if (/conversationId/i.test(variable.name || "")) {
        variable.value = options.conversationId || variable.value;
      } else if (variable.name === "AI.agent.currentDateTime") {
        variable.value = currentDateTime;
      } else if (variable.name === "AI.agent.currentZone") {
        variable.value = currentZone;
      }
    });
  }

  return body;
}

async function proxyWebsiteCustomerServiceMessage(options) {
  const timeoutMs = Number(options.timeoutMs || WEBSITE_WEBIM_TIMEOUT_MS);
  const state = await initializeWebImSession({
    url: options.url,
    headers: options.headers,
    conversationKey: options.conversationKey,
    timeoutMs,
  });

  const userText = typeof options.body?.content === "string"
    ? options.body.content
    : String(options.body?.content?.[0]?.text || "").trim();
  if (!userText) {
    throw new Error("官网客服模式缺少用户消息内容。");
  }

  const sendTraceId = createWebImTraceId();
  const sendUrl = `https://www.fxiaoke.com/online/consult/comm/chat/sendMessage?traceId=${sendTraceId}&webImId=${state.webImId}`;

  const sendResponse = await fetchJson(
    sendUrl,
    {
      method: "POST",
      headers: buildWebImHeaders(state, { "Content-Type": "application/json; charset=UTF-8" }),
      body: JSON.stringify({
        content: userText,
        msgType: "T",
        serviceSessionParams: { visitor_id: state.visitorId },
      }),
    },
    timeoutMs,
  );

  const sendData = sendResponse?.data || {};
  state.sessionId = String(sendData.sessionId || state.sessionId || "");

  const userCreateTime = Number(sendData.createTime || Date.now());
  const artifactText = await streamWebImArtifact(state, sendData, timeoutMs).catch(() => "");
  await delay(1200);
  const latestMessages = await fetchWebImMessages(state, timeoutMs);
  const messageTexts = latestMessages
    .filter((message) => !message?.isUpMsg)
    .filter((message) => Number(message?.createTime || 0) >= userCreateTime)
    .filter((message) => String(message?.messageId || "") !== String(sendData.messageId || ""))
    .map((message) => extractWebImAssistantText(message))
    .map((text) => text.trim())
    .filter(Boolean);
  const mergedTexts = Array.from(new Set([...messageTexts, ...(artifactText ? [artifactText] : [])]));

  if (mergedTexts.length > 0) {
    return {
      text: mergedTexts.join("\n"),
      diagnostics: {
        mode: "website-webim",
        requestUrl: sendUrl,
        traceId: sendTraceId,
        messageCount: latestMessages.length,
        sessionId: state.sessionId,
        webImId: state.webImId,
        sessionState: {
          conversationKey: state.key,
          sessionId: state.sessionId,
          visitorId: state.visitorId,
          webImId: state.webImId,
        },
      },
    };
  }

  const reply = await pollWebImReply(
    state,
    String(sendData.messageId || ""),
    userCreateTime,
    timeoutMs,
  );

  return {
    text: reply.text || "（代理：未提取到有效内容）",
    diagnostics: {
      ...(reply.diagnostics || {}),
      requestUrl: sendUrl,
      traceId: sendTraceId,
      sessionState: {
        conversationKey: state.key,
        sessionId: state.sessionId,
        visitorId: state.visitorId,
        webImId: state.webImId,
      },
    },
  };
}

async function proxyGenericSseMessage(options) {
  const timeoutMs = Number(options.timeoutMs || SDR_UPSTREAM_TIMEOUT_MS);
  const controller = new AbortController();
  const traceId = getTraceIdFromUrl(options.url);
  let idleAborted = false;
  let idleTimer = null;
  let finalized = false;

  const cleanup = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let fullText = "";
  let sawDeltaPayload = false;
  let eventCount = 0;
  let extractedEventCount = 0;
  let lastDataPreview = "";
  let lastParsedPayload = null;

  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: normalizeHeaders({
        ...options.headers,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }),
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`请求失败: ${response.status} ${response.statusText} ${errorText}`.trim());
    }

    const scheduleIdleFlush = () => {
      if (!fullText) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleAborted = true;
        controller.abort();
      }, SDR_IDLE_FLUSH_MS);
    };

    const processEvent = async (rawEvent) => {
      const dataLines = [];
      rawEvent.split("\n").forEach((line) => {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      });

      const dataStr = dataLines.join("\n").trim();
      if (!dataStr) return;

      eventCount += 1;
      lastDataPreview = dataStr.slice(0, 200);
      if (dataStr === "[DONE]") return;

      const parsedPayload = decodePossiblyNestedJson(dataStr);
      lastParsedPayload = parsedPayload;
      const textParts = extractTextParts(parsedPayload);
      const eventText = textParts.join("\n").trim();

      if (isDeltaPayload(parsedPayload)) {
        sawDeltaPayload = true;
      }

      if (!eventText) return;

      extractedEventCount += 1;
      if (sawDeltaPayload) {
        fullText += eventText;
      } else {
        fullText = eventText;
      }

      scheduleIdleFlush();
    };

    await readStreamToSseEvents(response, processEvent);
    finalized = true;

    return {
      text: fullText || "（代理：未提取到有效内容）",
      diagnostics: {
        reason: fullText ? "上游流结束" : `未从 SSE 中提取到文本，事件数=${eventCount}，命中文本事件数=${extractedEventCount}`,
        requestUrl: options.url,
        traceId,
        eventCount,
        extractedEventCount,
        contentType: response.headers.get("content-type") || "",
        lastDataPreview,
        lastParsedPayload,
      },
    };
  } catch (error) {
    if (controller.signal.aborted && idleAborted && fullText) {
      return {
        text: fullText,
        diagnostics: {
          reason: "收到有效回复后静默结束",
          requestUrl: options.url,
          traceId,
          eventCount,
          extractedEventCount,
          lastDataPreview,
          lastParsedPayload,
        },
      };
    }

    throw error;
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export async function proxySdrAgentRequest(options) {
  if (isWebsiteCustomerServiceMode(String(options.url || ""), options.headers || {}, options.body)) {
    return await proxyWebsiteCustomerServiceMessage(options);
  }
  return await proxyGenericSseMessage(options);
}
