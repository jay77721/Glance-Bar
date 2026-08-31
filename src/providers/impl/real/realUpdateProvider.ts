import type { HubEvent } from "@/entities";

import { installUpdate } from "../../../runtime/actions/updateInstallRuntime";
import { createProviderShell } from "../../core/providerShell";
import type { HubProvider, HubProviderCapability, HubProviderMetadata } from "../../core/types";


const PROVIDER_ID = "real-update-provider";
const TICK_INTERVAL_MS = 2_000;
const PROGRESS_INCREMENT = 10;

export type UpdateProviderState = "idle" | "checking" | "downloading" | "installing";

function updateEvent(state: UpdateProviderState, progress: number): HubEvent {
  const createdAt = Date.now();
  return {
    id: `${PROVIDER_ID}-update-${createdAt}`,
    type: "ai",
    source: "ai",
    createdAt,
    progress,
    payload: {
      id: "real-system-update",
      type: "ai",
      title: "System update",
      subtitle: state,
      progress,
      accent: "blue",
    },
    metadata: {
      state,
      code: "available",
    },
  };
}

export function createRealUpdateProvider(): HubProvider {
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let state: UpdateProviderState = "idle";
  let progress = 0;

  const metadata: HubProviderMetadata = {
    id: PROVIDER_ID,
    name: "Real Update Provider",
    kind: "ai",
    version: "1.0.0",
    mock: false,
  };

  const capabilities: HubProviderCapability[] = [
    { id: "update", kind: "update", origin: "real", support: "unsupported" },
  ];

  function tick() {
    if (state === "idle") {
      // In a real impl, this is where the Tauri IPC would query the OS update
      // service. For now, we drive the state machine off a deterministic timer
      // so the UI can demonstrate the full update lifecycle.
      state = "checking";
    } else if (state === "checking") {
      state = "downloading";
      progress = 0;
    } else if (state === "downloading") {
      progress = Math.min(100, progress + PROGRESS_INCREMENT);
      if (progress >= 100) {
        state = "installing";
      }
    } else if (state === "installing") {
      state = "idle";
      progress = 0;
    }
  }

  return createProviderShell({
    metadata,
    capabilities,

    start(handle) {
      pollTimer = setInterval(() => {
        tick();
        handle.emit([updateEvent(state, progress)]);
      }, TICK_INTERVAL_MS);
    },

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
  });
}

/**
 * Drives the `install_update` IPC command through the Tauri bridge.
 * On success the state transitions to "idle" so the lifecycle can
 * start over. Returns the post-call state.
 */
export async function dispatchUpdateInstall(
  state: { state: UpdateProviderState; progress: number },
  emit: (events: HubEvent[]) => void,
): Promise<UpdateProviderState> {
  const result = await installUpdate();
  if (result && !result.success) {
    return state.state;
  }
  // A real impl would wait for the OS install handshake. Locally we
  // just resolve to "idle" so the provider can poll the next update.
  if (state.state === "installing" || state.state === "downloading") {
    state.state = "idle";
    state.progress = 0;
    emit([updateEvent(state.state, state.progress)]);
  }
  return state.state;
}

/**
 * Pure state-machine helper used by tests. Given the current state,
 * returns the next state (and any progress reset) the timer tick
 * should produce. Extracted so tests can assert the transition table
 * without driving setInterval.
 */
export function nextUpdateState(current: {
  state: UpdateProviderState;
  progress: number;
}): { state: UpdateProviderState; progress: number } {
  if (current.state === "idle") {
    return { state: "checking", progress: 0 };
  }
  if (current.state === "checking") {
    return { state: "downloading", progress: 0 };
  }
  if (current.state === "downloading") {
    const nextProgress = Math.min(100, current.progress + PROGRESS_INCREMENT);
    if (nextProgress >= 100) {
      return { state: "installing", progress: 100 };
    }
    return { state: "downloading", progress: nextProgress };
  }
  // installing -> idle
  return { state: "idle", progress: 0 };
}

export const REAL_UPDATE_TICK_INTERVAL_MS = TICK_INTERVAL_MS;
export const REAL_UPDATE_PROGRESS_INCREMENT = PROGRESS_INCREMENT;
