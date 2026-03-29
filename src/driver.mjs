import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomAlphaNumeric, stripAnsi } from "./utils.mjs";

const commandHelpCache = new Map();

async function createTempOutputPath(prefix = "sdr-agent-local-skill", extension = ".txt") {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tempDir, `output-${randomAlphaNumeric(8)}${extension}`);
}

function readCommandHelp(command, args = ["--help"]) {
  const cacheKey = `${command}\u0000${args.join("\u0000")}`;
  if (commandHelpCache.has(cacheKey)) {
    return commandHelpCache.get(cacheKey);
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  const helpText = [result.stdout || "", result.stderr || ""].join("\n");
  commandHelpCache.set(cacheKey, helpText);
  return helpText;
}

function commandSupportsFlag(command, helpArgs, flag) {
  const helpText = readCommandHelp(command, helpArgs);
  return helpText.includes(flag);
}

async function resolveDriver(driver = {}) {
  if (!driver || typeof driver !== "object") {
    throw new Error("模型驱动配置无效。");
  }

  const preset = String(driver.preset || "").trim().toLowerCase();
  if (!preset) {
    return {
      ...driver,
      _resolvedLabel: driver.label || driver.command || driver.shellCommand || "custom-driver",
    };
  }

  if (preset === "codex") {
    const outputFile = await createTempOutputPath("sdr-codex");
    const command = driver.command || "codex";
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
    ];

    // Codex CLI flags have changed across versions. Only pass approval flags
    // when the local executable explicitly advertises support for them.
    if (commandSupportsFlag(command, ["exec", "--help"], "--ask-for-approval")) {
      args.push("--ask-for-approval", "never");
    }

    args.push(
      "--color",
      "never",
      "--output-last-message",
      outputFile,
      ...(driver.args || []),
    );

    return {
      ...driver,
      command,
      args,
      promptMode: "stdin",
      outputSource: "file",
      outputFile,
      timeoutMs: driver.timeoutMs || 180000,
      _resolvedLabel: driver.label || "codex",
    };
  }

  if (preset === "claude") {
    const command = driver.command || "claude";
    const args = [];

    if (commandSupportsFlag(command, ["--help"], "--print")) {
      args.push("--print");
    } else if (commandSupportsFlag(command, ["--help"], "-p")) {
      args.push("-p");
    }

    if (commandSupportsFlag(command, ["--help"], "--output-format")) {
      args.push("--output-format", "text");
    }

    if (commandSupportsFlag(command, ["--help"], "--no-session-persistence")) {
      args.push("--no-session-persistence");
    }

    args.push(...(driver.args || []));

    return {
      ...driver,
      command,
      args,
      promptMode: "stdin",
      outputSource: driver.outputSource || "stdout",
      timeoutMs: driver.timeoutMs || 180000,
      _resolvedLabel: driver.label || "claude",
    };
  }

  if (preset === "openclaw") {
    return {
      ...driver,
      _resolvedLabel: driver.label || driver.command || driver.shellCommand || "openclaw",
    };
  }

  throw new Error(`不支持的驱动 preset: ${driver.preset}`);
}

function buildSpawnSpec(driver, prompt) {
  if (driver.shellCommand) {
    if (process.platform === "win32") {
      return {
        command: process.env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", driver.shellCommand],
        options: {
          shell: false,
          cwd: driver.cwd || process.cwd(),
          env: {
            ...process.env,
            ...(driver.environment || {}),
            SDR_PROMPT: prompt,
          },
        },
        writeToStdin: false,
      };
    }

    const shell = process.env.SHELL || "/bin/sh";
    return {
      command: shell,
      args: ["-lc", driver.shellCommand],
      options: {
        shell: false,
        cwd: driver.cwd || process.cwd(),
        env: {
          ...process.env,
          ...(driver.environment || {}),
          SDR_PROMPT: prompt,
        },
      },
      writeToStdin: false,
    };
  }

  if (!driver.command) {
    throw new Error("模型驱动缺少 command 或 shellCommand。");
  }

  const args = [...(driver.args || [])];
  const promptMode = driver.promptMode || "stdin";
  if (promptMode === "arg") {
    if (driver.promptFlag) {
      args.push(driver.promptFlag);
    }
    args.push(prompt);
  }

  return {
    command: driver.command,
    args,
    options: {
      shell: false,
      cwd: driver.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(driver.environment || {}),
      },
    },
    writeToStdin: promptMode === "stdin",
  };
}

export async function invokeDriver(driver, prompt) {
  const resolvedDriver = await resolveDriver(driver);
  const spec = buildSpawnSpec(resolvedDriver, prompt);
  const timeoutMs = Number(resolvedDriver.timeoutMs || 120000);

  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, spec.options);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      const cleanedStdout = stripAnsi(stdout).trim();
      const cleanedStderr = stripAnsi(stderr).trim();

      if (timedOut) {
        reject(new Error(`${resolvedDriver._resolvedLabel || resolvedDriver.command || "模型驱动"} 执行超时（${timeoutMs}ms）`));
        return;
      }

      if (code !== 0) {
        reject(new Error(cleanedStderr || cleanedStdout || `${resolvedDriver._resolvedLabel || resolvedDriver.command} 执行失败，退出码 ${code}`));
        return;
      }

      const outputSource = resolvedDriver.outputSource || "stdout";
      if (outputSource === "file") {
        fs.readFile(resolvedDriver.outputFile, "utf8")
          .then((fileText) => resolve(stripAnsi(fileText).trim() || cleanedStdout || cleanedStderr))
          .catch((error) => reject(error));
        return;
      }

      if (outputSource === "combined") {
        resolve([cleanedStdout, cleanedStderr].filter(Boolean).join("\n").trim());
        return;
      }

      resolve(cleanedStdout || cleanedStderr);
    });

    if (spec.writeToStdin) {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}
