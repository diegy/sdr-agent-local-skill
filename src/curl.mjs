function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function sanitizeCurlUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const runtimeOnlyParams = [
      "body",
      "signal",
      "onopen",
      "onmessage",
      "onerror",
      "onclose",
      "headers",
    ];

    runtimeOnlyParams.forEach((key) => url.searchParams.delete(key));

    for (const [key, value] of [...url.searchParams.entries()]) {
      const normalizedValue = String(value || "").trim();
      if (
        normalizedValue === "[object Object]" ||
        normalizedValue === "[object AbortSignal]" ||
        normalizedValue.includes("=>") ||
        normalizedValue.includes("function(")
      ) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function extractCurlSegment(curlText, prefix) {
  let regex = new RegExp(`${prefix}\\s+'([\\s\\S]*?)'`, "i");
  let match = curlText.match(regex);
  if (match && match[1]) return match[1];

  regex = new RegExp(`${prefix}\\s+"([\\s\\S]*?)"`, "i");
  match = curlText.match(regex);
  if (match && match[1]) return match[1];

  return "";
}

export function parseCurl(curlText) {
  const urlMatch = curlText.match(/curl\s+'([^']+)'/i) || curlText.match(/curl\s+"([^"]+)"/i);
  if (!urlMatch) {
    throw new Error("未识别到 curl URL。");
  }

  const headers = {};
  let headerRegex = /-H\s+'([^:]+):\s*([\s\S]*?)'/gi;
  let headerMatch;
  while ((headerMatch = headerRegex.exec(curlText)) !== null) {
    headers[headerMatch[1]] = headerMatch[2];
  }

  if (Object.keys(headers).length === 0) {
    headerRegex = /-H\s+"([^:]+):\s*([\s\S]*?)"/gi;
    while ((headerMatch = headerRegex.exec(curlText)) !== null) {
      headers[headerMatch[1]] = headerMatch[2];
    }
  }

  const bodyText = extractCurlSegment(curlText, "--data-raw") || extractCurlSegment(curlText, "--data");
  const body = safeJsonParse(bodyText, {});

  return {
    url: sanitizeCurlUrl(urlMatch[1]),
    headers,
    body,
  };
}
