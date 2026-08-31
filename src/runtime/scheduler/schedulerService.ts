/**
 * Stateful hook event path for desktop status scheduling.
 *
 * This module is the **hook event path**: a stateful service started inside
 * `useEffect` in `src/features/desktop/hooks/useDesktopStatusRuntime.ts`. It
 * holds the current `ScheduleDecision` across React renders and notifies
 * subscribers when the decision changes. It drives the wall-clock heartbeat
 * (250ms `setInterval`) that powers the 15s media/resident alternation.
 *
 * It is paired with `src/state/desktopStatusScheduler.ts`, which is the
 * **resolver snapshot path**: a pure function called once per React render
 * from `src/state/desktopStatusState.ts` (the resolver). The resolver
 * computes a single decision from a snapshot of inputs.
 *
 * The two implementations share ~90% of their decision logic and must stay
 * in sync. See the decision record for the rationale and stop conditions:
 *
 *   docs/decisions/v0.8_DESKTOP_STATUS_SCHEDULER_DUALITY_DECISION.md
 */

import type { DesktopStatusKind } from "@/entities";
import { DESKTOP_STATUS_PRIORITY_ORDER } from "@/entities/status/config";

import { dedupeKindsOrEmpty } from "../../shared/lib/runtimeGuards";

export const DESKTOP_STATUS_FALLBACK_KIND: DesktopStatusKind = "resident";
export const DESKTOP_STATUS_STABILITY_WINDOW_MS = 6_000;
export const DESKTOP_STATUS_PREFERRED_WINDOW_MS = 20_000;
export const DESKTOP_STATUS_PREEMPTION_WINDOW_MS = 12_000;

export const DESKTOP_STATUS_MEDIA_DURATION_MS = 15_000;
export const DESKTOP_STATUS_RESIDENT_DURATION_MS = 8_000;

const CLIPBOARD_DISPLAY_WINDOW_MS = 5_000;

export type ScheduleDecision = {
  kind: DesktopStatusKind;
  changed: boolean;
};

type ScheduleState = {
  currentKind: DesktopStatusKind;
  changedAt: number;
  activeKinds: DesktopStatusKind[];
  availableKinds: DesktopStatusKind[];
  preferredKind?: DesktopStatusKind;
  preferredUntil?: number;
  activatedAtByKind: Partial<Record<DesktopStatusKind, number>>;
  clipboardStartedAt?: number;
  clipboardCopiedAt?: number;
};

type Listener = (decision: ScheduleDecision) => void;

function isWithinWindow(timestamp: number | undefined, now: number, durationMs: number): boolean {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp <= now && now - timestamp <= durationMs;
}

function shouldConsiderMediaResidentAlternation(
  activeKinds: DesktopStatusKind[],
  availableKinds: DesktopStatusKind[],
): boolean {
  return (
    availableKinds.includes("media") &&
    availableKinds.includes("resident") &&
    (activeKinds.includes("media") || activeKinds.includes("resident"))
  );
}

function shouldAlternateMediaWithResident(
  kind: DesktopStatusKind,
  now: number,
  previousChangedAt: number | undefined,
  activeKinds: DesktopStatusKind[],
  availableKinds: DesktopStatusKind[],
): DesktopStatusKind {
  const bothAvailable = availableKinds.includes("media") && availableKinds.includes("resident");
  const eitherActive = activeKinds.includes("media") || activeKinds.includes("resident");

  if (!bothAvailable || !eitherActive) {
    return kind;
  }

  if (kind !== "media" && kind !== "resident") {
    return kind;
  }

  if (previousChangedAt === undefined) {
    return kind;
  }

  const currentWindowMs =
    kind === "media" ? DESKTOP_STATUS_MEDIA_DURATION_MS : DESKTOP_STATUS_RESIDENT_DURATION_MS;

  if (!Number.isFinite(previousChangedAt) || now - previousChangedAt < currentWindowMs) {
    return kind;
  }

  return kind === "media" ? "resident" : "media";
}

function filterKnownKinds(kinds: DesktopStatusKind[] | undefined): DesktopStatusKind[] {
  if (!kinds?.length) {
    return [];
  }
  return kinds.filter((kind) => DESKTOP_STATUS_PRIORITY_ORDER.includes(kind));
}

export function createSchedulerService() {
  const state: ScheduleState = {
    currentKind: DESKTOP_STATUS_FALLBACK_KIND,
    changedAt: Date.now(),
    activeKinds: [],
    availableKinds: [],
    activatedAtByKind: {},
    clipboardCopiedAt: undefined,
    clipboardStartedAt: undefined,
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<Listener>();
  let hasEverShownMedia = false;

  function notifyAll(decision: ScheduleDecision) {
    listeners.forEach((l) => l(decision));
  }

  function computeDecision(now: number): ScheduleDecision {
    const availableKinds = filterKnownKinds(dedupeKindsOrEmpty(state.availableKinds));
    const activeKinds = filterKnownKinds(dedupeKindsOrEmpty(state.activeKinds));
    const activeAvailableKinds = activeKinds.filter((kind) => availableKinds.includes(kind));

    const clipboardExpired =
      state.clipboardStartedAt !== undefined &&
      now - state.clipboardStartedAt >= CLIPBOARD_DISPLAY_WINDOW_MS;

    const effectiveActiveKinds = clipboardExpired
      ? activeAvailableKinds.filter((k) => k !== "clipboard")
      : activeAvailableKinds;

    const preferredStillPinned =
      state.preferredKind &&
      availableKinds.includes(state.preferredKind) &&
      isWithinWindow(state.preferredUntil, now, DESKTOP_STATUS_PREFERRED_WINDOW_MS * 4);

    if (state.preferredKind && availableKinds.includes(state.preferredKind) && preferredStillPinned) {
      return {
        kind: state.preferredKind,
        changed: state.preferredKind !== state.currentKind,
      };
    }

    if (
      shouldConsiderMediaResidentAlternation(effectiveActiveKinds, availableKinds) &&
      !effectiveActiveKinds.some((kind) => {
        const priority = DESKTOP_STATUS_PRIORITY_ORDER.indexOf(kind);
        return priority !== -1 && priority < DESKTOP_STATUS_PRIORITY_ORDER.indexOf("media");
      })
    ) {
      if (!hasEverShownMedia) {
        hasEverShownMedia = true;
        return { kind: "media", changed: "media" !== state.currentKind };
      }
      // Only the media/resident pair participates in the alternation cycle.
      // shouldAlternateMediaWithResident only flips between those two kinds,
      // so deferring to it is only correct when the current kind is one of
      // them. For any other current kind (e.g. a download that just finished
      // and left the active set), fall through to the normal priority/stability
      // logic below rather than holding a stale, no-longer-active kind.
      if (state.currentKind === "media" || state.currentKind === "resident") {
        const alternated = shouldAlternateMediaWithResident(
          state.currentKind,
          now,
          state.changedAt,
          effectiveActiveKinds,
          availableKinds,
        );
        return {
          kind: alternated,
          changed: alternated !== state.currentKind,
        };
      }
    }

    const previousStillStable =
      state.currentKind &&
      effectiveActiveKinds.includes(state.currentKind) &&
      isWithinWindow(state.changedAt, now, DESKTOP_STATUS_STABILITY_WINDOW_MS);

    if (previousStillStable) {
      const previousPriority = DESKTOP_STATUS_PRIORITY_ORDER.indexOf(state.currentKind);
      const canPreemptPrevious = effectiveActiveKinds.some((kind) => {
        const priority = DESKTOP_STATUS_PRIORITY_ORDER.indexOf(kind);
        const activatedAt = state.activatedAtByKind[kind];
        return (
          priority !== -1 &&
          priority < previousPriority &&
          isWithinWindow(activatedAt, now, DESKTOP_STATUS_PREEMPTION_WINDOW_MS)
        );
      });

      if (!canPreemptPrevious) {
        return { kind: state.currentKind, changed: false };
      }
    }

    for (const kind of DESKTOP_STATUS_PRIORITY_ORDER) {
      if (effectiveActiveKinds.includes(kind)) {
        return { kind, changed: kind !== state.currentKind };
      }
    }

    if (availableKinds.includes(DESKTOP_STATUS_FALLBACK_KIND)) {
      return {
        kind: DESKTOP_STATUS_FALLBACK_KIND,
        changed: DESKTOP_STATUS_FALLBACK_KIND !== state.currentKind,
      };
    }

    const firstKnownAvailableKind = availableKinds[0];
    if (firstKnownAvailableKind) {
      return { kind: firstKnownAvailableKind, changed: firstKnownAvailableKind !== state.currentKind };
    }

    return { kind: DESKTOP_STATUS_FALLBACK_KIND, changed: DESKTOP_STATUS_FALLBACK_KIND !== state.currentKind };
  }

  function tick() {
    const now = Date.now();
    const decision = computeDecision(now);
    if (decision.changed) {
      state.currentKind = decision.kind;
      state.changedAt = now;
      notifyAll(decision);
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, 250);
  }

  function stop() {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  function updateKinds(active: DesktopStatusKind[], available: DesktopStatusKind[]) {
    state.activeKinds = active;
    state.availableKinds = available;

    const now = Date.now();
    for (const kind of active) {
      if (state.activatedAtByKind[kind] === undefined) {
        state.activatedAtByKind[kind] = now;
      }
    }
    for (const kind of Object.keys(state.activatedAtByKind) as DesktopStatusKind[]) {
      if (!active.includes(kind)) {
        delete state.activatedAtByKind[kind];
      }
    }

    if (active.includes("clipboard") && state.clipboardStartedAt === undefined) {
      state.clipboardStartedAt = now;
    }
    if (!active.includes("clipboard")) {
      state.clipboardStartedAt = undefined;
    }

    const decision = computeDecision(now);
    if (decision.changed) {
      state.currentKind = decision.kind;
      state.changedAt = now;
      notifyAll(decision);
    }
  }

  function setPreferred(kind: DesktopStatusKind, until: number) {
    state.preferredKind = kind;
    state.preferredUntil = until;
    tick();
  }

  function clearPreferred() {
    state.preferredKind = undefined;
    state.preferredUntil = undefined;
    tick();
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getSnapshot(): { kind: DesktopStatusKind; changedAt: number } {
    return { kind: state.currentKind, changedAt: state.changedAt };
  }

  return { start, stop, updateKinds, setPreferred, clearPreferred, subscribe, getSnapshot };
}

export type SchedulerService = ReturnType<typeof createSchedulerService>;
