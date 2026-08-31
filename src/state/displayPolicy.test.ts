/**
 * Display-policy regression tests for the Glance Bar scheduler.
 *
 * Each test maps to one of the six MVP display-policy rules from
 * `docs/product/MVP_LAUNCH_PLAN.md` (and the scenario matrix in
 * `docs/product/MVP_SCENARIO_MATRIX.md`). The scheduler is the pure policy
 * engine that makes visible behavior explainable: every assertion here encodes
 * a "the bar should show X when Y" contract that a manual walkthrough can
 * verify against the scenario matrix.
 *
 *   Rule 1 — Manual selection: pin for the preference window, then auto-return.
 *   Rule 2 — Download complete/fail: surface promptly, bounded, then return.
 *   Rule 3 — Focus session complete: surface clearly, offer the next action.
 *   Rule 4 — Media active, no higher priority: alternate media <-> resident.
 *   Rule 5 — Source unavailable/malformed: fallback/health, never misleading.
 *   Rule 6 — Fullscreen mode: respect the fullscreen-avoidance preference.
 *
 * Rules 1-5 are tested against the pure scheduler (`scheduleDesktopStatus`);
 * Rule 6's TS overlay state machine is tested here (its pure native core,
 * `compute_overlay_policy`, is unit-tested in `src-tauri/src/commands/system.rs`).
 */
import { strict as assert } from "node:assert";
import {
  createStatusWindowOverlayState,
  enforceStatusWindowOverlay,
  parseOverlayPolicy,
  STATUS_WINDOW_FLOATING_COMMAND,
  STATUS_WINDOW_OVERLAY_POLICY_COMMAND,
} from "@/runtime/window/statusWindowRuntime";
import { createProviderRegistry } from "@/providers/core/providerRegistry";
import { guestSourceQualityLabel } from "@/features/desktop/templates/GuestSourceHealthIndicator";
import { sourceQualityClassName, sourceQualityLabel } from "@/features/desktop/templates/ResidentStatusTemplate";
import type { TauriInvoke } from "@/runtime/tauri/tauriRuntime";
import type { HubProvider, HubProviderCapability } from "@/providers/core/types";

import {
  DESKTOP_STATUS_MEDIA_DURATION_MS,
  DESKTOP_STATUS_PREFERRED_WINDOW_MS,
  DESKTOP_STATUS_RESIDENT_DURATION_MS,
  scheduleDesktopStatus,
} from "./desktopStatusScheduler";

import { describe, it } from "vitest";

/**
 * Deterministic translation stub. The health-label helpers fall back to the
 * real i18n instance when no `t` is passed; passing our own keeps tests
 * independent of i18n initialization state.
 */
function stubT(key: string): string {
  return key;
}

describe("displayPolicy", () => {
  // ── Rule 1 — Manual selection: pin, then auto-return ─────────────────────
  describe("Rule 1: manual selection pins for the preference window, then auto-returns", () => {
    const now = 600_000;
    const available = ["resident", "media", "focus"];

    it("should pin the preferred kind even when higher-priority kinds are active", () => {
      // focus outranks media, but the user manually selected media.
      const decision = scheduleDesktopStatus({
        now,
        preferredKind: "media",
        preferredUntil: now - 10_000,
        activeKinds: ["focus", "update"],
        availableKinds: [...available, "update"],
      });

      assert.equal(decision.kind, "media");
      assert.equal(decision.reason, "preferred");
      assert.equal(decision.changed, true);
    });

    it("should keep the pinned kind when a higher-priority kind activates during the window", () => {
      // The whole point of manual selection: a newly activated focus session
      // must NOT yank the card away while the preference window is open.
      const decision = scheduleDesktopStatus({
        now,
        preferredKind: "media",
        preferredUntil: now - 10_000,
        activeKinds: ["media", "focus"],
        availableKinds: available,
        previousKind: "media",
        previousChangedAt: now - 5_000,
        activatedAtByKind: { media: now - 5_000, focus: now - 1_000 },
      });

      assert.equal(decision.kind, "media");
      assert.equal(decision.reason, "preferred");
      assert.equal(decision.changed, false);
    });

    it("should keep the pin at exactly the 80s boundary but release 1ms past it", () => {
      // The runtime sets preferredUntil = now + 20s; the scheduler treats
      // anything within 20s * 4 = 80s as still pinned (isWithinWindow is
      // inclusive of the far edge).
      const pinned = scheduleDesktopStatus({
        now,
        preferredKind: "media",
        preferredUntil: now - DESKTOP_STATUS_PREFERRED_WINDOW_MS * 4,
        activeKinds: ["focus"],
        availableKinds: available,
      });
      assert.equal(pinned.kind, "media");
      assert.equal(pinned.reason, "preferred");

      const expired = scheduleDesktopStatus({
        now,
        preferredKind: "media",
        preferredUntil: now - DESKTOP_STATUS_PREFERRED_WINDOW_MS * 4 - 1,
        activeKinds: ["focus"],
        availableKinds: available,
      });
      assert.equal(expired.kind, "focus");
      assert.equal(expired.reason, "priority");
    });

    it("should ignore a preferred kind that is not in the available set", () => {
      // download is not registered/available here, so the pin must not hold
      // and priority should resume.
      const decision = scheduleDesktopStatus({
        now,
        preferredKind: "download",
        preferredUntil: now - 10_000,
        activeKinds: ["focus", "media"],
        availableKinds: available,
      });

      assert.equal(decision.kind, "focus");
      assert.equal(decision.reason, "priority");
    });
  });

  // ── Rule 2 — Download complete/fail: surface promptly, return ────────────
  describe("Rule 2: a download surfaces promptly over media/resident, then returns", () => {
    const now = 700_000;
    const available = ["resident", "media", "download"];

    it("should surface a download over media and resident", () => {
      // Download outranks media and resident, so it surfaces promptly.
      const decision = scheduleDesktopStatus({
        now,
        activeKinds: ["media", "download", "resident"],
        availableKinds: available,
      });

      assert.equal(decision.kind, "download");
      assert.equal(decision.reason, "priority");
      assert.equal(decision.changed, true);
    });

    it("should preempt a currently-shown media card within the preemption window", () => {
      // Media has been shown for 1s; a download activates. Because download
      // outranks media and is within its 12s preemption window, it takes over.
      const decision = scheduleDesktopStatus({
        now,
        previousKind: "media",
        previousChangedAt: now - 1_000,
        activeKinds: ["media", "download"],
        availableKinds: available,
        activatedAtByKind: { media: now - 6_000, download: now - 2_000 },
      });

      assert.equal(decision.kind, "download");
      assert.equal(decision.changed, true);
    });

    it("should not outrank a higher-priority focus session", () => {
      const decision = scheduleDesktopStatus({
        now,
        activeKinds: ["focus", "download", "media"],
        availableKinds: ["resident", "media", "download", "focus"],
      });

      assert.equal(decision.kind, "focus");
    });

    it("should return to media when the download is removed and media was the previous card", () => {
      // Download completes and leaves the active set; the bar should move on
      // to the next useful state (media, which is still playing).
      const decision = scheduleDesktopStatus({
        now,
        previousKind: "media",
        previousChangedAt: now - 1_000,
        activeKinds: ["media"],
        availableKinds: available,
        activatedAtByKind: { media: now - 6_000 },
      });

      assert.equal(decision.kind, "media");
      assert.equal(decision.changed, false);
    });
  });

  // ── Rule 3 — Focus session complete: surface clearly, offer next action ──
  describe("Rule 3: focus surfaces above all and returns to the next state when it ends", () => {
    const now = 800_000;
    const available = ["resident", "media", "download", "focus", "notification"];

    it("should surface focus above download, media, and notification", () => {
      const decision = scheduleDesktopStatus({
        now,
        activeKinds: ["focus", "download", "media", "notification"],
        availableKinds: available,
      });

      assert.equal(decision.kind, "focus");
      assert.equal(decision.reason, "priority");
    });

    it("should not let any lower-priority kind preempt an active focus session", () => {
      // Focus has been active for 20s; download/media/notification all
      // activate. None outranks focus, so focus holds.
      const decision = scheduleDesktopStatus({
        now,
        previousKind: "focus",
        previousChangedAt: now - 1_000,
        activeKinds: ["focus", "download", "media", "notification"],
        availableKinds: available,
        activatedAtByKind: {
          focus: now - 20_000,
          download: now - 1_000,
          media: now - 1_000,
          notification: now - 1_000,
        },
      });

      assert.equal(decision.kind, "focus");
      assert.equal(decision.changed, false);
    });

    it("should return to the next highest-priority kind (download) when focus ends", () => {
      const decision = scheduleDesktopStatus({
        now,
        previousKind: "focus",
        previousChangedAt: now - 1_000,
        activeKinds: ["download", "media"],
        availableKinds: available,
        activatedAtByKind: { download: now - 5_000, media: now - 5_000 },
      });

      assert.equal(decision.kind, "download");
      assert.equal(decision.changed, true);
    });
  });

  // ── Rule 4 — Media active, no higher priority: alternate with resident ───
  describe("Rule 4: media alternates with resident only when no higher priority is active", () => {
    const available = ["resident", "media"];

    it("should alternate media (15s) and resident (8s) across full cycles", () => {
      const t0 = 900_000;
      const first = scheduleDesktopStatus({ now: t0, activeKinds: ["media", "resident"], availableKinds: available });
      assert.equal(first.kind, "media");
      assert.equal(first.changed, true);

      // Mid media window: keep media.
      const holdMedia = scheduleDesktopStatus({
        now: t0 + DESKTOP_STATUS_MEDIA_DURATION_MS - 1,
        activeKinds: ["media", "resident"],
        availableKinds: available,
        previousKind: "media",
        previousChangedAt: t0,
      });
      assert.equal(holdMedia.kind, "media");

      // After the 15s media window: flip to resident.
      const toResident = scheduleDesktopStatus({
        now: t0 + DESKTOP_STATUS_MEDIA_DURATION_MS + 100,
        activeKinds: ["media", "resident"],
        availableKinds: available,
        previousKind: "media",
        previousChangedAt: t0,
      });
      assert.equal(toResident.kind, "resident");
      assert.equal(toResident.changed, true);

      // After the 8s resident window: flip back to media.
      const backToMedia = scheduleDesktopStatus({
        now: t0 + DESKTOP_STATUS_MEDIA_DURATION_MS + DESKTOP_STATUS_RESIDENT_DURATION_MS + 200,
        activeKinds: ["media", "resident"],
        availableKinds: available,
        previousKind: "resident",
        previousChangedAt: t0 + DESKTOP_STATUS_MEDIA_DURATION_MS + 100,
      });
      assert.equal(backToMedia.kind, "media");
      assert.equal(backToMedia.changed, true);
    });

    it("should not flip the alternation mid-window", () => {
      const t0 = 900_000;
      const start = scheduleDesktopStatus({ now: t0, activeKinds: ["media", "resident"], availableKinds: available });
      const midWindow = scheduleDesktopStatus({
        now: t0 + 5_000,
        activeKinds: ["media", "resident"],
        availableKinds: available,
        previousKind: start.kind,
        previousChangedAt: t0,
      });
      assert.equal(midWindow.kind, start.kind);
      assert.equal(midWindow.changed, false);
    });

    it("should immediately interrupt alternation when a higher-priority kind activates", () => {
      const t0 = 900_000;
      // Media and resident are alternating; download (higher priority) activates.
      const decision = scheduleDesktopStatus({
        now: t0,
        activeKinds: ["media", "resident", "download"],
        availableKinds: ["resident", "media", "download"],
        previousKind: "media",
        previousChangedAt: t0 - 20_000,
        activatedAtByKind: { media: t0 - 20_000, resident: t0 - 10_000, download: t0 - 1_000 },
      });

      assert.equal(decision.kind, "download");
      assert.equal(decision.changed, true);
    });

    it("should not alternate when media is unavailable", () => {
      const t0 = 900_000;
      const decision = scheduleDesktopStatus({
        now: t0 + DESKTOP_STATUS_MEDIA_DURATION_MS + 1_000,
        activeKinds: ["media", "resident"],
        availableKinds: ["resident"],
        previousKind: "resident",
        previousChangedAt: t0,
      });

      assert.equal(decision.kind, "resident");
    });
  });

  // ── Rule 5 — Source unavailable/malformed: fallback/health, no misleading data
  describe("Rule 5: unavailable/malformed sources fall back and never show misleading live data", () => {
    const now = 1_000_000;

    it("should fall back to resident when the active kind is not available", () => {
      // download is active but not registered/available: the scheduler must
      // not present it and should fall back to the resident home.
      const decision = scheduleDesktopStatus({
        now,
        activeKinds: ["download"],
        availableKinds: ["resident", "media"],
      });

      assert.equal(decision.kind, "resident");
      assert.equal(decision.reason, "fallback");
    });

    it("should pick the highest-priority AVAILABLE active kind, filtering out unavailable ones", () => {
      // focus and developer are active but unavailable; media is the highest
      // active kind that is actually available.
      const decision = scheduleDesktopStatus({
        now,
        activeKinds: ["focus", "developer", "media"],
        availableKinds: ["resident", "media"],
      });

      assert.equal(decision.kind, "media");
      assert.equal(decision.reason, "priority");
    });

    it("should fall back to resident when nothing is active", () => {
      const decision = scheduleDesktopStatus({
        now,
        activeKinds: [],
        availableKinds: ["resident", "media", "download"],
      });

      assert.equal(decision.kind, "resident");
      assert.equal(decision.reason, "fallback");
    });

    it("should map each source quality to the correct health badge label", () => {
      assert.equal(guestSourceQualityLabel("native", stubT), "diagnostics.native");
      assert.equal(guestSourceQualityLabel("app-owned", stubT), "diagnostics.app");
      assert.equal(guestSourceQualityLabel("fixture", stubT), "diagnostics.fixture");
      assert.equal(guestSourceQualityLabel("mock", stubT), "diagnostics.mock");
      // unavailable and unknown qualities must read as "unavailable", never a
      // live/app label — this is the heart of Rule 5.
      assert.equal(guestSourceQualityLabel("unavailable", stubT), "diagnostics.unavailable");
      assert.equal(guestSourceQualityLabel(undefined, stubT), "diagnostics.unavailable");
    });

    it("should map resident performance quality to the correct label and class", () => {
      assert.equal(sourceQualityLabel("live", stubT), "diagnostics.live");
      assert.equal(sourceQualityLabel("stale", stubT), "diagnostics.stale");
      assert.equal(sourceQualityLabel("unavailable", stubT), "diagnostics.unavailable");
      assert.equal(sourceQualityClassName("live"), "is-live");
      assert.equal(sourceQualityClassName("stale"), "is-stale");
      assert.equal(sourceQualityClassName("unavailable"), "is-unavailable");
      // Unknown/fallback quality must render as fallback, never "live".
      assert.equal(sourceQualityClassName(undefined), "is-fallback");
      assert.equal(sourceQualityLabel(undefined, stubT), "diagnostics.fallback");
    });

    it("should not register an unsupported provider capability as available", () => {
      // Provider-honesty fix: providers that report support:"unsupported"
      // (e.g. the real git/docker/npm/update/download providers off their
      // supported platform) must not be treated as available sources, so the
      // scheduler never selects them and shows no misleading live data.
      const registry = createProviderRegistry();
      const cap: HubProviderCapability = { id: "download", kind: "download", origin: "real", support: "unsupported" };
      const provider: HubProvider = {
        id: "real-download-provider",
        label: "Real Download",
        metadata: { id: "real-download-provider", name: "Real Download", kind: "download", version: "1.0.0", mock: false },
        capabilities: [cap],
        start() {},
        stop() {},
        subscribe() {
          return () => {};
        },
        status: () => ({ lifecycle: "Started", health: "Healthy" }),
      };
      assert.equal(registry.register(provider).ok, true);

      const available = registry.listAvailableCapabilities();
      assert.equal(available.length, 0, "unsupported capability must not be listed as available");

      // Whereas an available capability IS listed.
      const availableCap: HubProviderCapability = { id: "media", kind: "media", origin: "real", support: "available" };
      const mediaProvider: HubProvider = {
        ...provider,
        id: "real-media-provider",
        label: "Real Media",
        metadata: { id: "real-media-provider", name: "Real Media", kind: "media", version: "1.0.0", mock: false },
        capabilities: [availableCap],
      };
      assert.equal(registry.register(mediaProvider).ok, true);
      assert.equal(registry.listAvailableCapabilities().length, 1);
    });
  });

  // ── Rule 6 — Fullscreen mode: respect the fullscreen-avoidance preference ─
  describe("Rule 6: the overlay state machine respects the fullscreen-avoidance preference", () => {
    // The native core `compute_overlay_policy(always_float, avoid_fullscreen, fullscreen)`
    // is unit-tested in src-tauri/src/commands/system.rs. Here we verify the TS
    // overlay state machine honors whatever that core decides: when the policy
    // says shouldFloat=false (fullscreen + avoidance on), the bar suppresses;
    // when shouldFloat=true, it floats.
    function invokeWithPolicy(
      policy: unknown,
      calls: Array<{ command: string; args?: Record<string, unknown> }>,
    ): TauriInvoke {
      return async (command, args) => {
        calls.push({ command, args });
        if (command === STATUS_WINDOW_OVERLAY_POLICY_COMMAND) {
          return policy;
        }
        return undefined;
      };
    }

    it("should suppress floating when the policy reports fullscreen + avoidance", async () => {
      const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
      const state = {
        appliedFloating: true,
        lastFloatingAppliedAt: 100,
        lastPositionCorrectionAt: 0,
        mode: "floating" as const,
        pendingInitialPositionCorrection: false,
        pendingRestorePositionCorrection: false,
        startupReassertPendingAt: [] as number[],
      };

      const policy = await enforceStatusWindowOverlay(state, {
        invoke: invokeWithPolicy({ foregroundFullscreen: true, shouldFloat: false }, calls),
        now: 700,
        positionCorrectionMs: Number.POSITIVE_INFINITY,
      });

      assert.equal(policy?.shouldFloat, false);
      assert.equal(state.mode, "suppressed_for_fullscreen");
      assert.equal(state.appliedFloating, false);
      // The floating command is invoked with floating:false to release topmost.
      const floatingCall = calls.find((c) => c.command === STATUS_WINDOW_FLOATING_COMMAND);
      assert.ok(floatingCall, "floating command should be invoked");
      assert.deepEqual(floatingCall?.args, { floating: false });
    });

    it("should float when the policy reports no fullscreen", async () => {
      const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
      const state = createStatusWindowOverlayState();

      const policy = await enforceStatusWindowOverlay(state, {
        invoke: invokeWithPolicy({ foregroundFullscreen: false, shouldFloat: true }, calls),
        now: 100,
        positionCorrectionMs: Number.POSITIVE_INFINITY,
      });

      assert.equal(policy?.shouldFloat, true);
      assert.equal(state.mode, "floating");
      assert.equal(state.appliedFloating, true);
    });

    it("should restore floating (with a position correction) after leaving fullscreen", async () => {
      const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
      const state = {
        appliedFloating: false,
        lastFloatingAppliedAt: 100,
        lastPositionCorrectionAt: 100,
        mode: "suppressed_for_fullscreen" as const,
        pendingInitialPositionCorrection: false,
        pendingRestorePositionCorrection: true,
        startupReassertPendingAt: [] as number[],
      };

      await enforceStatusWindowOverlay(state, {
        invoke: invokeWithPolicy({ foregroundFullscreen: false, shouldFloat: true }, calls),
        now: 300,
        topmostReassertMs: Number.POSITIVE_INFINITY,
        positionCorrectionMs: Number.POSITIVE_INFINITY,
      });

      assert.equal(state.mode, "floating");
      assert.equal(state.pendingRestorePositionCorrection, false);
    });

    it("should parse a fullscreen-avoidance policy payload", () => {
      assert.deepEqual(parseOverlayPolicy({ foregroundFullscreen: true, shouldFloat: false }), {
        foregroundFullscreen: true,
        shouldFloat: false,
      });
      // Legacy shouldFloat-only payload: foregroundFullscreen defaults to the
      // inverse of shouldFloat.
      assert.deepEqual(parseOverlayPolicy({ shouldFloat: true }), {
        foregroundFullscreen: false,
        shouldFloat: true,
      });
    });
  });
});
