import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDesktopStatusRuntime } from "./useDesktopStatusRuntime";
import { createHubEventBus } from "@/state/hubState";
import type { HubEventBus } from "@/state/hubState";
import { createSchedulerService } from "@/runtime/scheduler/schedulerService";
import { defaultDesktopRuntimeDependencies } from "./desktopRuntimeDependencies";
import type { DesktopRuntimeDependencies } from "./desktopRuntimeDependencies";
import type { ProviderManager } from "@/providers";
import { DESKTOP_STATUS_TEMPLATE_ORDER } from "@/entities/status/config";
import { mockMetrics } from "@/shared/test-util/fixtures";
import type { SystemPerformanceMetric } from "@/entities";

// We don't want the real ProviderManager wiring up Tauri listeners in
// jsdom — the Tauri `listen()` function isn't available, the
// onClipboardChanged / onFocusAssistChanged / onMediaSessionChanged
// bridges all return rejected promises, and we don't want real timers
// or intervals to leak between tests. Mock the entire runtime surface.
vi.mock("@/runtime/tauri/tauriRuntime", () => ({
  getTauriInvoke: vi.fn(() => undefined),
  loadTauriMediaSessionStatus: vi.fn().mockResolvedValue({
    ok: false,
    diagnostic: { code: "unavailable", message: "no Tauri" },
  }),
  loadSystemPerformanceStatus: vi.fn().mockResolvedValue({
    metrics: [],
    diagnostic: { quality: "unavailable", code: "unavailable", source: "mock" },
  }),
}));

vi.mock("@/runtime/system/systemMonitorRuntime", () => ({
  onClipboardChanged: vi.fn(() => Promise.resolve(() => undefined)),
  onFocusAssistChanged: vi.fn(() => Promise.resolve(() => undefined)),
  onMediaSessionChanged: vi.fn(() => Promise.resolve(() => undefined)),
  onNotificationsChanged: vi.fn(() => Promise.resolve(() => undefined)),
  onDownloadChanged: vi.fn(() => Promise.resolve(() => undefined)),
  getFocusAssistState: vi.fn(() => Promise.resolve(undefined)),
  getNotificationsSummary: vi.fn(() => Promise.resolve(undefined)),
  getDownloadMonitorSupport: vi.fn(() => "unsupported"),
  loadDownloadState: vi.fn(() => Promise.resolve(undefined)),
}));

const baseMetrics: SystemPerformanceMetric[] = mockMetrics();

beforeEach(() => {
  vi.useFakeTimers();
  // Set a deterministic "now" so the alternation math is reproducible.
  vi.setSystemTime(new Date("2026-06-12T16:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDesktopStatusRuntime", () => {
  it("returns a resident resolved state when no providers are emitting", () => {
    const { result } = renderHook(() => useDesktopStatusRuntime(baseMetrics, "fallback"));

    // mockProviders: false in the hook → no mock events → no active kinds →
    // scheduler falls back to the default "resident" kind.
    expect(result.current.activeKinds).toEqual([]);
    expect(result.current.resolvedState.kind).toBe("resident");
  });

  it("exposes the preferred window constant via the result", () => {
    const { result } = renderHook(() => useDesktopStatusRuntime(baseMetrics, "fallback"));

    // 20_000 ms per desktopStatusScheduler — keep this in sync if it changes.
    expect(result.current.preferredWindowMs).toBe(20_000);
  });

  it("clears the preferred kind when setPreferredUntil + setActiveStatusKind are reset", () => {
    const { result } = renderHook(() => useDesktopStatusRuntime(baseMetrics, "fallback"));

    act(() => {
      result.current.setActiveStatusKind("media");
      result.current.setPreferredUntil(Date.now() + 5_000);
    });

    expect(result.current.activeStatusKind).toBe("media");
    expect(result.current.preferredUntil).toBeGreaterThan(Date.now());

    act(() => {
      result.current.setActiveStatusKind(null);
      result.current.setPreferredUntil(undefined);
    });

    expect(result.current.activeStatusKind).toBeNull();
    expect(result.current.preferredUntil).toBeUndefined();
  });

  it("returns stable setter identities across renders", () => {
    const { result, rerender } = renderHook(() => useDesktopStatusRuntime(baseMetrics, "fallback"));

    const firstSetters = {
      setActiveStatusKind: result.current.setActiveStatusKind,
      setPreferredUntil: result.current.setPreferredUntil,
    };

    rerender();

    expect(result.current.setActiveStatusKind).toBe(firstSetters.setActiveStatusKind);
    expect(result.current.setPreferredUntil).toBe(firstSetters.setPreferredUntil);
  });

  it("uses injected dependencies instead of constructing real core objects", () => {
    const createEventBus = vi.fn((): HubEventBus => createHubEventBus());
    const createManager = vi.fn(
      (): ProviderManager =>
        ({
          registry: {
            list: vi.fn(() => []),
          },
          start: vi.fn(),
          stop: vi.fn(),
          listProviderIds: vi.fn(() => []),
        }) as unknown as ProviderManager,
    );
    const createScheduler = vi.fn(() => createSchedulerService());
    const dependencies: DesktopRuntimeDependencies = {
      createEventBus,
      createProviderManager: createManager,
      createSchedulerService: createScheduler,
    };

    const { result } = renderHook(() =>
      useDesktopStatusRuntime(baseMetrics, "fallback", dependencies),
    );

    // Every factory is consulted exactly once, and the fake manager — not a
    // real one with Tauri-backed providers — is what the hook exposes.
    expect(createEventBus).toHaveBeenCalledTimes(1);
    expect(createManager).toHaveBeenCalledTimes(1);
    expect(createScheduler).toHaveBeenCalledTimes(1);
    expect(result.current.providerManager).toBe(createManager.mock.results[0]?.value);
    expect(result.current.providerRecords).toEqual([]);
    // With the fake manager publishing nothing, the resolver still produces a
    // valid kind — proving the hook renders end-to-end on injected fakes.
    expect(DESKTOP_STATUS_TEMPLATE_ORDER).toContain(result.current.resolvedState.kind);
  });

  it("defaults to the real production dependencies when none are injected", () => {
    const { result } = renderHook(() => useDesktopStatusRuntime(baseMetrics, "fallback"));

    // The real manager registers Tauri-backed providers; the fake-path factories
    // above must not leak into the default path.
    expect(result.current.providerManager).toBeDefined();
    expect(result.current.providerManager?.registry.list().length).toBeGreaterThan(0);
    expect(defaultDesktopRuntimeDependencies.createEventBus).toBeTypeOf("function");
  });
});
