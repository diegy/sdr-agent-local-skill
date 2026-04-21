import fs from "node:fs/promises";
import path from "node:path";
import { buildTurnBody, prepareSdrRequest, proxySdrAgentRequest } from "../src/sdrProxy.mjs";
import { formatLocalDateTime, logWithTime } from "../src/utils.mjs";

const CONFIG_PATH = process.argv[2] || "tmp/v19-focused-regression.json";

const SCRIPTED_TURNS = {
  "marketing-intro-focus": [
    "营销通到底是什么？核心价值是什么？",
    "先只讲营销通，别泛泛讲 CRM。",
    "如果是制造业企业，一般能解决哪些营销获客和线索跟进问题？",
    "它和 CRM 大盘能力的区别是什么？先别扩展到 ERP 或其他集成。",
    "如果我现在只是先做线索管理，应该先看哪些点？",
  ],
  "price-standard-5turn": [
    "营销通怎么收费，是按人数、版本还是方案？",
    "我先不想留太多信息，只想先知道大概判断逻辑。",
    "我们是制造业，团队大概 20 到 30 人。",
    "那预算参考一般先看哪些因素？",
    "先别问太多资料，先回答就行。",
  ],
  "price-short-5turn": [
    "多少钱",
    "按人数？",
    "先不留资料",
    "20多个人",
    "那预算怎么估",
  ],
  "tech-integration-5turn": [
    "营销通能不能和 ERP 打通，一般怎么集成？",
    "常见集成方式、实施边界和前置条件有哪些？",
    "先不要问行业，先把技术能力说清楚。",
    "如果没有复杂定制，常见的对接路径是什么？",
    "评估集成可行性时，通常要先确认哪些系统信息？",
  ],
  "offtopic-standard-5turn": [
    "你们官网这版看着挺新，是最近改的吗？",
    "先回到正题，营销通更适合什么类型的企业？",
    "设计服务类团队适合用吗？",
    "如果我现在还不确定哪条产品线更合适，应该先怎么判断？",
    "能不能简单说下从什么问题切入最容易判断？",
  ],
};

async function loadConfig(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return {
    absolutePath,
    config: JSON.parse(raw),
  };
}

function normalizeDirections(config) {
  return (config.directions || []).map((item, index) => ({
    id: item.id || `direction-${index + 1}`,
    title: item.title || item.topic || `方向 ${index + 1}`,
    topic: item.topic || item.title || `方向 ${index + 1}`,
    userDescription: item.userDescription || config.userDescription || "",
    historySummary: item.historySummary || config.historySummary || "",
  }));
}

function buildSummaryMarkdown(runTitle, results) {
  const lines = [`# ${runTitle}`, ""];
  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push("");
    lines.push(`- 方向ID：${result.id}`);
    lines.push(`- 轮次：${result.turns.length}`);
    if (result.error) lines.push(`- 错误：${result.error}`);
    lines.push("");
    for (const turn of result.turns) {
      lines.push(`### 第 ${turn.turnIndex} 轮`);
      lines.push("");
      lines.push(`用户：${turn.userMessage}`);
      lines.push("");
      lines.push(`回复：${turn.assistantReply || "-"}`);
      if (turn.traceId) lines.push(`Trace：${turn.traceId}`);
      if (turn.welcomeText) lines.push(`欢迎语：${turn.welcomeText}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runDirection(config, requestState, direction, logs) {
  const turns = SCRIPTED_TURNS[direction.id];
  if (!Array.isArray(turns) || !turns.length) {
    throw new Error(`方向 ${direction.id} 缺少脚本化用户话术`);
  }

  const conversation = [];
  const conversationKey = `scripted:${direction.id}:${Date.now()}`;
  const sessionId = `scripted_${direction.id}_${Date.now()}`;
  const turnResults = [];

  for (let index = 0; index < turns.length; index += 1) {
    const userMessage = turns[index];
    logs.push(logWithTime(`--- [${direction.title}] 第 ${index + 1} 轮脚本化对话 ---`));
    logs.push(logWithTime(`用户: ${userMessage}`));

    const body = buildTurnBody(requestState, {
      userMessage,
      sessionId,
      conversationId: "",
      conversation,
      turnIndex: index,
    });

    const reply = await proxySdrAgentRequest({
      url: config.request.url,
      headers: config.request.headers || {},
      body,
      conversationKey,
      timeoutMs: Number(config.requestTimeoutMs || 60000),
    });

    const assistantReply = String(reply?.text || "").trim();
    conversation.push({
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    });
    conversation.push({
      role: "assistant",
      content: assistantReply,
      timestamp: Date.now(),
    });

    turnResults.push({
      turnIndex: index + 1,
      userMessage,
      assistantReply,
      traceId: reply?.diagnostics?.traceId || "",
      welcomeText: reply?.diagnostics?.welcomeText || "",
      diagnostics: reply?.diagnostics || {},
    });

    logs.push(logWithTime(`回复: ${assistantReply || "-"}`));
    if (reply?.diagnostics?.traceId) {
      logs.push(logWithTime(`traceId: ${reply.diagnostics.traceId}`));
    }
  }

  return turnResults;
}

async function main() {
  const { absolutePath, config } = await loadConfig(CONFIG_PATH);
  const requestState = prepareSdrRequest(
    {
      url: config.request.url,
      headers: { ...(config.request.headers || {}) },
      body: { ...(config.request.body || {}) },
    },
    config,
  );
  const directions = normalizeDirections(config);
  const logs = [
    logWithTime(`开始执行脚本化回归: ${config.title || "未命名任务"}`),
    logWithTime(`配置文件: ${absolutePath}`),
    logWithTime(`官网客服模式: ${requestState.useWebsiteMode ? "是" : "否"}`),
  ];
  const results = [];

  for (const direction of directions) {
    logs.push(logWithTime(`==== 开始方向: ${direction.title} ====`));
    try {
      const turns = await runDirection(config, requestState, direction, logs);
      results.push({
        id: direction.id,
        title: direction.title,
        topic: direction.topic,
        turns,
      });
    } catch (error) {
      results.push({
        id: direction.id,
        title: direction.title,
        topic: direction.topic,
        error: error?.message || String(error),
        turns: [],
      });
      logs.push(logWithTime(`方向失败: ${direction.title} -> ${error?.message || error}`));
    }
  }

  const timestamp = formatLocalDateTime(new Date()).replace(/[^\d]/g, "").slice(0, 14);
  const reportDir = path.join(process.cwd(), "reports", `scripted-regression-${timestamp}`);
  await fs.mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, "results.json");
  const mdPath = path.join(reportDir, "report.md");
  const logPath = path.join(reportDir, "run.log");

  await fs.writeFile(jsonPath, JSON.stringify({ title: config.title, results }, null, 2));
  await fs.writeFile(mdPath, buildSummaryMarkdown(config.title || "脚本化回归", results));
  await fs.writeFile(logPath, `${logs.join("\n")}\n`);

  console.log(
    JSON.stringify(
      {
        reportDir,
        jsonPath,
        mdPath,
        logPath,
        results: results.map((item) => ({
          id: item.id,
          title: item.title,
          error: item.error || "",
          turnCount: item.turns.length,
          traceIds: item.turns.map((turn) => turn.traceId).filter(Boolean),
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("RUN_SCRIPTED_REGRESSION_FAILED", error);
  process.exit(1);
});
