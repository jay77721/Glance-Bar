mod commands;
mod media;
mod monitoring;
mod preferences;
mod tray;
mod types;
mod window;

pub use crate::types::*;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder};
use tauri::{Emitter, Manager, PhysicalPosition, WindowEvent};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_autostart::MacosLauncher;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::ShortcutState;

// ---------------------------------------------------------------------------
// Constants (kept in lib.rs as crate-wide singletons).
// ---------------------------------------------------------------------------
const STATUS_WINDOW_LABEL: &str = "main";
const STATUS_CENTER_MENU_ACTION_EVENT: &str = "status-center://menu-action";
const STATUS_CENTER_SETTINGS_EVENT: &str = "status-center://settings";
const STATUS_CENTER_OPEN_SETTINGS_EVENT: &str = "status-center://open-settings";
const GLOBAL_SHORTCUT_RECALL: &str = "Alt+Shift+Space";

const MENU_REFRESH_DATA: &str = "refresh-data";
const MENU_ALWAYS_FLOAT: &str = "always-float";
const MENU_AVOID_FULLSCREEN: &str = "avoid-fullscreen";
const MENU_LOCK_POSITION: &str = "lock-position";
const MENU_RESET_POSITION: &str = "reset-position";
const MENU_OPEN_SETTINGS: &str = "open-settings";
const MENU_QUIT: &str = "quit";

// ---------------------------------------------------------------------------
// Crate-wide helpers.
// ---------------------------------------------------------------------------
fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(crate) fn clamp_percent(value: f64) -> u8 {
    if !value.is_finite() {
        return 0;
    }

    value.round().clamp(0.0, 100.0) as u8
}

// ---------------------------------------------------------------------------
// Tray menu construction + event routing (kept in lib.rs as run() glue).
// ---------------------------------------------------------------------------
fn create_status_center_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    preferences: &DesktopStatusPreferences,
) -> Result<StatusCenterMenuItems<R>, tauri::Error> {
    let always_float =
        CheckMenuItemBuilder::with_id(MENU_ALWAYS_FLOAT, "\u{603B}\u{662F}\u{60AC}\u{6D6E}")
            .checked(preferences.always_float)
            .build(app)?;
    let avoid_fullscreen = CheckMenuItemBuilder::with_id(
        MENU_AVOID_FULLSCREEN,
        "\u{5168}\u{5C4F}\u{65F6}\u{907F}\u{8BA9}",
    )
    .checked(preferences.avoid_fullscreen)
    .build(app)?;
    let lock_position =
        CheckMenuItemBuilder::with_id(MENU_LOCK_POSITION, "\u{9501}\u{5B9A}\u{4F4D}\u{7F6E}")
            .checked(preferences.lock_position)
            .build(app)?;

    let menu = MenuBuilder::new(app)
        .text(MENU_REFRESH_DATA, "\u{5237}\u{65B0}\u{6570}\u{636E}")
        .item(&always_float)
        .item(&avoid_fullscreen)
        .item(&lock_position)
        .separator()
        .text(MENU_RESET_POSITION, "\u{91CD}\u{7F6E}\u{4F4D}\u{7F6E}")
        .text(MENU_OPEN_SETTINGS, "\u{6253}\u{5F00}\u{8BBE}\u{7F6E}")
        .separator()
        .text(MENU_QUIT, "\u{9000}\u{51FA}")
        .build()?;

    Ok(StatusCenterMenuItems {
        menu,
        always_float,
        avoid_fullscreen,
        lock_position,
    })
}

fn emit_status_center_settings<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    preferences: &DesktopStatusPreferences,
) {
    let _ = app.emit_to(
        STATUS_WINDOW_LABEL,
        STATUS_CENTER_SETTINGS_EVENT,
        StatusCenterSettingsPayload {
            preferences: preferences.clone(),
        },
    );
}

fn emit_open_settings_requested<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    source: &'static str,
) {
    let _ = app.emit_to(
        STATUS_WINDOW_LABEL,
        STATUS_CENTER_OPEN_SETTINGS_EVENT,
        StatusCenterOpenSettingsPayload { source },
    );
}

fn emit_status_center_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: &'static str,
    checked: Option<bool>,
) {
    let _ = app.emit_to(
        STATUS_WINDOW_LABEL,
        STATUS_CENTER_MENU_ACTION_EVENT,
        StatusCenterMenuActionPayload { action, checked },
    );
}

fn request_open_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>, source: &'static str) {
    reveal_status_center_window(app);
    emit_open_settings_requested(app, source);
    emit_status_center_action(app, "open-settings", None);
}

fn handle_status_center_menu_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &SharedDesktopProductState<R>,
    id: &str,
) {
    let Ok(mut state) = state.lock() else {
        return;
    };
    let mut preferences_changed = false;

    match id {
        crate::tray::TRAY_MENU_SHOW_STATUS_CENTER => reveal_status_center_window(app),
        crate::tray::TRAY_MENU_OPEN_SETTINGS => request_open_settings(app, "tray"),
        MENU_REFRESH_DATA => emit_status_center_action(app, "refresh-data", None),
        MENU_ALWAYS_FLOAT => {
            state.preferences.always_float = !state.preferences.always_float;
            preferences_changed = true;
            if let Some(menu_items) = &state.menu_items {
                crate::preferences::apply_preference_menu_state(menu_items, &state.preferences);
            }
            emit_status_center_settings(app, &state.preferences);
            emit_status_center_action(
                app,
                "toggle-always-float",
                Some(state.preferences.always_float),
            );
        }
        MENU_AVOID_FULLSCREEN => {
            state.preferences.avoid_fullscreen = !state.preferences.avoid_fullscreen;
            preferences_changed = true;
            if let Some(menu_items) = &state.menu_items {
                crate::preferences::apply_preference_menu_state(menu_items, &state.preferences);
            }
            emit_status_center_settings(app, &state.preferences);
            emit_status_center_action(
                app,
                "toggle-avoid-fullscreen",
                Some(state.preferences.avoid_fullscreen),
            );
        }
        MENU_LOCK_POSITION => {
            state.preferences.lock_position = !state.preferences.lock_position;
            preferences_changed = true;
            if let Some(menu_items) = &state.menu_items {
                crate::preferences::apply_preference_menu_state(menu_items, &state.preferences);
            }
            emit_status_center_settings(app, &state.preferences);
            emit_status_center_action(
                app,
                "toggle-lock-position",
                Some(state.preferences.lock_position),
            );
        }
        MENU_RESET_POSITION => emit_status_center_action(app, "reset-position", None),
        MENU_OPEN_SETTINGS => request_open_settings(app, "menu"),
        MENU_QUIT => {
            emit_status_center_action(app, "quit", None);
            if let Some(shutdown) = app.try_state::<Arc<AtomicBool>>() {
                shutdown.store(true, Ordering::SeqCst);
            }
            app.exit(0);
        }
        _ => {}
    }

    if preferences_changed {
        let _ = crate::preferences::persist_status_center_preferences(app, &state.preferences);
    }
}

fn reveal_status_center_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = crate::commands::window::correct_status_window_position_for_window(&window);
        let _ = window.set_focus();
    }
}

fn hide_status_center_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn toggle_status_center_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_minimized = window.is_minimized().unwrap_or(false);

        if is_visible && !is_minimized {
            let _ = window.hide();
            return;
        }
    }

    reveal_status_center_window(app);
}

// ---------------------------------------------------------------------------
// Application entry point.
// ---------------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let desktop_product_state: SharedDesktopProductState<tauri::Wry> =
        Arc::new(Mutex::new(DesktopProductState::default()));
    let setup_state = Arc::clone(&desktop_product_state);
    let app_shutdown: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let shadow_shutdown = Arc::clone(&app_shutdown);

    tauri::Builder::default()
        .manage(desktop_product_state.clone())
        .manage(app_shutdown.clone())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.handle().plugin(tauri_plugin_opener::init())?;

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcut(GLOBAL_SHORTCUT_RECALL)?
                    .with_handler(|app, shortcut, event| {
                        if event.state == ShortcutState::Pressed
                            && shortcut
                                .to_string()
                                .eq_ignore_ascii_case(GLOBAL_SHORTCUT_RECALL)
                        {
                            reveal_status_center_window(app);
                        }
                    })
                    .build(),
            )?;

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--minimized"]),
            ))?;

            let preferences = crate::preferences::load_status_center_preferences(app.handle());
            let menu_items = create_status_center_menu(app.handle(), &preferences)?;
            let tray_menu = crate::tray::create_tray_menu(app.handle())?;

            let _tray =
                crate::tray::build_tray_icon(app.handle().clone(), &tray_menu, |app_handle| {
                    toggle_status_center_window(app_handle);
                })?;

            if let Ok(mut state) = setup_state.lock() {
                state.preferences = preferences.clone();
                state.menu_items = Some(menu_items);
            }

            if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
                crate::commands::window::disable_dwm_window_shadow(&window, shadow_shutdown);

                if let Ok(monitors) = window.available_monitors() {
                    if let Some(monitor) = monitors.first() {
                        let work_area = monitor.work_area();
                        let scale = monitor.scale_factor();
                        let window_width = (303.0 * scale) as i32;
                        let window_height = (64.0 * scale) as i32;
                        let margin = (8.0 * scale) as i32;
                        let x = work_area.position.x + work_area.size.width as i32
                            - window_width
                            - margin;
                        let y = work_area.position.y + work_area.size.height as i32
                            - window_height
                            - margin;
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                }

                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_status_center_window(&app_handle);
                    }
                });
            }

            emit_status_center_settings(app.handle(), &preferences);

            let app_shutdown = app.handle().state::<Arc<AtomicBool>>().inner().clone();

            monitoring::start_clipboard_monitor(app.handle().clone(), Arc::clone(&app_shutdown));
            monitoring::start_focus_monitor(app.handle().clone(), Arc::clone(&app_shutdown));
            monitoring::start_media_monitor(app.handle(), Arc::clone(&app_shutdown));
            monitoring::start_download_monitor(app.handle().clone(), Arc::clone(&app_shutdown));

            Ok(())
        })
        .on_menu_event({
            let desktop_product_state = desktop_product_state.clone();
            move |app, event| {
                handle_status_center_menu_event(app, &desktop_product_state, event.id().as_ref());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::media::get_media_session_status,
            commands::system::get_system_performance,
            commands::system::get_overlay_policy,
            commands::window::set_status_window_floating,
            commands::window::correct_status_window_position,
            commands::window::start_window_drag,
            commands::window::show_status_center_context_menu,
            commands::window::get_status_center_settings,
            commands::window::set_status_center_preferences,
            commands::window::show_status_center_window,
            commands::window::open_status_center_settings,
            commands::window::quit_status_center,
            commands::clipboard::open_url_in_browser,
            commands::clipboard::get_clipboard_content,
            commands::clipboard::set_clipboard_content,
            commands::media::media_control,
            commands::focus::get_focus_assist_state,
            commands::focus::get_notification_summary,
            commands::focus::stop_focus_session,
            commands::system::pause_download,
            commands::system::resume_download,
            commands::system::cancel_download,
            commands::system::install_update,
            commands::system::dismiss_notification,
            commands::system::get_download_state,
            commands::system::get_autostart_enabled,
            commands::system::set_autostart_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
