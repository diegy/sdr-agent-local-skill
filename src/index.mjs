import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadBriefConfig } from "./brief.mjs";
import { parseCurl } from "./curl.mjs";
import { invokeDriver } from "./driver.mjs";
import { DEFAULT_SCORING_INSTRUCTION, DEFAULT_SIMULATOR_INSTRUCTION, buildScoringPrompt, buildSimulatorPrompt } from "./prompts.mjs";
import { buildTurnBody, prepareSdrRequest, proxySdrAgentRequest } from "./sdrProxy.mjs";
import { writeReports } from "./report.mjs";
import { buildStableConversationKey, delay, extractJsonObject, formatLocalDateTime, formatSeconds, logWithTime } from "./utils.mjs";

function readArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function printHelp() {
  console.log("用法:");
  console.log("  node src/index.mjs --config examples/task.example.json");
  console.log("  node src/index.mjs --brief examples/task-brief.example.md");
  console.log("  npm run run -- --config examples/task.example.json");
}

function normalizeDirections(config) {
  const source = Array.isArray(config.directions) && config.directions.length
    ? config.directions
    : [config.topic || config.title || "默认测试方向"];

  return source.map((item, index) => {
    if (typeof item === "string") {
      return {
        id: `direction-${index + 1}`,
        title: item,
        topic: item,
        userDescription: config.userDescription || "",
        historySummary: config.historySummary || "",
        initialConversation: Array.isArray(config.initialConversation)
          ? JSON.parse(JSON.stringify(config.initialConversation))
          : [],
      };
    }

    return {
      id: item.id || `direction-${index + 1}`,
      title: item.title || item.topic || `方向 ${index + 1}`,
      topic: item.topic || item.title || config.topic || `方向 ${index + 1}`,
      userDescription: item.userDescription || config.userDescription || "",
      historySummary: item.historySummary || config.historySummary || "",
      initialConversation: Array.isArray(item.initialConversation)
        ? JSON.parse(JSON.stringify(item.initialConversation))
        : Array.isArray(config.initialConversation)
          ? JSON.parse(JSON.stringify(config.initialConversation))
          : [],
    };
  });
}

async function loadConfig(configPath) {
  if (!configPath) {
    throw new Error("请通过 --config 指定配置文件。");
  }

  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const config = JSON.parse(raw);
  config.__configPath = absolutePath;
  return config;
}

function mergeCliOverrides(config) {
  const driverPreset = readArgValue("--driver-preset");
  if (driverPreset) {
    config.driver = {
      ...(config.driver || {}),
      preset: driverPreset,
      timeoutMs: Number(config.driver?.timeoutMs || 180000),
    };
  }
  return config;
}

function hasCommand(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}

function ensureDriver(config, logs) {
  if (config.driver || config.simulationDriver || config.scoringDriver) {
    return config;
  }

  const candidates = ["codex", "claude", "openclaw"];
  const detected = candidates.find((item) => hasCommand(item));
  if (!detected) {
    throw new Error("未发现可用的本地 AI 驱动。请在配置里指定 driver，或安装 codex / claude / openclaw。");
  }

  config.driver = {
    preset: detected,
    timeoutMs: 180000,
  };
  logs.push(logWithTime(`未显式指定驱动，已自动选择本机可用驱动: ${detected}`));
  return config;
}

function buildParsedRequest(config) {
  if (config.curl) {
    return parseCurl(config.curl);
  }

  if (config.request && config.request.url) {
    return {
      url: String(config.request.url),
      headers: { ...(config.request.headers || {}) },
      body: { ...(config.request.body || {}) },
    };
  }

  throw new Error("配置里缺少 curl 或 request.url。");
}

function getDriver(config, purpose) {
  const scoped = purpose === "simulation" ? config.simulationDriver : config.scoringDriver;
  const driver = scoped || config.driver;
  if (!driver) {
    throw new Error(`缺少 ${purpose === "simulation" ? "模拟客户" : "评分"} 模型驱动配置。`);
  }
  return driver;
}

async function withRetries(label, retryCount, logs, action) {
  let lastError;
  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    try {
      if (attempt > 1) {
        logs.push(logWithTime(`${label} 第 ${attempt - 1} 次重试...`));
      }
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt <= retryCount) {
        logs.push(logWithTime(`${label} 失败：${error.message || error}，准备重试...`));
        await delay(500 * attempt);
        continue;
      }
    }
  }
  throw lastError;
}

async function invokePurpose(config, purpose, systemPrompt, userPrompt, logs, driverUsageSet) {
  const driver = getDriver(config, purpose);
  const prompt = [
    systemPrompt,
    "",
    "用户请求：",
    userPrompt,
    "",
    purpose === "scoring"
      ? "请只输出 JSON，格式为 {\"score\": 0-100 的整数, \"reason\": \"评分理由\"}。"
      : "请只输出一句自然对话内容，不要输出解释、标签或额外说明。",
  ].join("\n");

  const text = await invokeDriver(driver, prompt);
  const driverLabel = driver.label || driver.preset || driver.command || driver.shellCommand || "unknown-driver";
  const usageKey = `${purpose}:${driverLabel}`;
  if (!driverUsageSet.has(usageKey)) {
    driverUsageSet.add(usageKey);
    logs.push(logWithTime(`${purpose === "simulation" ? "模拟客户" : "评分"}驱动: ${driverLabel}`));
  }

  return {
    text: String(text || "").trim(),
    driverLabel,
  };
}

async function run() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const runStartedAt = Date.now();
  const configPath = readArgValue("--config");
  const briefPath = readArgValue("--brief");
  const config = mergeCliOverrides(
    briefPath ? await loadBriefConfig(briefPath) : await loadConfig(configPath),
  );
  const logs = [];
  ensureDriver(config, logs);
  const parsedRequest = buildParsedRequest(config);
  const requestState = prepareSdrRequest(parsedRequest, config);
  const retryCount = Number(config.stepRetryCount ?? 2);
  const requestTimeoutMs = Number(config.requestTimeoutMs ?? 75000);
  const loops = Math.max(1, Number(config.loops || 1));
  const turns = Math.max(1, Number(config.turns || 1));
  const stopOnError = config.stopOnError !== false;
  const directions = normalizeDirections(config);
  const results = [];
  const failedDirections = [];
  const driverUsageSet = new Set();

  logs.push(logWithTime(`开始执行任务: ${config.title || "未命名测试"}`));
  logs.push(logWithTime(`计划执行 ${directions.length} 个测试方向，每个方向 ${loops} 个会话，每个会话 ${turns} 轮自然对话。`));
  logs.push(logWithTime(`执行策略: ${stopOnError ? "任一关键步骤失败后立即中断" : "遇错继续后续方向"}`));
  if (config._briefPath) {
    logs.push(logWithTime(`已从自然语言任务说明生成执行配置: ${config._briefPath}`));
  }

  for (const direction of directions) {
    logs.push(logWithTime(`==== 开始测试方向: ${direction.title} ====`));

    try {
      for (let loopIndex = 0; loopIndex < loops; loopIndex += 1) {
        const conversation = Array.isArray(direction.initialConversation)
          ? JSON.parse(JSON.stringify(direction.initialConversation))
          : [];
        const responseTimes = [];
        const turnDetails = [];
        const loopStartedAt = Date.now();
        const loopSessionId = buildStableConversationKey("sessionId", requestState.apiName, requestState.sessionTemplateValue);
        const loopConversationId = requestState.hasConversationId
          ? buildStableConversationKey("conversationId", requestState.apiName, requestState.conversationTemplateValue)
          : undefined;
        const conversationKey = `${config.title || "task"}:${direction.id}:${loopIndex + 1}:${loopSessionId}`;

        logs.push(logWithTime(`>>> [${direction.title}] 开始第 ${loopIndex + 1} 个会话...`));
        logs.push(logWithTime(`生成本轮会话ID: ${loopSessionId}`));
        if (requestState.useWebsiteMode) {
          logs.push(logWithTime("已启用官网客服模式：系统会自动初始化 WebIM 会话，并在同一会话中连续完成多轮对话。"));
          logs.push(logWithTime(
            requestState.preserveWebsiteCookies
              ? "官网客服模式：已按配置透传原始 Cookie，可能复用旧网页会话。"
              : "官网客服模式：默认不透传原始 Cookie，尽量避免复用旧网页会话。",
          ));
        }
        if (loopConversationId) {
          logs.push(logWithTime(`生成本轮对话ID: ${loopConversationId}`));
        }

        for (let turnIndex = 0; turnIndex < turns; turnIndex += 1) {
          logs.push(logWithTime(`--- [${direction.title}] 第 ${turnIndex + 1} 轮对话 ---`));
          logs.push(logWithTime("正在生成模拟用户回复..."));

          const simulatorResult = await withRetries("模拟客户生成", retryCount, logs, async () => {
            return await invokePurpose(
              config,
              "simulation",
              config.simulatorInstruction || DEFAULT_SIMULATOR_INSTRUCTION,
              buildSimulatorPrompt(config, direction, conversation),
              logs,
              driverUsageSet,
            );
          });

          const userMessage = simulatorResult.text || "你好";
          const userMessageAt = Date.now();
          logs.push(logWithTime(`模拟用户: ${userMessage}`));
          conversation.push({ role: "user", content: userMessage, timestamp: userMessageAt });

          const body = buildTurnBody(requestState, {
            userMessage,
            turnIndex,
            conversation,
            sessionId: loopSessionId,
            conversationId: loopConversationId,
          });

          logs.push(logWithTime(`正在请求 SDR Agent，请耐心等待（最长等待 ${Math.round(requestTimeoutMs / 1000)} 秒，收到回复会尽快继续）...`));
          const requestStartedAt = Date.now();

          const sdrResponse = await withRetries("SDR Agent 请求", retryCount, logs, async () => {
            return await proxySdrAgentRequest({
              url: parsedRequest.url,
              headers: parsedRequest.headers,
              body,
              conversationKey,
              timeoutMs: requestTimeoutMs,
              preserveCookies: requestState.preserveWebsiteCookies,
            });
          });

          const responseReceivedAt = Date.now();
          const duration = responseReceivedAt - requestStartedAt;
          responseTimes.push(duration);

          if (requestState.useWebsiteMode && sdrResponse?.diagnostics?.sessionState?.sessionId) {
            logs.push(logWithTime(`官网客服会话ID: ${sdrResponse.diagnostics.sessionState.sessionId}`));
          }
          if (requestState.useWebsiteMode && sdrResponse?.diagnostics?.welcomeText) {
            logs.push(logWithTime(`识别到客服欢迎语（未计入正式回复）: ${sdrResponse.diagnostics.welcomeText}`));
          }

          const sdrMessage = String(sdrResponse?.text || "").trim();
          if (!sdrMessage || sdrMessage === "（代理：未提取到有效内容）") {
            throw new Error(`Agent 没回复: ${String(sdrResponse?.diagnostics?.reason || "未返回有效文本")}`);
          }

          logs.push(logWithTime(`SDR Agent 响应耗时: ${formatSeconds(duration)}`));
          if (sdrResponse?.diagnostics?.traceId) {
            logs.push(logWithTime(`本轮请求 traceId: ${sdrResponse.diagnostics.traceId}`));
          }
          logs.push(logWithTime(`SDR Agent 回复: ${sdrMessage}`));
          conversation.push({ role: "assistant", content: sdrMessage, timestamp: responseReceivedAt });
          turnDetails.push({
            turnIndex: turnIndex + 1,
            userMessage,
            sdrMessage,
            userMessageAt,
            userMessageAtText: formatLocalDateTime(userMessageAt),
            requestStartedAt,
            requestStartedAtText: formatLocalDateTime(requestStartedAt),
            responseReceivedAt,
            responseReceivedAtText: formatLocalDateTime(responseReceivedAt),
            responseDurationMs: duration,
            responseDurationText: formatSeconds(duration),
            traceId: String(sdrResponse?.diagnostics?.traceId || ""),
            requestUrl: String(sdrResponse?.diagnostics?.requestUrl || parsedRequest.url || ""),
            sessionId: String(sdrResponse?.diagnostics?.sessionState?.sessionId || loopSessionId || ""),
            conversationId: String(loopConversationId || ""),
            welcomeText: String(sdrResponse?.diagnostics?.welcomeText || ""),
          });
        }

        logs.push(logWithTime("正在进行 AI 评分..."));
        const scoringResult = await withRetries("AI 评分", retryCount, logs, async () => {
          return await invokePurpose(
            config,
            "scoring",
            config.scoringInstruction || DEFAULT_SCORING_INSTRUCTION,
            buildScoringPrompt(config, direction, conversation),
            logs,
            driverUsageSet,
          );
        });

        const scoreData = extractJsonObject(scoringResult.text) || { score: 0, reason: "评分失败" };
        const result = {
          directionId: direction.id,
          directionTitle: direction.title,
          directionTopic: direction.topic,
          loopIndex: loopIndex + 1,
          title: config.title || "未命名测试",
          score: Number(scoreData.score || 0),
          reason: String(scoreData.reason || "评分失败"),
          conversation,
          turnDetails,
          realSessionId: turnDetails.find((turn) => String(turn.sessionId || "").trim())?.sessionId || "",
          avgResponseTimeMs: responseTimes.length
            ? responseTimes.reduce((sum, item) => sum + item, 0) / responseTimes.length
            : 0,
          maxResponseTimeMs: responseTimes.length ? Math.max(...responseTimes) : 0,
          avgResponseTimeText: responseTimes.length
            ? formatSeconds(responseTimes.reduce((sum, item) => sum + item, 0) / responseTimes.length)
            : "-",
          maxResponseTimeText: responseTimes.length ? formatSeconds(Math.max(...responseTimes)) : "-",
          startedAt: new Date(loopStartedAt).toISOString(),
          endedAt: new Date().toISOString(),
        };

        results.push(result);
        logs.push(logWithTime(`评分结果: ${result.score} 分`));
      }
    } catch (error) {
      logs.push(logWithTime(`方向执行异常: ${direction.title} | ${error.message || error}`));
      failedDirections.push({
        id: direction.id,
        title: direction.title,
        error: String(error.message || error),
      });
      if (stopOnError) {
        throw error;
      }
    }
  }

  const scores = results.map((item) => Number(item.score || 0));
  const directionSummaries = directions.map((direction) => {
    const sessions = results.filter((item) => item.directionId === direction.id);
    const directionScores = sessions.map((item) => Number(item.score || 0));
    const failedDirection = failedDirections.find((item) => item.id === direction.id);
    return {
      id: direction.id,
      title: direction.title,
      sessionCount: sessions.length,
       failed: Boolean(failedDirection),
      averageScore: directionScores.length
        ? directionScores.reduce((sum, item) => sum + item, 0) / directionScores.length
        : 0,
    };
  });

  const findings = [];
  directionSummaries.forEach((direction) => {
    if (direction.failed) {
      findings.push(`方向“${direction.title}”执行失败，建议优先排查目标链路或请求字段。`);
    } else if (direction.sessionCount > 0 && direction.averageScore < 60) {
      findings.push(`方向“${direction.title}”平均分偏低（${direction.averageScore.toFixed(1)}），说明 SDR 在该类问题上的稳定性较弱。`);
    }
  });
  directions.forEach((direction) => {
    const sessions = results.filter((item) => item.directionId === direction.id);
    const realSessionIds = Array.from(new Set(
      sessions
        .map((item) => String(item.realSessionId || "").trim())
        .filter(Boolean),
    ));
    if (sessions.length > 1 && realSessionIds.length === 1) {
      findings.push(`方向“${direction.title}”的多个 loop 复用了同一个真实会话ID（${realSessionIds[0]}），存在会话未隔离风险。`);
    }
  });
  if (!findings.length && results.length) {
    findings.push("本轮测试未发现明显结构性异常，建议继续扩大方向和样本量做验证。");
  }

  const turnRecords = results.flatMap((session) => (
    Array.isArray(session.turnDetails)
      ? session.turnDetails.map((turn) => ({
        directionId: session.directionId,
        directionTitle: session.directionTitle,
        directionTopic: session.directionTopic,
        loopIndex: session.loopIndex,
        score: session.score,
        scoreReason: session.reason,
        turnIndex: turn.turnIndex,
        userMessage: turn.userMessage,
        sdrMessage: turn.sdrMessage,
        userMessageAt: turn.userMessageAt,
        userMessageAtText: turn.userMessageAtText,
        requestStartedAt: turn.requestStartedAt,
        requestStartedAtText: turn.requestStartedAtText,
        responseReceivedAt: turn.responseReceivedAt,
        responseReceivedAtText: turn.responseReceivedAtText,
        responseDurationMs: turn.responseDurationMs,
        responseDurationText: turn.responseDurationText,
        traceId: turn.traceId,
        requestUrl: turn.requestUrl,
        sessionId: turn.sessionId,
        conversationId: turn.conversationId,
        welcomeText: turn.welcomeText,
      }))
      : []
  ));

  const summary = {
    title: config.title || "未命名测试",
    topic: config.topic || "",
    directionCount: directions.length,
    successSessionCount: results.length,
    failedDirectionCount: failedDirections.length,
    loops,
    turns,
    stopOnError,
    userDescription: config.userDescription || "",
    historySummary: config.historySummary || "",
    simulationDriverLabel: getDriver(config, "simulation").label || getDriver(config, "simulation").preset || getDriver(config, "simulation").command || getDriver(config, "simulation").shellCommand || "unknown-driver",
    scoringDriverLabel: getDriver(config, "scoring").label || getDriver(config, "scoring").preset || getDriver(config, "scoring").command || getDriver(config, "scoring").shellCommand || "unknown-driver",
    averageScore: scores.length ? scores.reduce((sum, item) => sum + item, 0) / scores.length : 0,
    maxScore: scores.length ? Math.max(...scores) : 0,
    minScore: scores.length ? Math.min(...scores) : 0,
    startedAt: formatLocalDateTime(new Date(runStartedAt)),
    endedAt: formatLocalDateTime(new Date()),
    configPath: config.__configPath,
    briefPath: config._briefPath || "",
    requestUrl: parsedRequest.url,
    directionSummaries,
    failedDirections,
    findings,
    turnRecords,
    sessions: results,
    logs,
  };

  logs.push(logWithTime("任务执行完成。"));
  const reportPaths = await writeReports(config, summary);
  console.log("");
  console.log(`Markdown 报告: ${reportPaths.markdownPath}`);
  console.log(`JSON 报告: ${reportPaths.jsonPath}`);
}

run().catch((error) => {
  console.error(`[${new Date().toLocaleTimeString()}] 任务执行异常: ${error.message || error}`);
  process.exitCode = 1;
});
