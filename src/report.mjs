import path from "node:path";
import { ensureDir, formatLocalDateTime, slugify, writeTextFile } from "./utils.mjs";

function renderConversation(conversation) {
  return conversation
    .map((message, index) => `${index + 1}. [${formatLocalDateTime(message.timestamp)}] ${message.role === "user" ? "客户" : "SDR"}：${message.content}`)
    .join("\n");
}

function buildMarkdownReport(summary) {
  const lines = [];
  lines.push(`# ${summary.title}`);
  lines.push("");
  lines.push("## 概览");
  lines.push("");
  lines.push(`- 测试主题：${summary.topic || "-"}`);
  lines.push(`- 测试方向数：${summary.directionCount}`);
  lines.push(`- 每方向会话次数：${summary.loops}`);
  lines.push(`- 每会话轮数：${summary.turns}`);
  lines.push(`- 平均分：${summary.averageScore.toFixed(1)}`);
  lines.push(`- 最高分：${summary.maxScore}`);
  lines.push(`- 最低分：${summary.minScore}`);
  lines.push(`- 成功会话数：${summary.successSessionCount}`);
  lines.push(`- 失败方向数：${summary.failedDirectionCount}`);
  lines.push(`- 运行策略：${summary.stopOnError ? "出错即停" : "出错继续"}`);
  lines.push(`- 执行时间：${summary.startedAt} ~ ${summary.endedAt}`);
  lines.push("");
  lines.push("## 配置");
  lines.push("");
  lines.push(`- 模拟驱动：${summary.simulationDriverLabel}`);
  lines.push(`- 评分驱动：${summary.scoringDriverLabel}`);
  lines.push(`- 用户画像：${summary.userDescription || "-"}`);
  lines.push(`- 历史摘要：${summary.historySummary || "-"}`);
  lines.push("");
  if (summary.directionSummaries.length) {
    lines.push("## 方向汇总");
    lines.push("");
    summary.directionSummaries.forEach((direction) => {
      lines.push(`- ${direction.title}：平均分 ${direction.averageScore.toFixed(1)}，成功会话 ${direction.sessionCount}${direction.failed ? "，执行失败" : ""}`);
    });
    lines.push("");
  }

  if (summary.failedDirections.length) {
    lines.push("## 失败方向");
    lines.push("");
    summary.failedDirections.forEach((direction) => {
      lines.push(`- ${direction.title}：${direction.error}`);
    });
    lines.push("");
  }

  if (summary.findings.length) {
    lines.push("## 关键发现");
    lines.push("");
    summary.findings.forEach((finding) => {
      lines.push(`- ${finding}`);
    });
    lines.push("");
  }

  if (summary.turnRecords && summary.turnRecords.length) {
    lines.push("## 逐轮数据说明");
    lines.push("");
    lines.push("- 详细逐轮原始数据已同步写入 `turns.json` 和 `turns.csv`，适合后续筛选、导表和二次统计。");
    lines.push("");
  }

  lines.push("## 会话结果");
  lines.push("");

  summary.sessions.forEach((session) => {
    lines.push(`### ${session.directionTitle} · 会话 ${session.loopIndex}`);
    lines.push("");
    lines.push(`- 评分：${session.score}`);
    lines.push(`- 评分理由：${session.reason}`);
    lines.push(`- 平均响应耗时：${session.avgResponseTimeText}`);
    lines.push(`- 最大响应耗时：${session.maxResponseTimeText}`);
    lines.push("");
    if (session.turnDetails && session.turnDetails.length) {
      lines.push("#### 逐轮明细");
      lines.push("");
      session.turnDetails.forEach((turn) => {
        lines.push(`- 第 ${turn.turnIndex} 轮：用户时间 ${turn.userMessageAtText}；发起请求 ${turn.requestStartedAtText}；收到回复 ${turn.responseReceivedAtText}；耗时 ${turn.responseDurationText}${turn.traceId ? `；traceId ${turn.traceId}` : ""}`);
      });
      lines.push("");
    }
    lines.push("```text");
    lines.push(renderConversation(session.conversation));
    lines.push("```");
    lines.push("");
  });

  if (summary.logs.length) {
    lines.push("## 运行日志");
    lines.push("");
    lines.push("```text");
    lines.push(summary.logs.join("\n"));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildTurnsCsv(turnRecords) {
  const headers = [
    "directionId",
    "directionTitle",
    "directionTopic",
    "loopIndex",
    "score",
    "scoreReason",
    "turnIndex",
    "userMessageAtText",
    "requestStartedAtText",
    "responseReceivedAtText",
    "responseDurationMs",
    "responseDurationText",
    "traceId",
    "requestUrl",
    "sessionId",
    "conversationId",
    "userMessage",
    "sdrMessage",
  ];

  const lines = [
    headers.join(","),
    ...turnRecords.map((record) => headers.map((header) => csvEscape(record[header])).join(",")),
  ];

  return lines.join("\n");
}

export async function writeReports(config, summary) {
  const rootDir = path.resolve(config.reportDir || "./reports");
  const reportDir = path.join(rootDir, `${Date.now()}-${slugify(config.title)}`);
  await ensureDir(reportDir);

  const markdown = buildMarkdownReport(summary);
  const markdownPath = path.join(reportDir, "report.md");
  const jsonPath = path.join(reportDir, "report.json");
  const turnsJsonPath = path.join(reportDir, "turns.json");
  const turnsCsvPath = path.join(reportDir, "turns.csv");

  await writeTextFile(markdownPath, markdown);
  await writeTextFile(jsonPath, JSON.stringify(summary, null, 2));
  await writeTextFile(turnsJsonPath, JSON.stringify(summary.turnRecords || [], null, 2));
  await writeTextFile(turnsCsvPath, buildTurnsCsv(summary.turnRecords || []));

  return {
    reportDir,
    markdownPath,
    jsonPath,
    turnsJsonPath,
    turnsCsvPath,
  };
}
