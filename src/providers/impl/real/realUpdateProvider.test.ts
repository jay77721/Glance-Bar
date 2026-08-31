import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REAL_UPDATE_PROGRESS_INCREMENT,
  REAL_UPDATE_TICK_INTERVAL_MS,
  createRealUpdateProvider,
  dispatchUpdateInstall,
  nextUpdateState,
  type UpdateProviderState,
} from "./realUpdateProvider";
import type { HubEvent } from "@/entities";
import type { HubProvider } from "../../core/types";
import type { TauriInvoke } from "../../../runtime/tauri/tauriRuntime";

const PROVIDER_ID = "real-update-provider";

function collectEvents(provider: HubProvider): HubEvent[] {
  const events: HubEvent[] = [];
  provider.subscribe((batch) => {
    events.push(...batch);
  });
  return events;
}

/**
 * Installs a fake `__TAURI__` global whose invoke answers every command
 * with `payload`. `installUpdate()` resolves the invoke at call time, so
 * the fake must be in place before `dispatchUpdateInstall` runs.
 */
function stubTauriInvoke(payload: unknown): void {
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: { invoke: async () => payload },
  };
}

describe("createRealUpdateProvider", () => {
  describe("metadata and capabilities", () => {
    it("uses the real-update-provider id and version 1.0.0", () => {
      const provider = createRealUpdateProvider();
      expect(provider.id).toBe(PROVIDER_ID);
      expect(provider.metadata.id).toBe(PROVIDER_ID);
      expect(provider.metadata.name).toBe("Real Update Provider");
      expect(provider.metadata.version).toBe("1.0.0");
      expect(provider.metadata.kind).toBe("ai");
      expect(provider.metadata.mock).toBe(false);
    });

    it("advertises a single update capability with origin=real", () => {
      const provider = createRealUpdateProvider();
      expect(provider.capabilities).toHaveLength(1);
      expect(provider.capabilities[0]).toEqual({
        id: "update",
        kind: "update",
        origin: "real",
        support: "unsupported",
      });
    });
  });

  describe("lifecycle", () => {
    it("starts Registered and transitions to Publishing on start()", () => {
      const provider = createRealUpdateProvider();
      expect(provider.status().lifecycle).toBe("Registered");
      expect(provider.status().health).toBe("Healthy");
      provider.start();
      expect(provider.status().lifecycle).toBe("Publishing");
    });

    it("is idempotent: start() called twice does not start a second timer", () => {
      vi.useFakeTimers();
      try {
        const provider = createRealUpdateProvider();
        const events = collectEvents(provider);
        provider.start();
        provider.start();
        expect(provider.status().lifecycle).toBe("Publishing");
        vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS * 3);
        // A second timer would double the emission cadence — 3 ticks must emit 3 events
        expect(events).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("transitions to Stopped on stop()", () => {
      const provider = createRealUpdateProvider();
      provider.start();
      provider.stop();
      expect(provider.status().lifecycle).toBe("Stopped");
    });
  });

  describe("state machine emissions", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("emits a checking event after the first tick", () => {
      const provider = createRealUpdateProvider();
      const events = collectEvents(provider);
      provider.start();

      vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS);

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("ai");
      expect(events[0]?.source).toBe("ai");
      expect(events[0]?.metadata?.state).toBe("checking");
      expect(events[0]?.metadata?.code).toBe("available");
      expect(events[0]?.payload).toMatchObject({
        id: "real-system-update",
        title: "System update",
        subtitle: "checking",
        accent: "blue",
      });
    });

    it("progresses checking -> downloading -> installing -> idle across ticks", () => {
      const provider = createRealUpdateProvider();
      const events = collectEvents(provider);
      provider.start();

      // 1: idle->checking, 1: checking->downloading, 10: downloading to 100, 1: installing->idle
      vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS * 13);

      expect(events.map((e) => e.metadata?.state)).toEqual([
        "checking",
        ...Array.from({ length: 10 }, () => "downloading"),
        "installing",
        "idle",
      ]);
    });

    it("increments progress by 10 per downloading tick and caps at 100", () => {
      const provider = createRealUpdateProvider();
      const events = collectEvents(provider);
      provider.start();

      vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS * 12);

      expect(events.map((e) => e.progress)).toEqual([0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    });

    it("resets progress to 0 when the cycle restarts", () => {
      const provider = createRealUpdateProvider();
      const events = collectEvents(provider);
      provider.start();

      vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS * 13);
      const idleEvent = events[12];
      expect(idleEvent?.metadata?.state).toBe("idle");
      expect(idleEvent?.progress).toBe(0);
    });

    it("stop() prevents further emissions", () => {
      const provider = createRealUpdateProvider();
      const events = collectEvents(provider);
      provider.start();
      vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS * 2);
      expect(events).toHaveLength(2);

      provider.stop();
      vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS * 5);
      expect(events).toHaveLength(2);
    });

    it("uses the public tick interval and progress increment constants", () => {
      expect(REAL_UPDATE_TICK_INTERVAL_MS).toBe(2_000);
      expect(REAL_UPDATE_PROGRESS_INCREMENT).toBe(10);
    });
  });
});

describe("nextUpdateState", () => {
  it("idle -> checking with progress reset", () => {
    expect(nextUpdateState({ state: "idle", progress: 40 })).toEqual({
      state: "checking",
      progress: 0,
    });
  });

  it("checking -> downloading with progress reset", () => {
    expect(nextUpdateState({ state: "checking", progress: 40 })).toEqual({
      state: "downloading",
      progress: 0,
    });
  });

  it("downloading increments progress by 10 and stays downloading below 100", () => {
    expect(nextUpdateState({ state: "downloading", progress: 30 })).toEqual({
      state: "downloading",
      progress: 40,
    });
  });

  it("downloading caps progress at 100 and switches to installing", () => {
    expect(nextUpdateState({ state: "downloading", progress: 95 })).toEqual({
      state: "installing",
      progress: 100,
    });
    expect(nextUpdateState({ state: "downloading", progress: 100 })).toEqual({
      state: "installing",
      progress: 100,
    });
  });

  it("installing -> idle with progress reset", () => {
    expect(nextUpdateState({ state: "installing", progress: 100 })).toEqual({
      state: "idle",
      progress: 0,
    });
  });

  it("the timer tick follows the same transition table as nextUpdateState", () => {
    vi.useFakeTimers();
    try {
      const provider = createRealUpdateProvider();
      const events = collectEvents(provider);
      provider.start();

      let current: { state: UpdateProviderState; progress: number } = { state: "idle", progress: 0 };
      for (let tick = 0; tick < 6; tick += 1) {
        current = nextUpdateState(current);
        vi.advanceTimersByTime(REAL_UPDATE_TICK_INTERVAL_MS);
        const emitted = events[tick];
        expect(emitted?.metadata?.state).toBe(current.state);
        expect(emitted?.progress).toBe(current.progress);
      }
      expect(events).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dispatchUpdateInstall", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI__;
  });

  it("resets an installing state to idle and emits an update event on success", async () => {
    stubTauriInvoke({ success: true });
    const emit = vi.fn<(events: HubEvent[]) => void>();
    const state = { state: "installing" as UpdateProviderState, progress: 100 };

    const result = await dispatchUpdateInstall(state, emit);

    expect(result).toBe("idle");
    expect(state.state).toBe("idle");
    expect(state.progress).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
    const [batch] = emit.mock.calls[0] ?? [];
    expect(batch?.[0]?.metadata?.state).toBe("idle");
    expect(batch?.[0]?.progress).toBe(0);
  });

  it("resets a downloading state to idle and emits on success", async () => {
    stubTauriInvoke({ success: true });
    const emit = vi.fn<(events: HubEvent[]) => void>();
    const state = { state: "downloading" as UpdateProviderState, progress: 50 };

    const result = await dispatchUpdateInstall(state, emit);

    expect(result).toBe("idle");
    expect(state.progress).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("keeps checking and idle states untouched on success without emitting", async () => {
    stubTauriInvoke({ success: true });
    const emit = vi.fn<(events: HubEvent[]) => void>();
    const checking = { state: "checking" as UpdateProviderState, progress: 0 };
    const idle = { state: "idle" as UpdateProviderState, progress: 0 };

    await expect(dispatchUpdateInstall(checking, emit)).resolves.toBe("checking");
    await expect(dispatchUpdateInstall(idle, emit)).resolves.toBe("idle");
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps the current state when the native boundary reports success: false", async () => {
    stubTauriInvoke({ success: false });
    const emit = vi.fn<(events: HubEvent[]) => void>();
    const state = { state: "installing" as UpdateProviderState, progress: 100 };

    const result = await dispatchUpdateInstall(state, emit);

    expect(result).toBe("installing");
    expect(state.state).toBe("installing");
    expect(state.progress).toBe(100);
    expect(emit).not.toHaveBeenCalled();
  });

  it("falls through to the idle reset when no Tauri runtime is available (result undefined)", async () => {
    // No __TAURI__ global installed -> getTauriInvoke() returns undefined -> installUpdate resolves undefined
    const emit = vi.fn<(events: HubEvent[]) => void>();
    const state = { state: "installing" as UpdateProviderState, progress: 100 };

    const result = await dispatchUpdateInstall(state, emit);

    expect(result).toBe("idle");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("falls through to the idle reset when the native boundary rejects", async () => {
    const invoke: TauriInvoke = async () => {
      throw new Error("install rejected");
    };
    stubTauriInvoke(undefined);
    (globalThis as Record<string, unknown>).__TAURI__ = { core: { invoke } };

    const emit = vi.fn<(events: HubEvent[]) => void>();
    const state = { state: "downloading" as UpdateProviderState, progress: 20 };

    const result = await dispatchUpdateInstall(state, emit);

    expect(result).toBe("idle");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("returns the unchanged state for non-install states when the runtime is unavailable", async () => {
    const emit = vi.fn<(events: HubEvent[]) => void>();
    const state = { state: "checking" as UpdateProviderState, progress: 0 };

    const result = await dispatchUpdateInstall(state, emit);

    expect(result).toBe("checking");
    expect(emit).not.toHaveBeenCalled();
  });
});
