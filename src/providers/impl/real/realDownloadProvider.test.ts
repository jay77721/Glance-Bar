import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted: shared by the mock factory and the test body (vitest hoists vi.mock).
const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import {
  applyDownloadControl,
  createRealDownloadProvider,
  dispatchDownloadControl,
  type DownloadProviderStatus,
} from "./realDownloadProvider";
import type { HubEvent } from "@/entities";
import type { HubProvider } from "../../core/types";
import type { DownloadChangedPayload } from "../../../runtime/system/systemMonitorRuntime";
import type { TauriInvoke } from "../../../runtime/tauri/tauriRuntime";

const PROVIDER_ID = "real-download-provider";

/**
 * Configure listenMock to capture the registered handler so tests can
 * `fire(payload)` to simulate a native download-changed event.
 */
function captureListen(): { unlisten: ReturnType<typeof vi.fn>; fire: (payload: unknown) => void } {
  const unlisten = vi.fn();
  let captured: ((event: { payload: unknown }) => void) | undefined;

  listenMock.mockImplementation(
    async (_event: string, handler: (event: { payload: unknown }) => void) => {
      captured = handler;
      return unlisten;
    },
  );

  return {
    unlisten,
    fire(payload: unknown) {
      if (!captured) {
        throw new Error("listen handler was not registered");
      }
      captured({ payload });
    },
  };
}

function pendingListen(): { reject: () => void } {
  let rejectFn: ((reason: unknown) => void) | undefined;
  listenMock.mockImplementation(
    () =>
      new Promise<() => void>((_resolve, reject) => {
        rejectFn = reject;
      }),
  );
  return {
    reject() {
      rejectFn?.(new Error("listen failed"));
    },
  };
}

/**
 * Installs a fake `__TAURI__` global for the initial download-state fetch
 * (loadDownloadState -> getTauriInvoke -> __TAURI__.core.invoke).
 * `get_download_state` is answered with `statePayload`.
 */
function stubTauriDownloadState(invoke: TauriInvoke | undefined): void {
  const globalRecord = globalThis as Record<string, unknown>;
  if (invoke) {
    globalRecord.__TAURI__ = { core: { invoke } };
  } else {
    delete globalRecord.__TAURI__;
  }
}

function makeDownloadInvoke(statePayload: unknown): TauriInvoke {
  return async (command: string) => {
    if (command !== "get_download_state") {
      throw new Error(`unexpected command: ${command}`);
    }
    return statePayload;
  };
}

function makeDownloadingState(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    status: "downloading",
    activeDownloads: 1,
    progress: 42,
    code: "available",
    checkedAt: 1_780_743_600_000,
    ...overrides,
  };
}

/** The provider registers listeners/fetches asynchronously inside start(). */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function collectEvents(provider: HubProvider): HubEvent[] {
  const events: HubEvent[] = [];
  provider.subscribe((batch) => {
    events.push(...batch);
  });
  return events;
}

describe("createRealDownloadProvider", () => {
  beforeEach(() => {
    listenMock.mockReset();
    // Default: no Tauri runtime so the initial fetch resolves ok:false.
    stubTauriDownloadState(undefined);
    // Default platform: non-Windows so monitoring is "unsupported" unless a
    // test overrides it.
    vi.stubGlobal("navigator", { platform: "Linux" });
  });

  afterEach(() => {
    stubTauriDownloadState(undefined);
    vi.unstubAllGlobals();
  });

  describe("metadata and capabilities", () => {
    it("uses the real-download-provider id and version 1.0.0", () => {
      const provider = createRealDownloadProvider();
      expect(provider.id).toBe(PROVIDER_ID);
      expect(provider.metadata.id).toBe(PROVIDER_ID);
      expect(provider.metadata.version).toBe("1.0.0");
      expect(provider.metadata.kind).toBe("download");
      expect(provider.metadata.mock).toBe(false);
    });

    it("advertises a single download capability with origin=real and support=unsupported by default", () => {
      const provider = createRealDownloadProvider();
      expect(provider.capabilities).toHaveLength(1);
      expect(provider.capabilities[0]).toEqual({
        id: "download",
        kind: "download",
        origin: "real",
        support: "unsupported",
      });
    });

    it("sets support=available when on Windows in a Tauri runtime", () => {
      vi.stubGlobal("navigator", { platform: "Win32" });
      stubTauriDownloadState(makeDownloadInvoke(makeDownloadingState()));
      const provider = createRealDownloadProvider();
      expect(provider.capabilities[0]?.support).toBe("available");
    });
  });

  describe("lifecycle (supported platform)", () => {
    beforeEach(() => {
      vi.stubGlobal("navigator", { platform: "Win32" });
      // A Tauri runtime is required for support to be "available", which is
      // what gates listener registration. The initial fetch returns idle so it
      // emits nothing in these lifecycle-only tests.
      stubTauriDownloadState(makeDownloadInvoke(makeDownloadingState({ status: "idle", activeDownloads: 0, progress: 0 })));
    });

    it("starts Registered and transitions to Publishing on start()", async () => {
      captureListen();
      const provider = createRealDownloadProvider();
      expect(provider.status().lifecycle).toBe("Registered");
      provider.start();
      await flushMicrotasks();
      expect(provider.status().lifecycle).toBe("Publishing");
    });

    it("is idempotent: start() called twice registers only one listener", async () => {
      captureListen();
      const provider = createRealDownloadProvider();
      provider.start();
      provider.start();
      await flushMicrotasks();

      expect(listenMock).toHaveBeenCalledTimes(1);
      expect(provider.status().lifecycle).toBe("Publishing");
    });

    it("transitions to Stopped on stop() and unwires the native listener", async () => {
      const { unlisten } = captureListen();
      const provider = createRealDownloadProvider();
      provider.start();
      await flushMicrotasks();

      provider.stop();
      expect(provider.status().lifecycle).toBe("Stopped");
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("stop() is a no-op when the listener has not registered yet", async () => {
      listenMock.mockImplementation(
        () => new Promise<() => void>(() => undefined),
      );
      const provider = createRealDownloadProvider();
      provider.start();
      provider.stop();
      expect(provider.status().lifecycle).toBe("Stopped");
    });
  });

  describe("lifecycle (unsupported platform)", () => {
    it("does not register a listener when monitoring is unsupported", async () => {
      // navigator.platform defaults to "Linux" in beforeEach.
      const provider = createRealDownloadProvider();
      provider.start();
      await flushMicrotasks();

      expect(listenMock).not.toHaveBeenCalled();
      expect(provider.status().lifecycle).toBe("Publishing");
    });
  });

  describe("initial fetch", () => {
    beforeEach(() => {
      vi.stubGlobal("navigator", { platform: "Win32" });
    });

    it("emits the current download state on start when native data loads", async () => {
      captureListen();
      stubTauriDownloadState(makeDownloadInvoke(makeDownloadingState()));
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.id).toBe(`${PROVIDER_ID}-download-1780743600000`);
      expect(event?.type).toBe("download");
      expect(event?.source).toBe("download");
      expect(event?.createdAt).toBe(1_780_743_600_000);
      expect(event?.progress).toBe(42);
      expect(event?.payload).toMatchObject({
        title: "Downloading",
        subtitle: "In progress",
      });
      expect(event?.metadata?.status).toBe("downloading");
      expect(event?.metadata?.activeDownloads).toBe(1);
    });

    it("does not emit when the native fetch reports idle", async () => {
      captureListen();
      stubTauriDownloadState(
        makeDownloadInvoke(makeDownloadingState({ status: "idle", activeDownloads: 0, progress: 0 })),
      );
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      expect(events).toHaveLength(0);
      expect(provider.status().health).toBe("Healthy");
    });

    it("does not emit when the native fetch reports unsupported", async () => {
      captureListen();
      stubTauriDownloadState(
        makeDownloadInvoke(
          makeDownloadingState({ status: "idle", activeDownloads: 0, progress: 0, code: "unsupported" }),
        ),
      );
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      expect(events).toHaveLength(0);
    });

    it("does not emit or crash when the native fetch rejects", async () => {
      captureListen();
      const failing: TauriInvoke = async () => {
        throw new Error("download boundary failed");
      };
      stubTauriDownloadState(failing);
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      expect(events).toHaveLength(0);
      expect(provider.status().health).toBe("Healthy");
    });

    it("does not emit when the native payload is malformed", async () => {
      captureListen();
      stubTauriDownloadState(makeDownloadInvoke({ status: "downloading" }));
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      expect(events).toHaveLength(0);
    });
  });

  describe("listener emissions", () => {
    beforeEach(() => {
      vi.stubGlobal("navigator", { platform: "Win32" });
      // Tauri runtime present so support is "available" and the listener
      // registers. Initial fetch returns idle so it emits nothing here.
      stubTauriDownloadState(makeDownloadInvoke(makeDownloadingState({ status: "idle", activeDownloads: 0, progress: 0 })));
    });

    it("maps a downloading payload from the change event to a download HubEvent", async () => {
      const { fire } = captureListen();
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      const payload: DownloadChangedPayload = {
        status: "downloading",
        activeDownloads: 2,
        progress: 33,
        code: "available",
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("download");
      expect(event?.progress).toBe(33);
      expect(event?.payload).toMatchObject({
        title: "2 downloads",
        subtitle: "In progress",
      });
      expect(event?.metadata?.activeDownloads).toBe(2);
    });

    it("maps a completed payload to a completion HubEvent", async () => {
      const { fire } = captureListen();
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      fire({
        status: "completed",
        activeDownloads: 0,
        progress: 100,
        code: "available",
        checkedAt: 1_780_743_600_000,
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.progress).toBe(100);
      expect(events[0]?.payload).toMatchObject({
        title: "Download complete",
        subtitle: "Saved to Downloads",
      });
      expect(events[0]?.metadata?.status).toBe("completed");
    });

    it("emits every change (no content dedup) including duplicates", async () => {
      const { fire } = captureListen();
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      const payload: DownloadChangedPayload = {
        status: "downloading",
        activeDownloads: 1,
        progress: 33,
        code: "available",
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);
      fire(payload);

      expect(events).toHaveLength(2);
      // Both events share the checkedAt-derived id — dedup is intentionally absent
      expect(events[0]?.id).toBe(events[1]?.id);
    });

    it("falls back to Date.now() when a change event carries checkedAt 0", async () => {
      const { fire } = captureListen();
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();

      const before = Date.now();
      fire({
        status: "downloading",
        activeDownloads: 1,
        progress: 10,
        code: "available",
        checkedAt: 0,
      });
      const after = Date.now();

      expect(events).toHaveLength(1);
      expect(events[0]?.createdAt).toBeGreaterThanOrEqual(before);
      expect(events[0]?.createdAt).toBeLessThanOrEqual(after);
    });

    it("stop() gates further change-event emissions", async () => {
      const { fire } = captureListen();
      const provider = createRealDownloadProvider();
      const events = collectEvents(provider);
      provider.start();
      await flushMicrotasks();
      expect(events).toHaveLength(0);

      provider.stop();
      fire({
        status: "downloading",
        activeDownloads: 1,
        progress: 55,
        code: "available",
        checkedAt: 1_780_743_600_000,
      });
      expect(events).toHaveLength(0);
    });
  });

  describe("degraded marking", () => {
    beforeEach(() => {
      vi.stubGlobal("navigator", { platform: "Win32" });
      // Tauri runtime present so support is "available" and the listener
      // registration path is exercised.
      stubTauriDownloadState(makeDownloadInvoke(makeDownloadingState({ status: "idle", activeDownloads: 0, progress: 0 })));
    });

    it("marks the provider Degraded when the native listener registration fails", async () => {
      const { reject } = pendingListen();
      const provider = createRealDownloadProvider();

      provider.start();
      reject();
      await flushMicrotasks();

      expect(provider.status().health).toBe("Degraded");
      expect(provider.status().lifecycle).toBe("Publishing");
    });

    it("stays Healthy when the native listener registers successfully", async () => {
      captureListen();
      stubTauriDownloadState(undefined);
      const provider = createRealDownloadProvider();
      provider.start();
      await flushMicrotasks();

      expect(provider.status().health).toBe("Healthy");
    });
  });
});

describe("applyDownloadControl", () => {
  it("transitions downloading -> paused on pause", () => {
    const state: { status: DownloadProviderStatus } = { status: "downloading" };
    expect(applyDownloadControl(state, "pause")).toBe(true);
    expect(state.status).toBe("paused");
  });

  it("is a no-op when pausing an already paused download", () => {
    const state: { status: DownloadProviderStatus } = { status: "paused" };
    expect(applyDownloadControl(state, "pause")).toBe(false);
    expect(state.status).toBe("paused");
  });

  it("transitions paused -> downloading on resume", () => {
    const state: { status: DownloadProviderStatus } = { status: "paused" };
    expect(applyDownloadControl(state, "resume")).toBe(true);
    expect(state.status).toBe("downloading");
  });

  it("is a no-op when resuming an already downloading download", () => {
    const state: { status: DownloadProviderStatus } = { status: "downloading" };
    expect(applyDownloadControl(state, "resume")).toBe(false);
    expect(state.status).toBe("downloading");
  });

  it("transitions to cancelled on cancel from downloading or paused", () => {
    const downloading: { status: DownloadProviderStatus } = { status: "downloading" };
    expect(applyDownloadControl(downloading, "cancel")).toBe(true);
    expect(downloading.status).toBe("cancelled");

    const paused: { status: DownloadProviderStatus } = { status: "paused" };
    expect(applyDownloadControl(paused, "cancel")).toBe(true);
    expect(paused.status).toBe("cancelled");
  });

  it("is a no-op when cancelling an already cancelled or completed download", () => {
    const cancelled: { status: DownloadProviderStatus } = { status: "cancelled" };
    expect(applyDownloadControl(cancelled, "cancel")).toBe(false);

    const completed: { status: DownloadProviderStatus } = { status: "completed" };
    expect(applyDownloadControl(completed, "cancel")).toBe(false);
  });
});

describe("dispatchDownloadControl", () => {
  it("transitions state and emits when the action changes state", async () => {
    const emit = vi.fn();
    const state = { progress: 30, status: "downloading" as DownloadProviderStatus };
    const result = await dispatchDownloadControl(state, "pause", emit);
    expect(result).toBe("paused");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("emits a new event when the action changes state", async () => {
    const emit = vi.fn();
    const state = { progress: 30, status: "downloading" as DownloadProviderStatus };
    await dispatchDownloadControl(state, "cancel", emit);
    expect(state.status).toBe("cancelled");
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
