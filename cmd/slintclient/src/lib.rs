#![cfg(target_arch = "wasm32")]

use js_sys::Array;
use slint::{ModelRc, SharedString, VecModel};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

slint::include_modules!();

const LOG_LIMIT: usize = 500;

struct AppState {
    app: slint::Weak<AppWindow>,
    log_lines: Vec<String>,
    audio_files: Vec<String>,
}

thread_local! {
    static APP_STATE: RefCell<Option<AppState>> = RefCell::new(None);
}

// Bindings to JavaScript client API functions defined in web/client.ts (bundled by Vite)
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = clientApi, js_name = init)]
    fn client_api_init();
    #[wasm_bindgen(js_namespace = clientApi, js_name = refreshStatus)]
    fn client_api_refresh_status();
    #[wasm_bindgen(js_namespace = clientApi, js_name = fetchFiles)]
    fn client_api_fetch_files();
    #[wasm_bindgen(js_namespace = clientApi, js_name = showPeers)]
    fn client_api_show_peers();
    #[wasm_bindgen(js_namespace = clientApi, js_name = sendCommand)]
    fn client_api_send_command(command: &str);
    #[wasm_bindgen(js_namespace = clientApi, js_name = playAudio)]
    fn client_api_play_audio(name: &str);
    #[wasm_bindgen(js_namespace = clientApi, js_name = broadcastMessage)]
    fn client_api_broadcast_message(message: &str);
    #[wasm_bindgen(js_namespace = clientApi, js_name = broadcastPlay)]
    fn client_api_broadcast_play(name: &str);
    #[wasm_bindgen(js_namespace = clientApi, js_name = chooseFile)]
    fn client_api_choose_file();
    #[wasm_bindgen(js_namespace = clientApi, js_name = uploadFile)]
    fn client_api_upload_file(name: &str);
    #[wasm_bindgen(js_namespace = clientApi, js_name = audioFileClicked)]
    fn client_api_audio_file_clicked(name: &str);
}

fn with_app_state<F>(mut f: F)
where
    F: FnMut(&mut AppState, &AppWindow),
{
    APP_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if let Some(app_state) = state.as_mut() {
            if let Some(app) = app_state.app.upgrade() {
                f(app_state, &app);
            }
        }
    });
}

fn refresh_log_view(state: &AppState, app: &AppWindow) {
    let entries: Vec<SharedString> = state
        .log_lines
        .iter()
        .cloned()
        .map(SharedString::from)
        .collect();
    app.set_log_entries(ModelRc::new(VecModel::from(entries)));
    let current = app.get_log_force_rev();
    app.set_log_force_rev(current + 1);
}

fn refresh_audio_view(state: &AppState, app: &AppWindow) {
    let files: Vec<SharedString> = state
        .audio_files
        .iter()
        .cloned()
        .map(SharedString::from)
        .collect();
    app.set_audio_files(ModelRc::new(VecModel::from(files)));
}

fn register_callbacks(app: &AppWindow) {
    app.on_refresh_status(|| client_api_refresh_status());
    app.on_fetch_files(|| client_api_fetch_files());
    app.on_show_peers(|| client_api_show_peers());
    app.on_send_command(|cmd| client_api_send_command(cmd.as_str()));
    app.on_play_audio(|name| client_api_play_audio(name.as_str()));
    app.on_broadcast_message(|message| client_api_broadcast_message(message.as_str()));
    app.on_broadcast_play(|name| client_api_broadcast_play(name.as_str()));
    app.on_choose_file(|| client_api_choose_file());
    app.on_upload_file(|name| client_api_upload_file(name.as_str()));
    app.on_audio_file_clicked(|name| client_api_audio_file_clicked(name.as_str()));
}

#[wasm_bindgen]
pub fn run_app() {
    let app = AppWindow::new().expect("failed to construct UI");

    app.set_status_text("Status: idle".into());
    app.set_log_entries(ModelRc::new(VecModel::from(Vec::<SharedString>::new())));
    app.set_audio_files(ModelRc::new(VecModel::from(Vec::<SharedString>::new())));
    app.set_command_text("".into());
    app.set_play_text("".into());
    app.set_broadcast_text("".into());
    app.set_upload_name_text("".into());

    APP_STATE.with(|cell| {
        *cell.borrow_mut() = Some(AppState {
            app: app.as_weak(),
            log_lines: Vec::new(),
            audio_files: Vec::new(),
        });
    });

    register_callbacks(&app);
    client_api_init();
    app.run().unwrap();
}

#[wasm_bindgen]
pub fn ui_set_status_text(text: &str) {
    with_app_state(|_, app| {
        app.set_status_text(text.into());
    });
}

#[wasm_bindgen]
pub fn ui_set_command_text(text: &str) {
    with_app_state(|_, app| {
        app.set_command_text(text.into());
    });
}

#[wasm_bindgen]
pub fn ui_set_play_text(text: &str) {
    with_app_state(|_, app| {
        app.set_play_text(text.into());
    });
}

#[wasm_bindgen]
pub fn ui_set_broadcast_text(text: &str) {
    with_app_state(|_, app| {
        app.set_broadcast_text(text.into());
    });
}

#[wasm_bindgen]
pub fn ui_set_upload_name_text(text: &str) {
    with_app_state(|_, app| {
        app.set_upload_name_text(text.into());
    });
}

#[wasm_bindgen]
pub fn ui_clear_log() {
    with_app_state(|state, app| {
        state.log_lines.clear();
        refresh_log_view(state, app);
    });
}

#[wasm_bindgen]
pub fn ui_append_log_line(line: &str) {
    with_app_state(|state, app| {
        state.log_lines.push(line.to_string());
        if state.log_lines.len() > LOG_LIMIT {
            state.log_lines.remove(0);
        }
        refresh_log_view(state, app);
    });
}

#[wasm_bindgen]
pub fn ui_set_log_lines(lines: Array) {
    let mut values: Vec<String> = lines.iter().filter_map(|value| value.as_string()).collect();
    with_app_state(move |state, app| {
        if values.len() > LOG_LIMIT {
            let excess = values.len() - LOG_LIMIT;
            values.drain(0..excess);
        }
        state.log_lines = values.clone();
        refresh_log_view(state, app);
    });
}

#[wasm_bindgen]
pub fn ui_set_audio_files(files: Array) {
    let values: Vec<String> = files.iter().filter_map(|value| value.as_string()).collect();
    with_app_state(move |state, app| {
        state.audio_files = values.clone();
        refresh_audio_view(state, app);
    });
}
