import { listen } from "@tauri-apps/api/event";

import { getTauriInvoke, type TauriInvoke } from "../tauri/tauriRuntime";

const FOCUS_ASSIST_COMMAND = "get_focus_assist_state";
const NOTIFICATION_SUMMARY_COMMAND = "get_notification_summary";

export const FOCUS_ASSIST_CHANGED_EVENT = "status-center://focus-assist-changed";
export const NOTIFICATIONS_CHANGED_EVENT = "status-center://notifications-changed";
export const CLIPBOARD_CHANGED_EVENT = "status-center://clipboard-changed";
export const MEDIA_SESSION_CHANGED_EVENT = "status-center://media-session-changed";
export const DOWNLOAD_CHANGED_EVENT = "status-center://download-changed";

export type FocusAssistState = {
  active: boolean;
  profile: string;
  checkedAt: number;
};

export type NotificationSummary = {
  focusAssistActive: boolean;
  checkedAt: number;
};

export type ClipboardChangedPayload = {
  text: string;
  sourceApp: string;
  copiedAt: number;
};

export type MediaSessionChangedPayload = {
  available: boolean;
  playbackStatus: "playing" | "paused" | "unavailable" | "unsupported";
  progress: number;
  positionMs?: number;
  durationMs?: number;
  title?: string;
  artist?: string;
  code: string;
  checkedAt: number;
};

export type DownloadChangedPayload = {
  status: "downloading" | "completed" | "idle";
  activeDownloads: number;
  progress: number;
  code: "available" | "unsupported" | "error";
  checkedAt: number;
};

export const DOWNLOAD_STATE_COMMAND = "get_download_state";

export async function getFocusAssistState(
  invoke: TauriInvoke | undefined = getTauriInvoke(),
): Promise<FocusAssistState | undefined> {
  if (!invoke) {
    return undefined;
  }

  try {
    const result = await invoke(FOCUS_ASSIST_COMMAND);
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      return {
        active: record.active === true,
        profile: typeof record.profile === "string" ? record.profile : "",
        checkedAt: typeof record.checkedAt === "number" ? record.checkedAt : Date.now(),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function getNotificationSummary(
  invoke: TauriInvoke | undefined = getTauriInvoke(),
): Promise<NotificationSummary | undefined> {
  if (!invoke) {
    return undefined;
  }

  try {
    const result = await invoke(NOTIFICATION_SUMMARY_COMMAND);
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      return {
        focusAssistActive: record.focusAssistActive === true,
        checkedAt: typeof record.checkedAt === "number" ? record.checkedAt : Date.now(),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function onFocusAssistChanged(
  handler: (state: FocusAssistState) => void,
): Promise<() => void> {
  return listen<FocusAssistState>(FOCUS_ASSIST_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

export function onNotificationsChanged(
  handler: (summary: NotificationSummary) => void,
): Promise<() => void> {
  return listen<NotificationSummary>(NOTIFICATIONS_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

export function onClipboardChanged(
  handler: (content: ClipboardChangedPayload) => void,
): Promise<() => void> {
  return listen<ClipboardChangedPayload>(CLIPBOARD_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

export function onMediaSessionChanged(
  handler: (status: MediaSessionChangedPayload) => void,
): Promise<() => void> {
  return listen<MediaSessionChangedPayload>(MEDIA_SESSION_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

/**
 * Whether real download folder monitoring is available in this environment.
 *
 * Monitoring is Windows-only for the MVP and requires the Tauri native runtime
 * (no runtime => we are outside the desktop app, e.g. a plain browser dev server).
 * The provider uses this to set its capability `support` fact: "available" only
 * when real monitoring works, "unsupported" otherwise (cross-platform stub).
 */
export function getDownloadMonitorSupport(): "available" | "unsupported" {
  if (!getTauriInvoke()) {
    return "unsupported";
  }
  if (typeof navigator !== "undefined" && /Win/.test(navigator.platform)) {
    return "available";
  }
  return "unsupported";
}

export function onDownloadChanged(
  handler: (status: DownloadChangedPayload) => void,
): Promise<() => void> {
  return listen<DownloadChangedPayload>(DOWNLOAD_CHANGED_EVENT, (event) => {
    handler(event.payload);
  });
}

/**
 * Maps a raw `get_download_state` invoke result into a
 * {@link DownloadChangedPayload}, or undefined when the payload is malformed.
 */
export function parseDownloadChangedPayload(
  value: unknown,
): DownloadChangedPayload | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.status !== "downloading" && record.status !== "completed" && record.status !== "idle") ||
    typeof record.activeDownloads !== "number" ||
    typeof record.progress !== "number" ||
    typeof record.code !== "string" ||
    typeof record.checkedAt !== "number"
  ) {
    return undefined;
  }
  return {
    status: record.status,
    activeDownloads: record.activeDownloads,
    progress: Math.max(0, Math.min(100, Math.round(record.progress))),
    code: record.code as DownloadChangedPayload["code"],
    checkedAt: record.checkedAt,
  };
}

/**
 * One-shot fetch of the current download folder state (mirrors
 * `loadTauriMediaSessionStatus`). Used to seed the provider on start so the
 * bar does not wait for the next change event.
 */
export async function loadDownloadState(
  invoke: TauriInvoke | undefined = getTauriInvoke(),
): Promise<DownloadChangedPayload | undefined> {
  if (!invoke) {
    return undefined;
  }
  try {
    const result = await invoke(DOWNLOAD_STATE_COMMAND);
    return parseDownloadChangedPayload(result);
  } catch {
    return undefined;
  }
}
