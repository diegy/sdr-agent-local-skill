import fs from "node:fs/promises";
import path from "node:path";

function stripCodeFences(text) {
  return String(text || "").replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
}

function splitSections(raw) {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = { title: "__root__", lines: [] };

  lines.forEach((line) => {
    const headingMatch = line.match(/^\s{0,3}(?:#+\s*|)(目标|测试参数|用户画像|历史背景|测试方向|目标请求\s*curl|请求\s*curl|curl|模型驱动|驱动)\s*[:：]?\s*$/i);
    if (headingMatch) {
      sections.push(current);
      current = { title: headingMatch[1], lines: [] };
      return;
    }
    current.lines.push(line);
  });

  sections.push(current);
  return sections;
}

function normalizeTitle(title) {
  return String(title || "").replace(/\s+/g, "").toLowerCase();
}

function sectionText(sections, names) {
  const normalizedNames = names.map((item) => normalizeTitle(item));
  const found = sections.find((section) => normalizedNames.includes(normalizeTitle(section.title)));
  return found ? found.lines.join("\n").trim() : "";
}

function extractBullets(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function extractFirstInteger(text, patterns, fallback) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return fallback;
}

function extractCurl(text) {
  const match = String(text || "").match(/curl[\s\S]*$/i);
  return match ? stripCodeFences(match[0]) : "";
}

function inferDriverPreset(text) {
  const normalized = String(text || "").toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("openclaw") || normalized.includes("龙虾")) return "openclaw";
  return "";
}

export async function loadBriefConfig(briefPath) {
  const absolutePath = path.resolve(process.cwd(), briefPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const sections = splitSections(raw);

  const rootText = sectionText(sections, ["__root__"]);
  const goalText = sectionText(sections, ["目标"]);
  const paramsText = sectionText(sections, ["测试参数"]);
  const personaText = sectionText(sections, ["用户画像"]);
  const historyText = sectionText(sections, ["历史背景"]);
  const directionsText = sectionText(sections, ["测试方向"]);
  const curlText = sectionText(sections, ["目标请求curl", "请求curl", "curl"]);
  const driverText = sectionText(sections, ["模型驱动", "驱动"]);

  const directions = extractBullets(directionsText);
  const titleLine = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !/^目标[:：]?$/i.test(line)) || "";

  const title = titleLine || "自然语言 SDR 测试任务";
  const topic = directions[0] || extractBullets(goalText)[0] || title;
  const loops = extractFirstInteger(paramsText, [
    /每个方向跑\s*(\d+)\s*个独立会话/i,
    /每个方向\s*(\d+)\s*个会话/i,
    /会话次数\s*[:：]?\s*(\d+)/i,
    /跑\s*(\d+)\s*次/i,
  ], 1);
  const turns = extractFirstInteger(paramsText, [
    /每个会话连续对话\s*(\d+)\s*轮/i,
    /每个会话\s*(\d+)\s*轮/i,
    /轮次\s*[:：]?\s*(\d+)/i,
    /聊\s*(\d+)\s*轮/i,
  ], 3);
  const stopOnError = /中断|不要空跑|失败就停|出错就停/i.test(paramsText || rootText || goalText)
    ? true
    : !/出错继续|失败继续/i.test(paramsText || "");
  const driverPreset = inferDriverPreset(driverText || rootText || goalText);
  const curl = extractCurl(curlText || raw);

  const config = {
    title,
    topic,
    directions: directions.length ? directions : [topic],
    loops,
    turns,
    userDescription: stripCodeFences(personaText),
    historySummary: stripCodeFences(historyText),
    curl,
    stopOnError,
    stepRetryCount: 2,
    requestTimeoutMs: 75000,
    reportDir: "./reports",
    _briefPath: absolutePath,
  };

  if (driverPreset) {
    config.driver = {
      preset: driverPreset,
      timeoutMs: 180000,
    };
  }

  return config;
}
