import type { HubEvent } from "@/entities";

import { sendDownloadControl, type DownloadAction } from "../../../runtime/actions/downloadControlRuntime";
import {
  getDownloadMonitorSupport,
  loadDownloadState,
  onDownloadChanged,
  type DownloadChangedPayload,
} from "../../../runtime/system/systemMonitorRuntime";
import { createProviderShell } from "../../core/providerShell";
import type { HubProvider, HubProviderCapability, HubProviderMetadata } from "../../core/types";


const PROVIDER_ID = "real-download-provider";

export type DownloadProviderStatus = "downloading" | "paused" | "cancelled" | "completed";

/**
 * Map a native {@link DownloadChangedPayload} to a download {@link HubEvent}.
 * Privacy-safe: the payload carries no file paths or names, only coarse status,
 * a rough progress percentage, and the active download count.
 */
function downloadPayloadToEvent(payload: DownloadChangedPayload): HubEvent {
  const createdAt = payload.checkedAt || Date.now();

  let title = "Downloads";
  let subtitle = "No active downloads";
  if (payload.status === "downloading") {
    title =
      payload.activeDownloads > 1
        ? `${payload.activeDownloads} downloads`
        : "Downloading";
    subtitle = "In progress";
  } else if (payload.status === "completed") {
    title = "Download complete";
    subtitle = "Saved to Downloads";
  }

  return {
    id: `${PROVIDER_ID}-download-${createdAt}`,
    type: "download",
    source: "download",
    createdAt,
    progress: payload.progress,
    payload: {
      id: "real-download-task",
      type: "download",
      title,
      subtitle,
      progress: payload.progress,
      accent: "green",
    },
    metadata: {
      status: payload.status,
      code: payload.code,
      activeDownloads: payload.activeDownloads,
    },
  };
}

export function createRealDownloadProvider(): HubProvider {
  let unlisten: (() => void) | undefined;

  const metadata: HubProviderMetadata = {
    id: PROVIDER_ID,
    name: "Real Download Provider",
    kind: "download",
    version: "1.0.0",
    mock: false,
  };

  // Real monitoring is Windows-only (MVP) and requires the Tauri runtime, so the
  // capability `support` fact reflects whether monitoring actually works here.
  const support = getDownloadMonitorSupport();

  const capabilities: HubProviderCapability[] = [
    { id: "download", kind: "download", origin: "real", support },
  ];

  return createProviderShell({
    metadata,
    capabilities,

    start(handle) {
      // If monitoring is unsupported on this platform there is nothing to watch;
      // leave the capability as "unsupported" and do not register a listener.
      if (support !== "available") {
        return;
      }

      // Seed the bar with the current state so we don't wait for the next change
      // event before reflecting an already-active download.
      loadDownloadState()
        .then((result) => {
          if (!result || result.status === "idle") {
            return;
          }
          handle.emit([downloadPayloadToEvent(result)]);
        })
        .catch(() => {
          // Initial fetch failed — non-critical, the listener below catches
          // future changes.
        });

      onDownloadChanged((payload) => {
        handle.emit([downloadPayloadToEvent(payload)]);
      })
        .then((unlistenFn) => {
          unlisten = unlistenFn;
        })
        .catch(() => {
          handle.markDegraded();
        });
    },

    stop() {
      unlisten?.();
      unlisten = undefined;
    },
  });
}

/**
 * Apply a user-initiated control action (pause / resume / cancel) to the
 * provider's local state. The Rust stub for these commands always succeeds;
 * we mirror that locally so the UI feedback stays consistent.
 *
 * Returns true when the action resulted in a state change.
 */
export function applyDownloadControl(
  state: { status: DownloadProviderStatus },
  action: DownloadAction,
): boolean {
  if (action === "pause") {
    if (state.status === "downloading") {
      state.status = "paused";
      return true;
    }
    return false;
  }
  if (action === "resume") {
    if (state.status === "paused") {
      state.status = "downloading";
      return true;
    }
    return false;
  }
  if (action === "cancel") {
    if (state.status === "cancelled" || state.status === "completed") {
      return false;
    }
    state.status = "cancelled";
    return true;
  }
  return false;
}

/**
 * Drives a user-initiated control action through the Tauri IPC bridge
 * and, on success, updates the provider's local state.
 */
export async function dispatchDownloadControl(
  state: { progress: number; status: DownloadProviderStatus },
  action: DownloadAction,
  emit: (events: HubEvent[]) => void,
): Promise<DownloadProviderStatus> {
  const result = await sendDownloadControl(action);
  if (result && !result.success) {
    return state.status;
  }
  const changed = applyDownloadControl(state, action);
  if (changed) {
    emit([downloadEvent(state.progress, state.status)]);
  }
  return state.status;
}

/**
 * Build a download {@link HubEvent} from local progress + status. Kept on its
 * own (rather than reusing {@link downloadPayloadToEvent}) so control-driven
 * emissions retain the provider's locally tracked progress value.
 */
function downloadEvent(progress: number, status: DownloadProviderStatus): HubEvent {
  const createdAt = Date.now();
  return {
    id: `${PROVIDER_ID}-download-${createdAt}`,
    type: "download",
    source: "download",
    createdAt,
    progress,
    payload: {
      id: "real-download-task",
      type: "download",
      title: "Active download",
      subtitle: "from real provider",
      progress,
      accent: "green",
    },
    metadata: {
      status,
      code: "available",
    },
  };
}
