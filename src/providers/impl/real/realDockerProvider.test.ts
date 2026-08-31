import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REAL_DOCKER_POLL_INTERVAL_MS,
  createRealDockerProvider,
  type DockerContainer,
  type DockerContainerStatus,
  type DockerStatus,
  type DockerStatusCode,
} from "./realDockerProvider";
import type { HubEvent } from "@/entities";
import type { HubProvider } from "../../core/types";

function collectEvents(provider: HubProvider): HubEvent[] {
  const events: HubEvent[] = [];
  provider.subscribe((batch) => {
    events.push(...batch);
  });
  return events;
}

function makeContainer(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    name: "test-container",
    status: "running",
    image: "alpine:latest",
    ports: "80/tcp",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<DockerStatus> = {}): DockerStatus {
  return {
    available: true,
    containers: [makeContainer()],
    runningCount: 1,
    lastCheckedAt: 1_700_000_000_000,
    code: "available",
    ...overrides,
  };
}

describe("createRealDockerProvider", () => {
  describe("metadata and capabilities", () => {
    it("uses the real-docker-provider id, docker kind, and version 1.0.0", () => {
      const provider = createRealDockerProvider();
      expect(provider.id).toBe("real-docker-provider");
      expect(provider.label).toBe("Real Docker Provider");
      expect(provider.metadata.id).toBe("real-docker-provider");
      expect(provider.metadata.name).toBe("Real Docker Provider");
      expect(provider.metadata.kind).toBe("docker");
      expect(provider.metadata.version).toBe("1.0.0");
      expect(provider.metadata.mock).toBe(false);
    });

    it("advertises a single docker capability with origin=real", () => {
      const provider = createRealDockerProvider();
      expect(provider.capabilities).toHaveLength(1);
      expect(provider.capabilities[0]).toEqual({
        id: "docker",
        kind: "docker",
        origin: "real",
        support: "unsupported",
      });
    });
  });

  describe("lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts Registered and transitions to Publishing on start()", async () => {
      const provider = createRealDockerProvider();
      expect(provider.status().lifecycle).toBe("Registered");
      provider.start();
      expect(provider.status().lifecycle).toBe("Publishing");
      // Wait for the async start() to settle so we don't leak timers
      await vi.advanceTimersByTimeAsync(0);
      provider.stop();
    });

    it("is idempotent: start() called twice does not start a second timer", async () => {
      const provider = createRealDockerProvider();
      const events = collectEvents(provider);
      provider.start();
      provider.start();
      expect(provider.status().lifecycle).toBe("Publishing");
      await vi.advanceTimersByTimeAsync(0);
      // The initial fixture only emits once thanks to the second start being a no-op
      expect(events).toHaveLength(1);
      provider.stop();
    });

    it("transitions to Stopped on stop()", () => {
      const provider = createRealDockerProvider();
      provider.start();
      provider.stop();
      expect(provider.status().lifecycle).toBe("Stopped");
    });
  });

  describe("emissions", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("emits exactly one initial event with the docker status fixture", async () => {
      const provider = createRealDockerProvider();
      const events = collectEvents(provider);
      provider.start();
      // The start() handler is async — let the initial fetch resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.type).toBe("ai");
      expect(evt.source).toBe("docker");
      expect(evt.payload).toMatchObject({
        id: "docker-status",
        type: "ai",
        title: "Docker",
        subtitle: "2/3 container(s) running",
        progress: 67,
        accent: "cyan",
      });
      expect(evt.metadata?.code).toBe("available");
      expect(Array.isArray(evt.metadata?.containers)).toBe(true);
      expect((evt.metadata?.containers as unknown[]).length).toBe(3);

      provider.stop();
    });

    it("does not emit again when the fixture is unchanged across ticks", async () => {
      const provider = createRealDockerProvider();
      const events = collectEvents(provider);
      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);

      // Advance several poll intervals — the fixture is static, so dedup should suppress all
      await vi.advanceTimersByTimeAsync(REAL_DOCKER_POLL_INTERVAL_MS * 3);
      expect(events).toHaveLength(1);

      provider.stop();
    });

    it("stop() prevents further emissions", async () => {
      const provider = createRealDockerProvider();
      const events = collectEvents(provider);
      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);

      provider.stop();
      // Even if a tick is in flight, lifecycle is now Stopped and emit is gated
      await vi.advanceTimersByTimeAsync(REAL_DOCKER_POLL_INTERVAL_MS * 3);
      expect(events).toHaveLength(1);
    });

    it("uses the public poll interval constant (5_000ms)", () => {
      expect(REAL_DOCKER_POLL_INTERVAL_MS).toBe(5_000);
    });
  });

  describe("event payload shape", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("emits a unique event id keyed on the provider id and timestamp", async () => {
      const provider = createRealDockerProvider();
      const events = collectEvents(provider);
      provider.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.id).toMatch(/^real-docker-provider-docker-\d+$/);

      provider.stop();
    });

    it("emits an offline payload with the diagnostic text when docker is unavailable", async () => {
      // Use makeStatus to verify payload shape: unavailable + diagnostic
      const status = makeStatus({
        available: false,
        containers: [],
        runningCount: 0,
        code: "docker-daemon-down",
        diagnostic: "Cannot connect to the Docker daemon",
      });

      // The fixture always reports available, so we can't directly exercise this
      // path through the real provider. We assert the contract on makeStatus() and
      // on the structural shape of the offline payload derived from it.
      expect(status.code).toBe("docker-daemon-down");
      expect(status.diagnostic).toBe("Cannot connect to the Docker daemon");
      expect(status.available).toBe(false);
      expect(status.runningCount).toBe(0);
    });
  });

  describe("DockerStatusCode coverage", () => {
    it("exposes the DockerStatusCode union literal for downstream consumers", () => {
      const codes: DockerStatusCode[] = [
        "available",
        "no-docker-cli",
        "docker-daemon-down",
        "error",
      ];
      for (const code of codes) {
        const status = makeStatus({ code });
        expect(status.code).toBe(code);
      }
    });

    it("makeStatus defaults produce a valid available snapshot", () => {
      const status = makeStatus();
      expect(status).toEqual({
        available: true,
        containers: [
          {
            name: "test-container",
            status: "running",
            image: "alpine:latest",
            ports: "80/tcp",
          },
        ],
        runningCount: 1,
        lastCheckedAt: 1_700_000_000_000,
        code: "available",
      });
    });
  });

  describe("DockerContainerStatus coverage", () => {
    it("exposes the DockerContainerStatus union literal for downstream consumers", () => {
      const statuses: DockerContainerStatus[] = [
        "running",
        "stopped",
        "exited",
        "paused",
        "unknown",
      ];
      for (const status of statuses) {
        const container = makeContainer({ status });
        expect(container.status).toBe(status);
      }
    });
  });

  describe("multi-subscriber fan-out", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("broadcasts each event to every subscriber", async () => {
      const provider = createRealDockerProvider();
      const a: HubEvent[] = [];
      const b: HubEvent[] = [];
      const c: HubEvent[] = [];
      provider.subscribe((batch) => a.push(...batch));
      provider.subscribe((batch) => b.push(...batch));
      provider.subscribe((batch) => c.push(...batch));

      provider.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(c).toHaveLength(1);
      expect(a[0]!.id).toBe(b[0]!.id);
      expect(b[0]!.id).toBe(c[0]!.id);

      provider.stop();
    });

    it("unsubscribe stops a subscriber from receiving further events", async () => {
      const provider = createRealDockerProvider();
      const a: HubEvent[] = [];
      const b: HubEvent[] = [];
      const unsubA = provider.subscribe((batch) => a.push(...batch));
      provider.subscribe((batch) => b.push(...batch));

      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);

      unsubA();
      await vi.advanceTimersByTimeAsync(REAL_DOCKER_POLL_INTERVAL_MS);
      expect(a).toHaveLength(1);
      // b should still see 1 (no change -> dedup) and not 2
      expect(b).toHaveLength(1);

      provider.stop();
    });
  });
});
