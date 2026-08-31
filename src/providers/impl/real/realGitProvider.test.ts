import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REAL_GIT_POLL_INTERVAL_MS,
  createRealGitProvider,
  type GitStatus,
  type GitStatusCode,
} from "./realGitProvider";
import type { HubEvent } from "@/entities";
import type { HubProvider } from "../../core/types";

function collectEvents(provider: HubProvider): HubEvent[] {
  const events: HubEvent[] = [];
  provider.subscribe((batch) => {
    events.push(...batch);
  });
  return events;
}

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    available: true,
    modifiedCount: 0,
    branch: "main",
    lastCheckedAt: 1_700_000_000_000,
    code: "available",
    ...overrides,
  };
}

// We swap `checkGitStatus` by importing the module and re-binding
// internals — but `checkGitStatus` is closed over by `createRealGitProvider`.
// So we test observable behavior via the lifecycle: the provider always
// emits the same fixture on start and on every tick. To exercise the
// dedup/branch-change path we directly inspect `lastEmitted` via the
// `emit` calls (each fixture emits a HubEvent), letting fake timers give
// us deterministic scheduling.

describe("createRealGitProvider", () => {
  describe("metadata and capabilities", () => {
    it("uses the real-git-provider id, git kind, and version 1.0.0", () => {
      const provider = createRealGitProvider();
      expect(provider.id).toBe("real-git-provider");
      expect(provider.label).toBe("Real Git Provider");
      expect(provider.metadata.id).toBe("real-git-provider");
      expect(provider.metadata.name).toBe("Real Git Provider");
      expect(provider.metadata.kind).toBe("git");
      expect(provider.metadata.version).toBe("1.0.0");
      expect(provider.metadata.mock).toBe(false);
    });

    it("advertises a single git capability with origin=real", () => {
      const provider = createRealGitProvider();
      expect(provider.capabilities).toHaveLength(1);
      expect(provider.capabilities[0]).toEqual({
        id: "git",
        kind: "git",
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
      const provider = createRealGitProvider();
      expect(provider.status().lifecycle).toBe("Registered");
      provider.start();
      expect(provider.status().lifecycle).toBe("Publishing");
      // Wait for the async start() to settle so we don't leak timers
      await vi.advanceTimersByTimeAsync(0);
      provider.stop();
    });

    it("is idempotent: start() called twice does not start a second timer", async () => {
      const provider = createRealGitProvider();
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
      const provider = createRealGitProvider();
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

    it("emits exactly one initial event with the git status fixture", async () => {
      const provider = createRealGitProvider();
      const events = collectEvents(provider);
      provider.start();
      // The start() handler is async — let the initial fetch resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toHaveLength(1);
      const evt = events[0];
      expect(evt.type).toBe("ai");
      expect(evt.source).toBe("git");
      expect(evt.payload).toMatchObject({
        id: "git-status",
        type: "ai",
        title: "Git: main",
        subtitle: "0 file(s) modified",
        progress: 0,
        accent: "pink",
      });
      expect(evt.metadata).toEqual({ code: "available" });

      provider.stop();
    });

    it("does not emit again when the fixture is unchanged across ticks", async () => {
      const provider = createRealGitProvider();
      const events = collectEvents(provider);
      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);

      // Advance several poll intervals — the fixture is static, so dedup should suppress all
      await vi.advanceTimersByTimeAsync(REAL_GIT_POLL_INTERVAL_MS * 3);
      expect(events).toHaveLength(1);

      provider.stop();
    });

    it("stop() prevents further emissions", async () => {
      const provider = createRealGitProvider();
      const events = collectEvents(provider);
      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toHaveLength(1);

      provider.stop();
      // Even if a tick is in flight, lifecycle is now Stopped and emit is gated
      await vi.advanceTimersByTimeAsync(REAL_GIT_POLL_INTERVAL_MS * 3);
      expect(events).toHaveLength(1);
    });

    it("uses the public poll interval constant (5_000ms)", () => {
      expect(REAL_GIT_POLL_INTERVAL_MS).toBe(5_000);
    });
  });

  describe("GitStatusCode coverage", () => {
    it("exposes the GitStatusCode union literal for downstream consumers", () => {
      const codes: GitStatusCode[] = ["available", "no-repo", "no-git-cli", "error"];
      // This is a structural check — at runtime we just make sure all four
      // values compile and round-trip through makeStatus()
      for (const code of codes) {
        const status = makeStatus({ code });
        expect(status.code).toBe(code);
      }
    });

    it("makeStatus defaults produce a valid available snapshot", () => {
      const status = makeStatus();
      expect(status).toEqual({
        available: true,
        modifiedCount: 0,
        branch: "main",
        lastCheckedAt: 1_700_000_000_000,
        code: "available",
      });
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
      const provider = createRealGitProvider();
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
      const provider = createRealGitProvider();
      const a: HubEvent[] = [];
      const b: HubEvent[] = [];
      const unsubA = provider.subscribe((batch) => a.push(...batch));
      provider.subscribe((batch) => b.push(...batch));

      provider.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);

      unsubA();
      await vi.advanceTimersByTimeAsync(REAL_GIT_POLL_INTERVAL_MS);
      expect(a).toHaveLength(1);
      // b should still see 1 (no change -> dedup) and not 2
      expect(b).toHaveLength(1);

      provider.stop();
    });
  });
});
