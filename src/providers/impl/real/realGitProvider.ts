import type { HubEvent } from "@/entities";

import { createProviderShell } from "../../core/providerShell";
import type { HubProvider, HubProviderCapability, HubProviderMetadata } from "../../core/types";


const PROVIDER_ID = "real-git-provider";
const POLL_INTERVAL_MS = 5_000;

export type GitStatusCode = "available" | "no-repo" | "no-git-cli" | "error";

export type GitStatus = {
  available: boolean;
  modifiedCount: number;
  branch: string | null;
  lastCheckedAt: number;
  code: GitStatusCode;
  diagnostic?: string;
};

function gitStatusToEvent(status: GitStatus): HubEvent {
  const createdAt = status.lastCheckedAt;
  return {
    id: `${PROVIDER_ID}-git-${createdAt}`,
    type: "ai",
    source: "git",
    createdAt,
    expiresAt: createdAt + POLL_INTERVAL_MS + 500,
    payload: {
      id: "git-status",
      type: "ai",
      title: status.branch ? `Git: ${status.branch}` : "Git status",
      subtitle: status.available
        ? `${status.modifiedCount} file(s) modified`
        : (status.diagnostic ?? "unavailable"),
      progress: Math.min(100, status.modifiedCount * 10),
      accent: "pink",
    },
    metadata: {
      code: status.code,
    },
  };
}

/**
 * Stage 6 stub: returns a deterministic snapshot so the provider pipeline,
 * lifecycle, and dedup can be wired without depending on a working `git`
 * CLI or Tauri shell plugin. Once the shell bridge is available this
 * function should call `git status --porcelain --branch` and parse the
 * output (M/A/D/?/? columns + `## branch...` header) into a GitStatus.
 */
async function checkGitStatus(): Promise<GitStatus> {
  return {
    available: true,
    modifiedCount: 0,
    branch: "main",
    lastCheckedAt: Date.now(),
    code: "available",
  };
}

export function createRealGitProvider(): HubProvider {
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastEmitted: GitStatus | undefined;

  const metadata: HubProviderMetadata = {
    id: PROVIDER_ID,
    name: "Real Git Provider",
    kind: "git",
    version: "1.0.0",
    mock: false,
  };

  const capabilities: HubProviderCapability[] = [
    { id: "git", kind: "git", origin: "real", support: "unsupported" },
  ];

  return createProviderShell({
    metadata,
    capabilities,

    async start(handle) {
      const initial = await checkGitStatus().catch(() => undefined);
      if (initial) {
        lastEmitted = initial;
        handle.emit([gitStatusToEvent(initial)]);
      } else {
        handle.markDegraded();
      }

      pollTimer = setInterval(async () => {
        const next = await checkGitStatus().catch(() => undefined);
        if (!next) {
          handle.markDegraded();
          return;
        }

        if (
          lastEmitted &&
          lastEmitted.modifiedCount === next.modifiedCount &&
          lastEmitted.branch === next.branch
        ) {
          return;
        }
        lastEmitted = next;
        handle.emit([gitStatusToEvent(next)]);
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

export const REAL_GIT_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
