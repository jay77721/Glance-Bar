import { describe, it, vi, beforeEach } from "vitest";

// Hoist: shared by both the mock factory and the test body so
// `vi.mock` can reference the same spy as the test assertions.
const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

// Imports must come AFTER vi.mock so they pick up the mocked module.
import {
  CLIPBOARD_CHANGED_EVENT,
  DOWNLOAD_CHANGED_EVENT,
  FOCUS_ASSIST_CHANGED_EVENT,
  MEDIA_SESSION_CHANGED_EVENT,
  NOTIFICATIONS_CHANGED_EVENT,
  getFocusAssistState,
  getNotificationSummary,
  getDownloadMonitorSupport,
  loadDownloadState,
  onClipboardChanged,
  onDownloadChanged,
  onFocusAssistChanged,
  onMediaSessionChanged,
  onNotificationsChanged,
  parseDownloadChangedPayload,
  type ClipboardChangedPayload,
  type DownloadChangedPayload,
  type FocusAssistState,
  type MediaSessionChangedPayload,
  type NotificationSummary,
} from "./systemMonitorRuntime";
import type { TauriInvoke } from "../tauri/tauriRuntime";

/**
 * Configure listenMock to capture the registered handler and return a
 * spy for the unlisten function. Tests use `fire(payload)` to simulate
 * a native event being emitted.
 */
function captureListen(): {
  unlisten: ReturnType<typeof vi.fn>;
  fire: (payload: unknown) => void;
} {
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

describe("systemMonitorRuntime.test", () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  // ── Event-name constants ─────────────────────────────────────

  it("exports the four status-center event names", () => {
    assert.equal(CLIPBOARD_CHANGED_EVENT, "status-center://clipboard-changed");
    assert.equal(FOCUS_ASSIST_CHANGED_EVENT, "status-center://focus-assist-changed");
    assert.equal(MEDIA_SESSION_CHANGED_EVENT, "status-center://media-session-changed");
    assert.equal(NOTIFICATIONS_CHANGED_EVENT, "status-center://notifications-changed");
  });

  // ── onClipboardChanged ───────────────────────────────────────

  describe("onClipboardChanged", () => {
    it("returns a Promise<UnlistenFn>", async () => {
      const { unlisten } = captureListen();

      const result = onClipboardChanged(() => {});

      assert.equal(result instanceof Promise, true);
      const fn = await result;
      assert.equal(fn, unlisten);
    });

    it("subscribes to the clipboard-changed event name", async () => {
      captureListen();
      await onClipboardChanged(() => {});

      assert.equal(listenMock.mock.calls.length, 1);
      assert.equal(listenMock.mock.calls[0]?.[0], CLIPBOARD_CHANGED_EVENT);
    });

    it("forwards the event payload to the handler", async () => {
      const { fire } = captureListen();
      const received: ClipboardChangedPayload[] = [];
      await onClipboardChanged((content) => received.push(content));

      const payload: ClipboardChangedPayload = {
        text: "https://github.com/example",
        sourceApp: "TestApp",
        copiedAt: 1_780_743_600_000,
      };
      fire(payload);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], payload);
    });

    it("forwards the payload fields without mutation", async () => {
      const { fire } = captureListen();
      const received: ClipboardChangedPayload[] = [];
      await onClipboardChanged((content) => received.push(content));

      fire({ text: "secret-token", sourceApp: "Browser", copiedAt: 12345 });

      const first = received[0];
      if (!first) {
        throw new Error("expected payload to be forwarded");
      }
      assert.equal(first.text, "secret-token");
      assert.equal(first.sourceApp, "Browser");
      assert.equal(first.copiedAt, 12345);
    });

    it("returns the unlisten function for cleanup", async () => {
      const { unlisten } = captureListen();

      const unlistenFn = await onClipboardChanged(() => {});

      assert.equal(typeof unlistenFn, "function");
      unlistenFn();
      assert.equal(unlisten.mock.calls.length, 1);
    });

    it("propagates rejection when Tauri listen fails (no graceful fallback)", async () => {
      listenMock.mockRejectedValue(new Error("not in tauri environment"));

      let rejected = false;
      try {
        await onClipboardChanged(() => {});
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true);
    });
  });

  // ── onFocusAssistChanged ─────────────────────────────────────

  describe("onFocusAssistChanged", () => {
    it("returns a Promise<UnlistenFn>", async () => {
      const { unlisten } = captureListen();

      const unlistenFn = await onFocusAssistChanged(() => {});

      assert.equal(unlistenFn, unlisten);
    });

    it("subscribes to the focus-assist event name", async () => {
      captureListen();
      await onFocusAssistChanged(() => {});

      assert.equal(listenMock.mock.calls[0]?.[0], FOCUS_ASSIST_CHANGED_EVENT);
    });

    it("forwards an active focus-assist payload to the handler", async () => {
      const { fire } = captureListen();
      const received: FocusAssistState[] = [];
      await onFocusAssistChanged((state) => received.push(state));

      const payload: FocusAssistState = {
        active: true,
        profile: "alarms-only",
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], payload);
    });

    it("forwards an inactive focus-assist payload to the handler", async () => {
      const { fire } = captureListen();
      const received: FocusAssistState[] = [];
      await onFocusAssistChanged((state) => received.push(state));

      fire({ active: false, profile: "off", checkedAt: 0 });

      const first = received[0];
      if (!first) {
        throw new Error("expected payload to be forwarded");
      }
      assert.equal(first.active, false);
      assert.equal(first.profile, "off");
      assert.equal(first.checkedAt, 0);
    });

    it("returns the unlisten function for cleanup", async () => {
      const { unlisten } = captureListen();

      const unlistenFn = await onFocusAssistChanged(() => {});

      assert.equal(typeof unlistenFn, "function");
      unlistenFn();
      assert.equal(unlisten.mock.calls.length, 1);
    });

    it("propagates rejection when Tauri listen fails", async () => {
      listenMock.mockRejectedValue(new Error("not in tauri environment"));

      let rejected = false;
      try {
        await onFocusAssistChanged(() => {});
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true);
    });
  });

  // ── onMediaSessionChanged ────────────────────────────────────

  describe("onMediaSessionChanged", () => {
    it("returns a Promise<UnlistenFn>", async () => {
      const { unlisten } = captureListen();

      const unlistenFn = await onMediaSessionChanged(() => {});

      assert.equal(unlistenFn, unlisten);
    });

    it("subscribes to the media-session event name", async () => {
      captureListen();
      await onMediaSessionChanged(() => {});

      assert.equal(listenMock.mock.calls[0]?.[0], MEDIA_SESSION_CHANGED_EVENT);
    });

    it("forwards a playing payload to the handler", async () => {
      const { fire } = captureListen();
      const received: MediaSessionChangedPayload[] = [];
      await onMediaSessionChanged((status) => received.push(status));

      const payload: MediaSessionChangedPayload = {
        available: true,
        playbackStatus: "playing",
        progress: 42,
        positionMs: 65_000,
        durationMs: 195_000,
        title: "Track",
        artist: "Artist",
        code: "available",
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], payload);
    });

    it("forwards an unavailable payload without optional fields", async () => {
      const { fire } = captureListen();
      const received: MediaSessionChangedPayload[] = [];
      await onMediaSessionChanged((status) => received.push(status));

      const payload: MediaSessionChangedPayload = {
        available: false,
        playbackStatus: "unavailable",
        progress: 0,
        code: "provider-failed",
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);

      const first = received[0];
      if (!first) {
        throw new Error("expected payload to be forwarded");
      }
      assert.equal(first.available, false);
      assert.equal(first.playbackStatus, "unavailable");
      assert.equal(first.title, undefined);
      assert.equal(first.positionMs, undefined);
    });

    it("forwards a paused payload to the handler", async () => {
      const { fire } = captureListen();
      const received: MediaSessionChangedPayload[] = [];
      await onMediaSessionChanged((status) => received.push(status));

      fire({
        available: true,
        playbackStatus: "paused",
        progress: 50,
        code: "available",
        checkedAt: 1_780_743_600_000,
      });

      const first = received[0];
      if (!first) {
        throw new Error("expected payload to be forwarded");
      }
      assert.equal(first.playbackStatus, "paused");
      assert.equal(first.progress, 50);
    });

    it("returns the unlisten function for cleanup", async () => {
      const { unlisten } = captureListen();

      const unlistenFn = await onMediaSessionChanged(() => {});

      assert.equal(typeof unlistenFn, "function");
      unlistenFn();
      assert.equal(unlisten.mock.calls.length, 1);
    });

    it("propagates rejection when Tauri listen fails", async () => {
      listenMock.mockRejectedValue(new Error("not in tauri environment"));

      let rejected = false;
      try {
        await onMediaSessionChanged(() => {});
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true);
    });
  });

  // ── onNotificationsChanged (sister listener, same contract) ──

  describe("onNotificationsChanged", () => {
    it("returns a Promise<UnlistenFn>", async () => {
      const { unlisten } = captureListen();
      const unlistenFn = await onNotificationsChanged(() => {});
      assert.equal(unlistenFn, unlisten);
    });

    it("subscribes to the notifications event name", async () => {
      captureListen();
      await onNotificationsChanged(() => {});
      assert.equal(listenMock.mock.calls[0]?.[0], NOTIFICATIONS_CHANGED_EVENT);
    });

    it("forwards the summary payload to the handler", async () => {
      const { fire } = captureListen();
      const received: NotificationSummary[] = [];
      await onNotificationsChanged((summary) => received.push(summary));

      const payload: NotificationSummary = {
        focusAssistActive: true,
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], payload);
    });

    it("returns the unlisten function for cleanup", async () => {
      const { unlisten } = captureListen();
      const unlistenFn = await onNotificationsChanged(() => {});
      assert.equal(typeof unlistenFn, "function");
      unlistenFn();
      assert.equal(unlisten.mock.calls.length, 1);
    });
  });

  // ── onDownloadChanged (sister listener, same contract) ────────

  describe("onDownloadChanged", () => {
    it("returns a Promise<UnlistenFn>", async () => {
      const { unlisten } = captureListen();
      const unlistenFn = await onDownloadChanged(() => {});
      assert.equal(unlistenFn, unlisten);
    });

    it("subscribes to the download-changed event name", async () => {
      captureListen();
      await onDownloadChanged(() => {});
      assert.equal(listenMock.mock.calls[0]?.[0], DOWNLOAD_CHANGED_EVENT);
    });

    it("forwards a downloading payload to the handler", async () => {
      const { fire } = captureListen();
      const received: DownloadChangedPayload[] = [];
      await onDownloadChanged((status) => received.push(status));

      const payload: DownloadChangedPayload = {
        status: "downloading",
        activeDownloads: 2,
        progress: 33,
        code: "available",
        checkedAt: 1_780_743_600_000,
      };
      fire(payload);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], payload);
    });

    it("forwards a completed payload without mutating it", async () => {
      const { fire } = captureListen();
      const received: DownloadChangedPayload[] = [];
      await onDownloadChanged((status) => received.push(status));

      fire({
        status: "completed",
        activeDownloads: 0,
        progress: 100,
        code: "available",
        checkedAt: 12345,
      });

      const first = received[0];
      if (!first) {
        throw new Error("expected payload to be forwarded");
      }
      assert.equal(first.status, "completed");
      assert.equal(first.progress, 100);
      assert.equal(first.checkedAt, 12345);
    });

    it("returns the unlisten function for cleanup", async () => {
      const { unlisten } = captureListen();
      const unlistenFn = await onDownloadChanged(() => {});
      assert.equal(typeof unlistenFn, "function");
      unlistenFn();
      assert.equal(unlisten.mock.calls.length, 1);
    });

    it("propagates rejection when Tauri listen fails", async () => {
      listenMock.mockRejectedValue(new Error("not in tauri environment"));

      let rejected = false;
      try {
        await onDownloadChanged(() => {});
      } catch {
        rejected = true;
      }
      assert.equal(rejected, true);
    });
  });

  // ── parseDownloadChangedPayload ───────────────────────────────

  describe("parseDownloadChangedPayload", () => {
    it("maps a well-formed downloading payload", () => {
      const result = parseDownloadChangedPayload({
        status: "downloading",
        activeDownloads: 1,
        progress: 42,
        code: "available",
        checkedAt: 1_780_743_600_000,
      });
      assert.deepEqual(result, {
        status: "downloading",
        activeDownloads: 1,
        progress: 42,
        code: "available",
        checkedAt: 1_780_743_600_000,
      });
    });

    it("maps a completed payload", () => {
      const result = parseDownloadChangedPayload({
        status: "completed",
        activeDownloads: 0,
        progress: 100,
        code: "available",
        checkedAt: 1,
      });
      assert.equal(result?.status, "completed");
      assert.equal(result?.progress, 100);
    });

    it("clamps an out-of-range progress into [0, 100]", () => {
      const tooHigh = parseDownloadChangedPayload({
        status: "downloading",
        activeDownloads: 1,
        progress: 250,
        code: "available",
        checkedAt: 1,
      });
      assert.equal(tooHigh?.progress, 100);

      const tooLow = parseDownloadChangedPayload({
        status: "downloading",
        activeDownloads: 1,
        progress: -10,
        code: "available",
        checkedAt: 1,
      });
      assert.equal(tooLow?.progress, 0);
    });

    it("returns undefined for a primitive payload", () => {
      assert.equal(parseDownloadChangedPayload("nope"), undefined);
    });

    it("returns undefined for a null payload", () => {
      assert.equal(parseDownloadChangedPayload(null), undefined);
    });

    it("returns undefined when a required field is missing", () => {
      const result = parseDownloadChangedPayload({
        status: "downloading",
        activeDownloads: 1,
        progress: 42,
        // code + checkedAt missing
      });
      assert.equal(result, undefined);
    });

    it("returns undefined for an invalid status", () => {
      const result = parseDownloadChangedPayload({
        status: "stalled",
        activeDownloads: 1,
        progress: 42,
        code: "available",
        checkedAt: 1,
      });
      assert.equal(result, undefined);
    });
  });

  // ── loadDownloadState (polling fetcher) ───────────────────────

  describe("loadDownloadState", () => {
    function makeInvoke(
      result: unknown,
      calls: string[],
    ): TauriInvoke {
      return async (command) => {
        calls.push(command);
        return result;
      };
    }

    it("returns undefined when no Tauri invoke is available", async () => {
      const result = await loadDownloadState(undefined);
      assert.equal(result, undefined);
    });

    it("invokes get_download_state and maps a well-formed payload", async () => {
      const calls: string[] = [];
      const invoke = makeInvoke(
        {
          status: "downloading",
          activeDownloads: 1,
          progress: 42,
          code: "available",
          checkedAt: 1_780_743_600_000,
        },
        calls,
      );

      const result = await loadDownloadState(invoke);

      assert.deepEqual(calls, ["get_download_state"]);
      assert.deepEqual(result, {
        status: "downloading",
        activeDownloads: 1,
        progress: 42,
        code: "available",
        checkedAt: 1_780_743_600_000,
      });
    });

    it("returns undefined when the native boundary rejects", async () => {
      const invoke: TauriInvoke = async () => {
        throw new Error("download state failed");
      };
      const result = await loadDownloadState(invoke);
      assert.equal(result, undefined);
    });

    it("returns undefined when the payload is malformed", async () => {
      const invoke = makeInvoke({ status: "downloading" }, []);
      const result = await loadDownloadState(invoke);
      assert.equal(result, undefined);
    });
  });

  // ── getDownloadMonitorSupport ─────────────────────────────────

  describe("getDownloadMonitorSupport", () => {
    // `navigator.platform` is what the support helper reads, so each test sets
    // it explicitly. We redefine it per-test (configurable) and restore the
    // original descriptor in beforeEach to keep tests isolated.
    function setNavigatorPlatform(platform: string): void {
      Object.defineProperty(globalThis, "navigator", {
        value: { platform },
        configurable: true,
        writable: true,
      });
    }

    beforeEach(() => {
      const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      if (original) {
        // Restore once at the start of each test; runs before the test body's
        // own redefinition so prior-test mutations never leak.
        Object.defineProperty(globalThis, "navigator", original);
      }
      delete (globalThis as Record<string, unknown>).__TAURI__;
    });

    function setTauriInvoke(): void {
      (globalThis as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    }

    it("returns unsupported when no Tauri invoke is available", () => {
      setNavigatorPlatform("Win32");
      assert.equal(getDownloadMonitorSupport(), "unsupported");
    });

    it("returns available on Windows in a Tauri runtime", () => {
      setTauriInvoke();
      setNavigatorPlatform("Win32");
      assert.equal(getDownloadMonitorSupport(), "available");
    });

    it("returns unsupported on non-Windows even in a Tauri runtime", () => {
      setTauriInvoke();
      setNavigatorPlatform("Linux");
      assert.equal(getDownloadMonitorSupport(), "unsupported");
    });

    it("returns unsupported when navigator is unavailable", () => {
      setTauriInvoke();
      Object.defineProperty(globalThis, "navigator", {
        value: undefined,
        configurable: true,
      });
      assert.equal(getDownloadMonitorSupport(), "unsupported");
    });
  });

  // ── getFocusAssistState (polling fetcher) ────────────────────

  describe("getFocusAssistState", () => {
    function makeInvoke(
      result: unknown,
      calls: string[],
    ): TauriInvoke {
      return async (command) => {
        calls.push(command);
        return result;
      };
    }

    it("returns undefined when no Tauri invoke is available", async () => {
      const result = await getFocusAssistState(undefined);

      assert.equal(result, undefined);
    });

    it("invokes get_focus_assist_state and maps a well-formed payload", async () => {
      const calls: string[] = [];
      const invoke = makeInvoke(
        { active: true, profile: "priority-only", checkedAt: 1_780_743_600_000 },
        calls,
      );

      const result = await getFocusAssistState(invoke);

      assert.deepEqual(calls, ["get_focus_assist_state"]);
      assert.deepEqual(result, {
        active: true,
        profile: "priority-only",
        checkedAt: 1_780_743_600_000,
      });
    });

    it("normalizes non-boolean active to false", async () => {
      const invoke = makeInvoke({ active: "yes", profile: "off", checkedAt: 1 }, []);
      const result = await getFocusAssistState(invoke);

      assert.equal(result?.active, false);
    });

    it("normalizes a non-string profile to an empty string", async () => {
      const invoke = makeInvoke({ active: true, profile: 42, checkedAt: 1 }, []);
      const result = await getFocusAssistState(invoke);

      assert.equal(result?.profile, "");
    });

    it("stamps checkedAt with the current time when the payload omits it", async () => {
      const before = Date.now();
      const invoke = makeInvoke({ active: false, profile: "off" }, []);
      const result = await getFocusAssistState(invoke);
      const after = Date.now();

      assert.ok(result?.checkedAt !== undefined);
      assert.ok(result?.checkedAt >= before && result.checkedAt <= after);
    });

    it("stamps checkedAt when the payload carries a non-number value", async () => {
      const invoke = makeInvoke({ active: false, profile: "off", checkedAt: "soon" }, []);
      const result = await getFocusAssistState(invoke);

      assert.ok(typeof result?.checkedAt === "number");
    });

    it("returns undefined for a primitive payload", async () => {
      const invoke = makeInvoke(true, []);
      const result = await getFocusAssistState(invoke);

      assert.equal(result, undefined);
    });

    it("returns undefined for a null payload", async () => {
      const invoke = makeInvoke(null, []);
      const result = await getFocusAssistState(invoke);

      assert.equal(result, undefined);
    });

    it("returns undefined when the native boundary rejects", async () => {
      const invoke: TauriInvoke = async () => {
        throw new Error("focus assist unavailable");
      };
      const result = await getFocusAssistState(invoke);

      assert.equal(result, undefined);
    });
  });

  // ── getNotificationSummary (polling fetcher) ────────────────

  describe("getNotificationSummary", () => {
    function makeInvoke(
      result: unknown,
      calls: string[],
    ): TauriInvoke {
      return async (command) => {
        calls.push(command);
        return result;
      };
    }

    it("returns undefined when no Tauri invoke is available", async () => {
      const result = await getNotificationSummary(undefined);

      assert.equal(result, undefined);
    });

    it("invokes get_notification_summary and maps a well-formed payload", async () => {
      const calls: string[] = [];
      const invoke = makeInvoke(
        { focusAssistActive: true, checkedAt: 1_780_743_600_000 },
        calls,
      );

      const result = await getNotificationSummary(invoke);

      assert.deepEqual(calls, ["get_notification_summary"]);
      assert.deepEqual(result, {
        focusAssistActive: true,
        checkedAt: 1_780_743_600_000,
      });
    });

    it("normalizes a non-boolean focusAssistActive to false", async () => {
      const invoke = makeInvoke({ focusAssistActive: 1, checkedAt: 1 }, []);
      const result = await getNotificationSummary(invoke);

      assert.equal(result?.focusAssistActive, false);
    });

    it("stamps checkedAt with the current time when the payload omits it", async () => {
      const before = Date.now();
      const invoke = makeInvoke({ focusAssistActive: false }, []);
      const result = await getNotificationSummary(invoke);
      const after = Date.now();

      assert.ok(result?.checkedAt >= before && result.checkedAt <= after);
    });

    it("stamps checkedAt when the payload carries a non-number value", async () => {
      const invoke = makeInvoke({ focusAssistActive: false, checkedAt: null }, []);
      const result = await getNotificationSummary(invoke);

      assert.ok(typeof result?.checkedAt === "number");
    });

    it("returns undefined for a primitive payload", async () => {
      const invoke = makeInvoke("nope", []);
      const result = await getNotificationSummary(invoke);

      assert.equal(result, undefined);
    });

    it("returns undefined when the native boundary rejects", async () => {
      const invoke: TauriInvoke = async () => {
        throw new Error("notification summary failed");
      };
      const result = await getNotificationSummary(invoke);

      assert.equal(result, undefined);
    });
  });
});
