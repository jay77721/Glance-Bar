import type { HubEvent } from "@/entities";

import { createProviderShell } from "../../core/providerShell";
import type { HubProvider, HubProviderCapability, HubProviderMetadata } from "../../core/types";


const PROVIDER_ID = "real-npm-provider";
const POLL_INTERVAL_MS = 6_000;

export type NpmScriptStatus = "idle" | "running" | "success" | "failed";

export type NpmScript = {
  name: string;
  status: NpmScriptStatus;
  durationMs?: number;
  lastRunAt?: number;
};

export type NpmStatusCode = "available" | "no-package-json" | "error";

export type NpmStatus = {
  available: boolean;
  scripts: NpmScript[];
  runningCount: number;
  failedCount: number;
  lastCheckedAt: number;
  code: NpmStatusCode;
  diagnostic?: string;
};

function npmStatusToEvent(status: NpmStatus): HubEvent {
  const createdAt = status.lastCheckedAt;
  const total = status.scripts.length;
  const running = status.runningCount;
  const failed = status.failedCount;

  // Subtitle: e.g. "2 running, 1 failed" or "all idle"
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push("all idle");
  const subtitle = parts.join(", ");

  return {
    id: `${PROVIDER_ID}-npm-${createdAt}`,
    type: "ai",
    source: "npm",
    createdAt,
    expiresAt: createdAt + POLL_INTERVAL_MS + 500,
    payload: {
      id: "npm-status",
      type: "ai",
      title: status.available ? "npm scripts" : "npm (no package.json)",
      subtitle: status.available ? subtitle : (status.diagnostic ?? "no scripts"),
      // progress reflects the fraction of non-failed scripts (0-100)
      progress: total > 0 ? Math.round(((total - failed) / total) * 100) : 0,
      accent: "pink",
    },
    metadata: {
      code: status.code,
      scripts: status.scripts,
    },
  };
}

/**
 * Stage 6 stub: returns a deterministic snapshot so the provider pipeline,
 * lifecycle, and dedup can be wired without depending on a working `npm`
 * CLI or Tauri shell plugin. Once the shell bridge is available this
 * function should read `package.json` and inspect running child processes
 * to derive script state.
 */
async function checkNpmStatus(): Promise<NpmStatus> {
  const now = Date.now();
  return {
    available: true,
    scripts: [
      { name: "build", status: "success", durationMs: 2_300, lastRunAt: now - 60_000 },
      { name: "test", status: "running", lastRunAt: now },
      { name: "lint", status: "success", durationMs: 800, lastRunAt: now - 90_000 },
      { name: "typecheck", status: "idle" },
    ],
    runningCount: 1,
    failedCount: 0,
    lastCheckedAt: now,
    code: "available",
  };
}

export function createRealNpmProvider(): HubProvider {
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastEmittedRunning: number | undefined;
  let lastEmittedFailed: number | undefined;

  const metadata: HubProviderMetadata = {
    id: PROVIDER_ID,
    name: "Real npm Provider",
    kind: "npm",
    version: "1.0.0",
    mock: false,
  };

  const capabilities: HubProviderCapability[] = [
    { id: "npm", kind: "npm", origin: "real", support: "unsupported" },
  ];

  return createProviderShell({
    metadata,
    capabilities,

    async start(handle) {
      const initial = await checkNpmStatus().catch(() => undefined);
      if (initial) {
        lastEmittedRunning = initial.runningCount;
        lastEmittedFailed = initial.failedCount;
        handle.emit([npmStatusToEvent(initial)]);
      } else {
        handle.markDegraded();
      }

      pollTimer = setInterval(async () => {
        const next = await checkNpmStatus().catch(() => undefined);
        if (!next) {
          handle.markDegraded();
          return;
        }

        // Skip identical emissions (no state change)
        if (
          lastEmittedRunning === next.runningCount &&
          lastEmittedFailed === next.failedCount
        ) {
          return;
        }
        lastEmittedRunning = next.runningCount;
        lastEmittedFailed = next.failedCount;
        handle.emit([npmStatusToEvent(next)]);
      }, POLL_INTERVAL_MS);
    },

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
  });
}

export const REAL_NPM_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
