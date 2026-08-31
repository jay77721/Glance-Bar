// ---------------------------------------------------------------------------
// Background monitors — clipboard (800ms) + focus assist (2s) polls.
// ---------------------------------------------------------------------------
// Owns the polling threads that emit status-center events. lib.rs calls
// these from its `setup` closure, passing the shared `Arc<AtomicBool>`
// shutdown flag.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

use crate::types::{ClipboardContent, DownloadFolderStatus, FocusAssistStatePayload, NotificationSummaryPayload};

const STATUS_CENTER_CLIPBOARD_EVENT: &str = "status-center://clipboard-changed";
const STATUS_CENTER_FOCUS_ASSIST_EVENT: &str = "status-center://focus-assist-changed";
const STATUS_CENTER_NOTIFICATION_EVENT: &str = "status-center://notifications-changed";
const FOCUS_ASSIST_MONITOR_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
const CLIPBOARD_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(800);
/// Spawns the clipboard polling thread. Every 800ms it reads the system
/// clipboard via `arboard` and emits a [`STATUS_CENTER_CLIPBOARD_EVENT`] when
/// non-empty text is detected. Exits its loop when `shutdown` is set.
pub fn start_clipboard_monitor(app_handle: tauri::AppHandle, shutdown: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return,
        };
        loop {
            std::thread::sleep(CLIPBOARD_POLL_INTERVAL);
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(text) = clipboard.get_text() {
                if !text.is_empty() {
                    let payload = ClipboardContent {
                        text,
                        source_app: String::new(),
                        copied_at: crate::unix_time_ms(),
                    };
                    let _ = app_handle.emit(STATUS_CENTER_CLIPBOARD_EVENT, &payload);
                }
            }
        }
    });
}

/// Spawns the focus-assist polling thread. Every 2s it reads the Windows
/// QuietHours registry state and emits [`STATUS_CENTER_FOCUS_ASSIST_EVENT`]
/// when active/profile changes, plus [`STATUS_CENTER_NOTIFICATION_EVENT`]
/// when the active flag toggles. Exits its loop when `shutdown` is set.
pub fn start_focus_monitor(app_handle: tauri::AppHandle, shutdown: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_focus_active = false;
        let mut last_profile = String::new();
        let mut last_notif_active = false;
        loop {
            std::thread::sleep(FOCUS_ASSIST_MONITOR_INTERVAL);
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            let focus_state: FocusAssistStatePayload =
                crate::commands::focus::read_focus_assist_state();
            if focus_state.active != last_focus_active || focus_state.profile != last_profile {
                last_focus_active = focus_state.active;
                last_profile = focus_state.profile.clone();
                let _ = app_handle.emit(STATUS_CENTER_FOCUS_ASSIST_EVENT, &focus_state);
            }
            if focus_state.active != last_notif_active {
                last_notif_active = focus_state.active;
                let summary = NotificationSummaryPayload {
                    focus_assist_active: focus_state.active,
                    checked_at: crate::unix_time_ms(),
                };
                let _ = app_handle.emit(STATUS_CENTER_NOTIFICATION_EVENT, &summary);
            }
        }
    });
}

/// Spawns the WinRT MTA media thread (Windows only) and registers its request
/// channel in Tauri state so `commands::media` handlers can route IPC requests
/// to it. No-op on other platforms.
#[cfg(windows)]
pub fn start_media_monitor(app_handle: &tauri::AppHandle, shutdown: Arc<AtomicBool>) {
    use tauri::Manager;

    if let Some(media_sender) = crate::media::start_mta_media_thread(app_handle.clone(), shutdown) {
        app_handle.manage(media_sender);
    }
}

/// Non-Windows stub — no media thread available.
#[cfg(not(windows))]
pub fn start_media_monitor(_app_handle: &tauri::AppHandle, _shutdown: Arc<AtomicBool>) {}

// ---------------------------------------------------------------------------
// Download folder monitor (Windows only).
// ---------------------------------------------------------------------------
// Polls the user's Downloads folder and emits a privacy-safe
// `STATUS_CENTER_DOWNLOAD_CHANGED` event when the set of in-progress
// downloads changes. "In-progress" = files with a browser temp extension
// (.part, .crdownload, .tmp, .download, .opdownload). Progress is a coarse,
// self-adapting estimate — no byte-level accuracy, and no file paths or names
// ever leave the native boundary.

const STATUS_CENTER_DOWNLOAD_CHANGED: &str = "status-center://download-changed";
const DOWNLOAD_MONITOR_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1000);
/// Progress is only re-emitted when it changes by at least this much, so a
/// near-complete download does not spam an event per poll.
const DOWNLOAD_PROGRESS_EMIT_THRESHOLD: u8 = 5;
const TEMP_DOWNLOAD_EXTENSIONS: &[&str] = &[".part", ".crdownload", ".tmp", ".download", ".opdownload"];

/// Resolve the user's Downloads folder. On Windows we use %USERPROFILE%;
/// falling back to the home dir keeps the helper robust to profile redirects.
pub(crate) fn downloads_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(profile).join("Downloads"));
        }
    }
    #[allow(deprecated)]
    std::env::home_dir().map(|home| home.join("Downloads"))
}

pub(crate) fn is_temp_download(name: &str) -> bool {
    let lower = name.to_lowercase();
    TEMP_DOWNLOAD_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Snapshot the Downloads folder: the in-progress downloads (name -> size),
/// the largest temp-file size (for coarse progress), and the total count.
pub(crate) fn scan_downloads(dir: &PathBuf) -> (HashMap<String, u64>, u64, u32) {
    let mut temps = HashMap::new();
    let mut largest_temp: u64 = 0;

    let entries = std::fs::read_dir(dir).into_iter().flatten();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_temp_download(&name) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > largest_temp {
            largest_temp = size;
        }
        temps.insert(name, size);
    }

    let count = temps.len() as u32;
    (temps, largest_temp, count)
}

/// Coarse, self-adapting progress estimate for a single download.
///
/// We do not know the final size from the filesystem alone, so we maintain a
/// per-file `expected_total` seeded to the first size we observe and only ever
/// revised upward when the file outgrows it. `progress = size / expected_total`
/// is therefore bounded in [0, 100] and climbs as the file grows past each
/// estimate. It is intentionally coarse: it is a rough gauge, not a byte-accurate
/// percentage, and is capped at 99 until a real completion is observed.
pub(crate) fn compute_progress(size: u64, expected_total: &mut u64) -> u8 {
    if size == 0 {
        return 0;
    }
    if *expected_total == 0 {
        *expected_total = size;
    }
    if size > *expected_total {
        *expected_total = size;
    }
    let progress = (size as f64 / *expected_total as f64) * 100.0;
    (progress as u8).min(99)
}

/// Spawns the download-folder polling thread (Windows only). Emits a
/// `STATUS_CENTER_DOWNLOAD_CHANGED` event when the download state changes:
/// going idle -> downloading, the active count changing, progress crossing the
/// coarse emit threshold, or a download completing.
#[cfg(windows)]
pub fn start_download_monitor(app_handle: tauri::AppHandle, shutdown: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let dir = match downloads_dir() {
            Some(dir) => dir,
            None => return,
        };

        let mut prev_status: &str = "idle";
        let mut prev_count: u32 = 0;
        let mut prev_progress: u8 = 0;
        let mut expected_total: u64 = 0;
        let mut prev_temps: HashMap<String, u64> = HashMap::new();

        loop {
            if shutdown.load(Ordering::Relaxed) {
                break;
            }

            let (temps, largest_temp, count) = scan_downloads(&dir);
            let now = crate::unix_time_ms();

            // Completion: we previously saw temp files and now there are none.
            let completed = !prev_temps.is_empty() && temps.is_empty();
            let status = if completed {
                "completed"
            } else if count > 0 {
                "downloading"
            } else {
                "idle"
            };
            let progress = compute_progress(largest_temp, &mut expected_total);

            let status_changed = status != prev_status;
            let count_changed = count != prev_count;
            let progress_changed =
                progress.abs_diff(prev_progress) >= DOWNLOAD_PROGRESS_EMIT_THRESHOLD;

            if status_changed || count_changed || progress_changed {
                let event = if completed {
                    // Emit a one-shot completion snapshot, then reset tracking so
                    // the next poll returns to idle without re-completing.
                    DownloadFolderStatus {
                        status,
                        active_downloads: 0,
                        progress: 100,
                        code: "available",
                        checked_at: now,
                    }
                } else {
                    DownloadFolderStatus {
                        status,
                        active_downloads: count,
                        progress,
                        code: "available",
                        checked_at: now,
                    }
                };
                let _ = app_handle.emit(STATUS_CENTER_DOWNLOAD_CHANGED, &event);

                prev_status = status;
                prev_count = count;
                prev_progress = progress;
            }

            if completed {
                // Reset completion tracking for the next download cycle.
                expected_total = 0;
                prev_temps = HashMap::new();
            } else {
                prev_temps = temps;
            }

            std::thread::sleep(DOWNLOAD_MONITOR_INTERVAL);
        }
    });
}

/// Non-Windows stub — download folder monitoring is unsupported off Windows.
#[cfg(not(windows))]
pub fn start_download_monitor(_app_handle: tauri::AppHandle, _shutdown: Arc<AtomicBool>) {}
