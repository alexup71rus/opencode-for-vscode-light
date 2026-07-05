import * as vscode from "vscode";
import { execSync } from "child_process";
import { homedir } from "os";
import { existsSync } from "fs";
import { join } from "path";

export interface ExtensionConfig {
  binaryPath: string;
  externalServerUrl: string;
  serverPassword: string;
  defaultModel: string;
  serverHostname: string;
}

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration("opencode");
  return {
    binaryPath: config.get<string>("binaryPath") ?? "",
    externalServerUrl: config.get<string>("externalServerUrl") ?? "",
    serverPassword: config.get<string>("serverPassword") ?? "",
    defaultModel: config.get<string>("defaultModel") ?? "",
    serverHostname: config.get<string>("serverHostname") ?? "127.0.0.1",
  };
}

export function getBinaryPath(config: ExtensionConfig): string {
  if (config.binaryPath && existsSync(config.binaryPath)) {
    return config.binaryPath;
  }

  for (const finder of ["which", "command -v"]) {
    try {
      const result = execSync(`${finder} opencode`, {
        encoding: "utf8",
        env: { ...process.env, SHELL: "/bin/zsh" },
      }).trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch {
      // not on PATH
    }
  }

  const candidates = [
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
    join(homedir(), ".opencode", "bin", "opencode"),
    join(homedir(), ".local", "share", "opencode", "bin", "opencode"),
    join(homedir(), ".local", "bin", "opencode"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}
