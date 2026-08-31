import type { HubEvent } from "@/entities";

import { createProviderShell } from "../../core/providerShell";
import type { HubProvider, HubProviderCapability, HubProviderMetadata } from "../../core/types";


const PROVIDER_ID = "real-docker-provider";
const POLL_INTERVAL_MS = 5_000;

export type DockerContainerStatus = "running" | "stopped" | "exited" | "paused" | "unknown";

export type DockerContainer = {
  name: string;
  status: DockerContainerStatus;
  image: string;
  ports: string;
};

export type DockerStatusCode =
  | "available"
  | "no-docker-cli"
  | "docker-daemon-down"
  | "error";

export type DockerStatus = {
  available: boolean;
  containers: DockerContainer[];
  runningCount: number;
  lastCheckedAt: number;
  code: DockerStatusCode;
  diagnostic?: string;
};

function dockerStatusToEvent(status: DockerStatus): HubEvent {
  const createdAt = status.lastCheckedAt;

  // Build subtitle summarizing container states
  const total = status.containers.length;
  const running = status.runningCount;
  const subtitle = status.available
    ? `${running}/${total} container(s) running`
    : (status.diagnostic ?? "Docker unavailable");

  return {
    id: `${PROVIDER_ID}-docker-${createdAt}`,
    type: "ai",
    source: "docker",
    createdAt,
    expiresAt: createdAt + POLL_INTERVAL_MS + 500,
    payload: {
      id: "docker-status",
      type: "ai",
      title: status.available ? "Docker" : "Docker (offline)",
      subtitle,
      // progress shows the fraction of running containers (0-100)
      progress: total > 0 ? Math.round((running / total) * 100) : 0,
      accent: "cyan",
    },
    metadata: {
      code: status.code,
      containers: status.containers,
    },
  };
}

/**
 * Stage 6 stub: returns a deterministic snapshot so the provider pipeline,
 * lifecycle, and dedup can be wired without depending on a working `docker`
 * CLI or Tauri shell plugin. Once the shell bridge is available this
 * function should call `docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"`
 * and parse the output into a DockerStatus.
 */
async function checkDockerStatus(): Promise<DockerStatus> {
  const now = Date.now();
  return {
    available: true,
    containers: [
      { name: "postgres", status: "running", image: "postgres:15", ports: "5432/tcp" },
      { name: "redis", status: "running", image: "redis:7", ports: "6379/tcp" },
      { name: "nginx", status: "stopped", image: "nginx:alpine", ports: "80/tcp" },
    ],
    runningCount: 2,
    lastCheckedAt: now,
    code: "available",
  };
}

export function createRealDockerProvider(): HubProvider {
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastEmittedRunningCount: number | undefined;
  let lastEmittedTotalCount: number | undefined;

  const metadata: HubProviderMetadata = {
    id: PROVIDER_ID,
    name: "Real Docker Provider",
    kind: "docker",
    version: "1.0.0",
    mock: false,
  };

  const capabilities: HubProviderCapability[] = [
    { id: "docker", kind: "docker", origin: "real", support: "unsupported" },
  ];

  return createProviderShell({
    metadata,
    capabilities,

    async start(handle) {
      const initial = await checkDockerStatus().catch(() => undefined);
      if (initial) {
        lastEmittedRunningCount = initial.runningCount;
        lastEmittedTotalCount = initial.containers.length;
        handle.emit([dockerStatusToEvent(initial)]);
      } else {
        handle.markDegraded();
      }

      pollTimer = setInterval(async () => {
        const next = await checkDockerStatus().catch(() => undefined);
        if (!next) {
          handle.markDegraded();
          return;
        }

        // Skip identical emissions (no state change)
        if (
          lastEmittedRunningCount === next.runningCount &&
          lastEmittedTotalCount === next.containers.length
        ) {
          return;
        }
        lastEmittedRunningCount = next.runningCount;
        lastEmittedTotalCount = next.containers.length;
        handle.emit([dockerStatusToEvent(next)]);
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

export const REAL_DOCKER_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
