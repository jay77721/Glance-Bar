/**
 * Pure resolver snapshot path for desktop status scheduling.
 *
 * This module is the **resolver snapshot path**: a pure function called once
 * per React render from `src/state/desktopStatusState.ts` (the resolver). It
 * takes a snapshot of inputs (`activeKinds`, `availableKinds`, `preferredKind`,
 * `previousKind`, `previousChangedAt`, `now`) and returns a deterministic
 * `ScheduleDecision` with no side effects and no subscriptions.
 *
 * It is paired with `src/runtime/scheduler/schedulerService.ts`, which is the **hook
 * event path**: a stateful service started inside `useEffect` in
 * `src/features/desktop/hooks/useDesktopStatusRuntime.ts`. The hook service
 * drives the wall-clock heartbeat for the 15s media/resident alternation.
 *
 * The two implementations share ~90% of their decision logic and must stay
 * in sync. See the decision record for the rationale and stop conditions:
 *
 *   docs/decisions/v0.8_DESKTOP_STATUS_SCHEDULER_DUALITY_DECISION.md
 */

import type {
  DesktopStatusKind,
  DesktopStatusScheduleDecision,
  DesktopStatusSchedulerInput,
} from "@/entities";
import { DESKTOP_STATUS_PRIORITY_ORDER } from "@/entities/status/config";

import { dedupeKindsOrEmpty } from "../shared/lib/runtimeGuards";

export const DESKTOP_STATUS_FALLBACK_KIND: DesktopStatusKind = "resident";
export const DESKTOP_STATUS_STABILITY_WINDOW_MS = 6_000;
export const DESKTOP_STATUS_PREFERRED_WINDOW_MS = 20_000;
export const DESKTOP_STATUS_PREEMPTION_WINDOW_MS = 12_000;

/** How long the bar shows the media state during the alternation cycle. */
export const DESKTOP_STATUS_MEDIA_DURATION_MS = 15_000;

/** How long the bar shows the resident state during the alternation cycle. */
export const DESKTOP_STATUS_RESIDENT_DURATION_MS = 8_000;

function isWithinWindow(timestamp: number | undefined, now: number, durationMs: number): boolean {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return false;
  }

  return timestamp <= now && now - timestamp <= durationMs;
}

function filterKnownKinds(kinds: DesktopStatusKind[] | undefined): DesktopStatusKind[] {
  if (!kinds?.length) {
    return [];
  }

  return kinds.filter((kind) => DESKTOP_STATUS_PRIORITY_ORDER.includes(kind));
}

export function getDesktopStatusPriorityOrder(): DesktopStatusKind[] {
  return [...DESKTOP_STATUS_PRIORITY_ORDER];
}

export function scheduleDesktopStatus(
  input: DesktopStatusSchedulerInput,
): DesktopStatusScheduleDecision {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : 0;
  const availableKinds = filterKnownKinds(dedupeKindsOrEmpty(input.availableKinds));
  const preferredKind = input.preferredKind;
  const previousKind = input.previousKind;
  const activeKinds = filterKnownKinds(dedupeKindsOrEmpty(input.activeKinds));
  const activeAvailableKinds = activeKinds.filter((kind) => availableKinds.includes(kind));
  const preferredStillPinned =
    preferredKind &&
    availableKinds.includes(preferredKind) &&
    isWithinWindow(input.preferredUntil, now, DESKTOP_STATUS_PREFERRED_WINDOW_MS * 4);

  const initialDecision =
    preferredKind && availableKinds.includes(preferredKind) && preferredStillPinned
      ? {
          kind: preferredKind as DesktopStatusKind,
          reason: "preferred" as const,
          changed: preferredKind !== previousKind,
        }
      : (() => {
          // Special case: the asymmetric media/resident alternation cycle
          // (8s resident ↔ 15s media) drives what to show when both kinds
          // are available and active AND no higher-priority kind
          // (focus/update/notification/download) is active.
          //
          // We let the alternation function (below) drive the actual
          // selection, but we need to NOT let the priority loop /
          // previousKind stability branch swallow it. The strategy:
          //  - If there's no previous decision, force "media" to start.
          //  - If there IS a previous decision, return the unchanged
          //    previousKind so the alternation function (which is called
          //    right after this IIFE) can decide whether to flip.
          //
          // Without this carve-out the priority loop below would either
          // always pick "resident" (it sits at the bottom of
          // DESKTOP_STATUS_PRIORITY_ORDER) or hold the previous kind via
          // the 6s stability window — both of which prevent the
          // 8s/15s cadence from ever being observed.
          if (
            shouldConsiderMediaResidentAlternation(activeKinds, availableKinds) &&
            !activeAvailableKinds.some((kind) => {
              const priority = DESKTOP_STATUS_PRIORITY_ORDER.indexOf(kind);
              return priority !== -1 && priority < DESKTOP_STATUS_PRIORITY_ORDER.indexOf("media");
            })
          ) {
            if (previousKind === undefined) {
              return {
                kind: "media" as DesktopStatusKind,
                reason: "priority" as const,
                changed: true,
              };
            }
            // Only the media/resident pair participates in the alternation
            // cycle below. The alternation function only flips between those
            // two kinds, so deferring to it is only correct when the previous
            // kind is one of them. For any other previous kind (e.g. a
            // download that just finished and left the active set), fall
            // through to the normal priority/stability logic below rather
            // than holding a stale, no-longer-active kind.
            if (previousKind === "media" || previousKind === "resident") {
              // Defer to the alternation function below. Return the same
              // kind we showed last so the alternation function can
              // compute a flip without us pre-empting it.
              return {
                kind: previousKind,
                reason: "priority" as const,
                changed: false,
              };
            }
          }

          const previousStillStable =
            previousKind &&
            activeAvailableKinds.includes(previousKind) &&
            isWithinWindow(input.previousChangedAt, now, DESKTOP_STATUS_STABILITY_WINDOW_MS);

          if (previousStillStable) {
            const previousPriority = DESKTOP_STATUS_PRIORITY_ORDER.indexOf(previousKind);
            const canPreemptPrevious = activeAvailableKinds.some((kind) => {
              const priority = DESKTOP_STATUS_PRIORITY_ORDER.indexOf(kind);
              const activatedAt = input.activatedAtByKind?.[kind];
              return (
                priority !== -1 &&
                priority < previousPriority &&
                isWithinWindow(activatedAt, now, DESKTOP_STATUS_PREEMPTION_WINDOW_MS)
              );
            });

            if (!canPreemptPrevious) {
              return {
                kind: previousKind,
                reason: "priority" as const,
                changed: false,
              };
            }
          }

          for (const kind of DESKTOP_STATUS_PRIORITY_ORDER) {
            if (activeAvailableKinds.includes(kind)) {
              return {
                kind,
                reason: "priority" as const,
                changed: kind !== previousKind,
              };
            }
          }

          if (availableKinds.includes(DESKTOP_STATUS_FALLBACK_KIND)) {
            return {
              kind: DESKTOP_STATUS_FALLBACK_KIND,
              reason: "fallback" as const,
              changed: DESKTOP_STATUS_FALLBACK_KIND !== previousKind,
            };
          }

          const firstKnownAvailableKind = availableKinds[0];
          if (firstKnownAvailableKind) {
            return {
              kind: firstKnownAvailableKind,
              reason: "fallback" as const,
              changed: firstKnownAvailableKind !== previousKind,
            };
          }

          return {
            kind: DESKTOP_STATUS_FALLBACK_KIND,
            reason: "fallback" as const,
            changed: DESKTOP_STATUS_FALLBACK_KIND !== previousKind,
          };
        })();

  const alternateKind = shouldAlternateMediaWithResident({
    kind: initialDecision.kind,
    now,
    previousChangedAt: input.previousChangedAt,
    activeKinds,
    availableKinds,
    previousKind: input.previousKind,
  });

  if (alternateKind !== initialDecision.kind) {
    return {
      kind: alternateKind,
      reason: initialDecision.reason,
      changed: alternateKind !== input.previousKind,
    };
  }

  return initialDecision;
}

/**
 * Returns true when both `media` and `resident` are available + active — the
 * preconditions for the asymmetric media/resident alternation cycle. This is
 * the canonical helper used by the scheduler AND by callers who want to know
 * whether the alternation policy applies.
 */
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

/**
 * Alternates the visible kind between "media" and "resident" when both are
 * available and at least one is active. The cycle is asymmetric on purpose:
 * media is shown for `DESKTOP_STATUS_MEDIA_DURATION_MS` (15s) and resident
 * for `DESKTOP_STATUS_RESIDENT_DURATION_MS` (8s), so a playing session gets
 * more dwell time on the media card without making the resident capsule
 * feel abandoned. While a media session is live the bar shows media 15s,
 * resident 8s, media 15s, resident 8s, etc.
 *
 * Skips alternation when:
 *  - Either kind is unavailable or inactive
 *  - The current kind is something other than media/resident (focus,
 *    download, notification, etc. always win)
 *  - We are inside the elapsed window since the previous change
 *    (prevents mid-window thrash from minor metric/clipboard noise)
 */
export function shouldAlternateMediaWithResident({
  kind,
  now,
  previousChangedAt,
  activeKinds,
  availableKinds,
  previousKind,
}: {
  kind: DesktopStatusKind;
  now: number;
  previousChangedAt: number | undefined;
  activeKinds: DesktopStatusKind[];
  availableKinds: DesktopStatusKind[];
  previousKind?: DesktopStatusKind;
}): DesktopStatusKind {
  const bothAvailable = availableKinds.includes("media") && availableKinds.includes("resident");
  const eitherActive = activeKinds.includes("media") || activeKinds.includes("resident");

  if (!bothAvailable || !eitherActive) {
    return kind;
  }

  if (kind !== "media" && kind !== "resident") {
    return kind;
  }

  // First call after the scheduler starts (no previous change yet): keep
  // the initial kind. The next render with elapsed time will drive the
  // alternation.
  if (previousChangedAt === undefined) {
    return kind;
  }

  // The alternation window is keyed on the kind the bar is CURRENTLY
  // showing (passed in as `kind`). If the current kind has been on
  // screen for its full duration, flip to the opposite.
  //
  // - If `kind === "media"`, the current 15s media window has elapsed
  //   → flip to resident (will be shown for 8s).
  // - If `kind === "resident"`, the current 8s resident window has
  //   elapsed → flip to media (will be shown for 15s).
  const currentWindowMs =
    kind === "media" ? DESKTOP_STATUS_MEDIA_DURATION_MS : DESKTOP_STATUS_RESIDENT_DURATION_MS;

  if (!Number.isFinite(previousChangedAt) || now - previousChangedAt < currentWindowMs) {
    return kind;
  }

  // Flip to the opposite.
  const flipped = kind === "media" ? ("resident" as const) : ("media" as const);
  // We don't need previousKind here, but the parameter is kept for
  // backwards-compatible signature in case future logic needs it.
  void previousKind;
  return flipped;
}
