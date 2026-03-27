import fs from "node:fs/promises";
import path from "node:path";

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatLocalDateTime(date = new Date()) {
  const normalizedDate = date instanceof Date ? date : new Date(date);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    normalizedDate.getFullYear(),
    pad(normalizedDate.getMonth() + 1),
    pad(normalizedDate.getDate()),
  ].join("-") + ` ${pad(normalizedDate.getHours())}:${pad(normalizedDate.getMinutes())}:${pad(normalizedDate.getSeconds())}`;
}

export function nowTimeString() {
  return new Date().toLocaleTimeString();
}

export function logWithTime(message) {
  const line = `[${nowTimeString()}] ${message}`;
  console.log(line);
  return line;
}

export function randomAlphaNumeric(length) {
  let value = "";
  while (value.length < length) {
    value += Math.random().toString(36).slice(2);
  }
  return value.slice(0, length);
}

export function generateUuidLike() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const part = () => Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${part()}${part()}-${part()}-${part()}-${part()}-${part()}${part()}${part()}`;
}

function buildSuffixLike(templateSuffix = "") {
  const normalized = String(templateSuffix || "").trim();
  if (!normalized) {
    return randomAlphaNumeric(10);
  }

  if (/^[a-z0-9]+$/i.test(normalized)) {
    return randomAlphaNumeric(normalized.length);
  }

  if (/^[0-9a-f-]+$/i.test(normalized) && normalized.includes("-")) {
    return generateUuidLike();
  }

  return randomAlphaNumeric(Math.max(normalized.length, 10));
}

export function buildStableConversationKey(kind, apiName = "", templateValue = "") {
  if (templateValue && typeof templateValue === "string") {
    const lastUnderscoreIndex = templateValue.lastIndexOf("_");
    if (lastUnderscoreIndex > 0) {
      const prefix = templateValue.slice(0, lastUnderscoreIndex + 1);
      const originalSuffix = templateValue.slice(lastUnderscoreIndex + 1);
      return `${prefix}${buildSuffixLike(originalSuffix)}`;
    }
    return buildSuffixLike(templateValue);
  }

  if (kind === "sessionId") {
    return `agent_debug_${randomAlphaNumeric(10)}`;
  }

  if (apiName) {
    return `${apiName}_${randomAlphaNumeric(10)}`;
  }

  return `${kind}_${randomAlphaNumeric(10)}`;
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "report";
}

export function extractJsonObject(text) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return null;

  try {
    return JSON.parse(normalizedText);
  } catch {}

  const codeFenceMatch = normalizedText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch) {
    try {
      return JSON.parse(codeFenceMatch[1].trim());
    } catch {}
  }

  const objectMatch = normalizedText.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;

  try {
    return JSON.parse(objectMatch[0]);
  } catch {
    return null;
  }
}

export function stripAnsi(text) {
  return String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]/g,
    "",
  );
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeTextFile(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}
