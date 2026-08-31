// ---------------------------------------------------------------------------
// System performance, overlay policy, autostart, and stub commands.
// ---------------------------------------------------------------------------

use crate::clamp_percent;
use crate::types::{
    DownloadControlResult, DownloadFolderStatus, OverlayPolicy, SharedDesktopProductState,
    SystemPerformanceSnapshot,
};
use std::collections::HashMap;
use std::path::PathBuf;
use sysinfo::{Networks, System};
use tauri::State;

#[tauri::command]
pub async fn get_system_performance(
    state: State<'_, SharedDesktopProductState<tauri::Wry>>,
) -> Result<SystemPerformanceSnapshot, String> {
    let (cpu, memory) = tauri::async_runtime::spawn_blocking(|| {
        let mut system = System::new_all();

        system.refresh_cpu();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        system.refresh_cpu();
        system.refresh_memory();

        let cpu = clamp_percent(system.global_cpu_info().cpu_usage() as f64);
        let memory = if system.total_memory() == 0 {
            0
        } else {
            clamp_percent((system.used_memory() as f64 / system.total_memory() as f64) * 100.0)
        };

        (cpu, memory)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    let (download_speed, upload_speed) = sample_network_speeds(&state);

    Ok(SystemPerformanceSnapshot {
        cpu,
        memory,
        download_speed,
        upload_speed,
    })
}

#[tauri::command]
pub fn get_overlay_policy(
    state: State<'_, SharedDesktopProductState<tauri::Wry>>,
) -> OverlayPolicy {
    let foreground_fullscreen = crate::commands::window::foreground_window_is_fullscreen();
    let (always_float, avoid_fullscreen) = state
        .lock()
        .map(|state| (state.preferences.always_float, state.preferences.avoid_fullscreen))
        .unwrap_or((true, true));
    let should_float =
        compute_overlay_policy(always_float, avoid_fullscreen, foreground_fullscreen);

    OverlayPolicy {
        foreground_fullscreen,
        should_float,
    }
}

/// Pure policy core so the always-float / avoid-fullscreen / fullscreen truth
/// table is unit-testable without a live Tauri state or a foreground window.
///
/// `should_float` (drive the window topmost) is only true when the user wants
/// the bar to float at all (`always_float`). On top of that, fullscreen
/// avoidance suppresses floating while a foreground window covers a monitor.
pub(crate) fn compute_overlay_policy(
    always_float: bool,
    avoid_fullscreen: bool,
    foreground_fullscreen: bool,
) -> bool {
    if !always_float {
        return false;
    }
    if avoid_fullscreen {
        !foreground_fullscreen
    } else {
        true
    }
}

// ---------------------------------------------------------------------------
// Network speed sampling — delta-based rate measurement between invocations.
// ---------------------------------------------------------------------------
pub(crate) fn sample_network_speeds(state: &SharedDesktopProductState<tauri::Wry>) -> (u64, u64) {
    let now = std::time::Instant::now();
    let mut download_bps: u64 = 0;
    let mut upload_bps: u64 = 0;

    if let Ok(mut guard) = state.lock() {
        let cache = &mut guard.perf_cache;

        let networks = cache
            .networks
            .get_or_insert_with(Networks::new_with_refreshed_list);
        networks.refresh();

        let received_bytes: u64 = networks.values().map(|data| data.received()).sum();
        let transmitted_bytes: u64 = networks.values().map(|data| data.transmitted()).sum();

        if let Some(prev) = &cache.network_sample {
            let elapsed = now.duration_since(prev.sampled_at).as_secs_f64();

            if elapsed > 0.05 {
                let delta_rx = received_bytes.saturating_sub(prev.received_bytes);
                let delta_tx = transmitted_bytes.saturating_sub(prev.transmitted_bytes);
                download_bps = (delta_rx as f64 / elapsed) as u64;
                upload_bps = (delta_tx as f64 / elapsed) as u64;
            }
        }

        cache.network_sample = Some(crate::types::NetworkSample {
            received_bytes,
            transmitted_bytes,
            sampled_at: now,
        });
    }

    (download_bps, upload_bps)
}

// ---------------------------------------------------------------------------
// Autostart — delegated to tauri-plugin-autostart.
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn get_autostart_enabled(
    autostart: tauri::State<'_, tauri_plugin_autostart::AutoLaunchManager>,
) -> bool {
    autostart.is_enabled().unwrap_or(false)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn set_autostart_enabled(
    autostart: tauri::State<'_, tauri_plugin_autostart::AutoLaunchManager>,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        autostart
            .enable()
            .map_err(|e| format!("enable autostart failed: {e}"))?;
    } else {
        autostart
            .disable()
            .map_err(|e| format!("disable autostart failed: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Honest not-implemented stubs — real providers are pending (Stage 5+).
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn pause_download() -> Result<DownloadControlResult, String> {
    Ok(DownloadControlResult { success: true })
}

#[tauri::command]
pub fn resume_download() -> Result<DownloadControlResult, String> {
    Ok(DownloadControlResult { success: true })
}

#[tauri::command]
pub fn cancel_download() -> Result<DownloadControlResult, String> {
    Ok(DownloadControlResult { success: true })
}

#[tauri::command]
pub fn install_update() -> Result<DownloadControlResult, String> {
    Ok(DownloadControlResult { success: true })
}

#[tauri::command]
pub fn dismiss_notification() -> Result<DownloadControlResult, String> {
    Ok(DownloadControlResult { success: true })
}

// ---------------------------------------------------------------------------
// Download folder state — real monitoring for Windows, unsupported elsewhere.
// ---------------------------------------------------------------------------
// Stateless, on-demand snapshot of the user's Downloads folder. The event
// stream (`status-center://download-changed`, emitted by the download monitor)
// carries live changes; this command gives the provider an immediate snapshot on
// start so the bar does not wait for the next change event. Mirrors the media
// session's `get_media_session_status` command.
#[tauri::command]
pub fn get_download_state() -> DownloadFolderStatus {
    #[cfg(windows)]
    {
        let now = crate::unix_time_ms();
        let Some(dir) = crate::monitoring::downloads_dir() else {
            return DownloadFolderStatus {
                status: "idle",
                active_downloads: 0,
                progress: 0,
                code: "unsupported",
                checked_at: now,
            };
        };

        let (_, largest_temp, count) = crate::monitoring::scan_downloads(&dir);
        let mut expected_total = 0;
        let progress = crate::monitoring::compute_progress(largest_temp, &mut expected_total);
        let status = if count > 0 { "downloading" } else { "idle" };

        DownloadFolderStatus {
            status,
            active_downloads: count,
            progress,
            code: "available",
            checked_at: now,
        }
    }

    #[cfg(not(windows))]
    {
        DownloadFolderStatus {
            status: "idle",
            active_downloads: 0,
            progress: 0,
            code: "unsupported",
            checked_at: crate::unix_time_ms(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — pure-function overlay policy core only.
// ---------------------------------------------------------------------------
// `compute_overlay_policy` has no side effects and no Tauri state, so the full
// always-float / avoid-fullscreen / fullscreen truth table is coverable in
// unit tests.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_when_always_float_set_and_no_fullscreen() {
        assert!(compute_overlay_policy(true, true, false));
    }

    #[test]
    fn suppresses_float_when_avoiding_fullscreen_and_fullscreen_active() {
        assert!(!compute_overlay_policy(true, true, true));
    }

    #[test]
    fn floats_through_fullscreen_when_not_avoiding_it() {
        assert!(compute_overlay_policy(true, false, true));
    }

    #[test]
    fn never_floats_when_always_float_disabled_regardless_of_other_settings() {
        assert!(!compute_overlay_policy(false, true, false));
        assert!(!compute_overlay_policy(false, true, true));
        assert!(!compute_overlay_policy(false, false, false));
        assert!(!compute_overlay_policy(false, false, true));
    }
}
