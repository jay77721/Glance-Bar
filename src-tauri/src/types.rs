use serde::{Deserialize, Serialize};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::Networks;
use tauri::menu::Menu;

/// Request types sent to the MTA media thread.
/// All WinRT async calls run on this thread; the MTA apartment lets the
/// thread pool signal async completions without a dedicated message pump.
/// The enum is defined unconditionally: it only carries plain channel
/// senders, and the non-Windows `start_mta_media_thread` stub must still
/// name the type in its signature.
pub enum MediaRequest {
    Read(std_mpsc::Sender<MediaSessionStatus>),
    Action(String, std_mpsc::Sender<Result<MediaControlResult, String>>),
}

/// Channel sender for routing requests to the STA media thread.
/// Unconditional for the same reason as [`MediaRequest`] — it is a plain
/// channel alias used by both the Windows thread and the non-Windows stub.
pub type MediaRequestSender = Arc<Mutex<std_mpsc::Sender<MediaRequest>>>;

/// How often the media refresh timer re-publishes a playing session so the
/// frontend expiry window (30s) is never breached by silence.
pub const MEDIA_REFRESH_INTERVAL: Duration = Duration::from_secs(20);

/// Background poll cadence on the media thread. This is cheap (cached
/// SessionManager, no P/Invoke across the win32 boundary per tick) so 1s
/// is fine. Tightening this gives smoother progress updates at the cost of
/// more wakeups per second.
pub const MEDIA_POLL_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatusPreferences {
    pub always_float: bool,
    pub avoid_fullscreen: bool,
    pub lock_position: bool,
}

impl Default for DesktopStatusPreferences {
    fn default() -> Self {
        Self {
            always_float: true,
            avoid_fullscreen: true,
            lock_position: false,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCenterSettingsPayload {
    pub preferences: DesktopStatusPreferences,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCenterOpenSettingsPayload {
    pub source: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCenterMenuActionPayload {
    pub action: &'static str,
    pub checked: Option<bool>,
}

pub struct StatusCenterMenuItems<R: tauri::Runtime> {
    pub menu: Menu<R>,
    pub always_float: tauri::menu::CheckMenuItem<R>,
    pub avoid_fullscreen: tauri::menu::CheckMenuItem<R>,
    pub lock_position: tauri::menu::CheckMenuItem<R>,
}

pub struct NetworkSample {
    pub received_bytes: u64,
    pub transmitted_bytes: u64,
    pub sampled_at: std::time::Instant,
}

#[derive(Default)]
pub struct SystemPerformanceCache {
    pub networks: Option<Networks>,
    pub network_sample: Option<NetworkSample>,
}

pub struct DesktopProductState<R: tauri::Runtime> {
    pub preferences: DesktopStatusPreferences,
    pub menu_items: Option<StatusCenterMenuItems<R>>,
    pub perf_cache: SystemPerformanceCache,
}

impl<R: tauri::Runtime> Default for DesktopProductState<R> {
    fn default() -> Self {
        Self {
            preferences: DesktopStatusPreferences::default(),
            menu_items: None,
            perf_cache: SystemPerformanceCache::default(),
        }
    }
}

pub type SharedDesktopProductState<R> = Arc<Mutex<DesktopProductState<R>>>;

// MediaRequest and MediaRequestSender are defined above (unconditional).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub runtime: String,
    pub fixture_ipc: bool,
    pub tray: bool,
    pub always_on_top: bool,
    pub windows_providers: bool,
    pub configured_shell_window: ConfiguredShellWindow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestProviderCapability {
    pub kind: &'static str,
    pub quality: &'static str,
    pub code: &'static str,
    pub safe_to_display: bool,
    pub last_checked_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestProviderCapabilitiesPayload {
    pub providers: Vec<GuestProviderCapability>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSessionStatus {
    pub available: bool,
    pub playback_status: &'static str,
    pub progress: u8,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub title: String,
    pub artist: String,
    pub code: &'static str,
    pub checked_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredShellWindow {
    pub configured: bool,
    pub title: String,
    pub width: u16,
    pub height: u16,
    pub min_width: u16,
    pub min_height: u16,
    pub resizable: bool,
    pub centered: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPerformanceSnapshot {
    pub cpu: u8,
    pub memory: u8,
    pub download_speed: u64,
    pub upload_speed: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContent {
    pub text: String,
    pub source_app: String,
    pub copied_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaControlResult {
    pub success: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPolicy {
    pub foreground_fullscreen: bool,
    pub should_float: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPositionCorrection {
    pub corrected: bool,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusAssistStatePayload {
    pub active: bool,
    pub profile: String,
    pub checked_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSummaryPayload {
    pub focus_assist_active: bool,
    pub checked_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadControlResult {
    pub success: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFolderStatus {
    pub status: &'static str,
    pub active_downloads: u32,
    pub progress: u8,
    pub code: &'static str,
    pub checked_at: u64,
}
