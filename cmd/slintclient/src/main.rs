mod socket_client;

use crate::socket_client::{SharedSocketClient, SocketClient, SocketMessage};

use base64::engine::general_purpose::STANDARD as Base64Engine;
use base64::Engine;
use chrono::Local;
use slint::{Model, ModelRc, SharedString, VecModel};
use std::rc::Rc;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use url::Url;

slint::include_modules!();

const DEFAULT_CONTROL_URL: &str = "http://127.0.0.1:4455";
const DEFAULT_CONTROL_PORT: u16 = 4455;
const LOG_LIMIT: usize = 500;

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct AudioFile {
    name: String,
    size: Option<i64>,
    uploaded: Option<String>,
}

#[derive(Debug, Clone)]
struct StatusUpdate {
    status: StatusResponse,
    files: Vec<AudioFile>,
    audio_error: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    host: Option<String>,
    connected: bool,
    #[allow(dead_code)]
    timestamp: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    whoami: Option<serde_json::Value>,
    #[serde(default)]
    audio_list: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
struct FilesResponse {
    files: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct CommandResponse {
    #[serde(default)]
    result: Option<serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    filename: String,
    size: i64,
    #[allow(dead_code)]
    content_type: String,
}

#[derive(Debug, serde::Deserialize)]
struct BroadcastPlayEvent {
    filename: String,
    #[serde(default)]
    from: String,
    #[serde(default)]
    #[allow(dead_code)]
    timestamp: Option<String>,
    #[serde(rename = "self", default)]
    is_self: bool,
}

struct AppState {
    control_url: Url,
    socket: Mutex<Option<SharedSocketClient>>,
    log_tx: std::sync::mpsc::Sender<SharedString>,
    upload_path: Mutex<Option<PathBuf>>,
    connecting: AtomicBool,
    reconnect_pending: AtomicBool,
    ui: slint::Weak<AppWindow>,
}

impl AppState {
    fn new(control_url: Url, ui: slint::Weak<AppWindow>, log_tx: std::sync::mpsc::Sender<SharedString>) -> Arc<Self> {
        Arc::new(Self {
            control_url,
            socket: Mutex::new(None),
            log_tx,
            upload_path: Mutex::new(None),
            connecting: AtomicBool::new(false),
            reconnect_pending: AtomicBool::new(false),
            ui,
        })
    }

    fn log(self: &Arc<Self>, text: impl Into<String>) {
        let message = text.into();
        let timestamp = Local::now().format("%H:%M:%S");
        let entry = SharedString::from(format!("[{timestamp}] {message}"));
        let _ = self.log_tx.send(entry);
    }

    fn set_status(self: &Arc<Self>, status: impl Into<String>) {
        let text = SharedString::from(status.into());
        let weak = self.ui.clone();
        slint::invoke_from_event_loop(move || {
            if let Some(ui) = weak.upgrade() {
                ui.set_status_text(text.clone());
            }
        })
        .ok();
    }

    fn set_command_text(self: &Arc<Self>, value: &str) {
        let text = SharedString::from(value);
        let weak = self.ui.clone();
        slint::invoke_from_event_loop(move || {
            if let Some(ui) = weak.upgrade() {
                ui.set_command_text(text.clone());
            }
        })
        .ok();
    }

    fn set_broadcast_text(self: &Arc<Self>, value: &str) {
        let text = SharedString::from(value);
        let weak = self.ui.clone();
        slint::invoke_from_event_loop(move || {
            if let Some(ui) = weak.upgrade() {
                ui.set_broadcast_text(text.clone());
            }
        })
        .ok();
    }

    fn set_upload_name(self: &Arc<Self>, value: &str) {
        let text = SharedString::from(value);
        let weak = self.ui.clone();
        slint::invoke_from_event_loop(move || {
            if let Some(ui) = weak.upgrade() {
                ui.set_upload_name_text(text.clone());
            }
        })
        .ok();
    }

    fn start_connect(self: &Arc<Self>) {
        if self
            .connecting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        self.set_status("Status: connecting...");
        self.log("attempting socket connection");
        let state = Arc::clone(self);
        let url = self.control_url.clone();
        thread::spawn(move || {
            let address = match compute_socket_address(&url) {
                Ok(addr) => addr,
                Err(err) => {
                    state.log(format!("socket address error: {err}"));
                    state.on_socket_disconnected();
                    return;
                }
            };
            let (event_tx, event_rx) = std::sync::mpsc::channel();
            match SocketClient::connect(&address, event_tx) {
                Ok(client) => {
                    state.log(format!("socket connected: {address}"));
                    {
                        let mut guard = state.socket.lock().unwrap();
                        *guard = Some(client);
                    }
                    state.connecting.store(false, Ordering::SeqCst);
                    state.reconnect_pending.store(false, Ordering::SeqCst);
                    state.set_status("Status: connected");
                    let state_events = Arc::clone(&state);
                    thread::spawn(move || {
                        while let Ok(event) = event_rx.recv() {
                            state_events.handle_socket_event(event);
                        }
                    });
                    state.schedule_fetch_status();
                }
                Err(err) => {
                    state.log(format!("socket connect error: {err}"));
                    state.on_socket_disconnected();
                }
            }
        });
    }

    fn on_socket_disconnected(self: &Arc<Self>) {
        self.connecting.store(false, Ordering::SeqCst);
        self.set_status("Status: disconnected");
        {
            let mut guard = self.socket.lock().unwrap();
            *guard = None;
        }
        self.schedule_reconnect();
    }

    fn schedule_reconnect(self: &Arc<Self>) {
        if self.connecting.load(Ordering::SeqCst) {
            return;
        }
        if self
            .reconnect_pending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let state = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            state.reconnect_pending.store(false, Ordering::SeqCst);
            state.start_connect();
        });
    }

    fn current_socket(&self) -> Option<SharedSocketClient> {
        self.socket.lock().unwrap().clone()
    }

    fn schedule_fetch_status(self: &Arc<Self>) {
        let Some(socket) = self.current_socket() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let state = Arc::clone(self);
        thread::spawn(move || {
            let result = fetch_status(socket);
            match result {
                Ok(update) => state.handle_status_update(update),
                Err(err) => state.log(format!("status error: {err}")),
            }
        });
    }

    fn schedule_fetch_files(self: &Arc<Self>) {
        let Some(socket) = self.current_socket() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let state = Arc::clone(self);
        thread::spawn(move || {
            let result = fetch_files(socket);
            match result {
                Ok(files) => {
                    let mut preview = files.clone();
                    if preview.len() > 12 {
                        preview.truncate(12);
                    }
                    state.log(format!("files ({}): {}", files.len(), preview.join(", ")));
                }
                Err(err) => state.log(format!("files error: {err}")),
            }
        });
    }

    fn schedule_command(self: &Arc<Self>, command: String) {
        let trimmed = command.trim().to_owned();
        if trimmed.is_empty() {
            self.log("command empty");
            return;
        }
        self.set_command_text("");
        let Some(socket) = self.current_socket() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let state = Arc::clone(self);
        thread::spawn(move || {
            let mut payload = serde_json::Map::new();
            payload.insert("command".into(), serde_json::Value::String(trimmed.clone()));
            let result = socket
                .request("command", Some(payload))
                .map_err(|e| e.to_string())
                .and_then(|msg| parse_data::<CommandResponse>(msg.data).map_err(|e| e.to_string()))
                .map(|res| res.result);
            match result {
                Ok(value) => {
                    let encoded = value
                        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "null".into()))
                        .unwrap_or_else(|| "null".into());
                    state.log(format!("command result: {encoded}"));
                }
                Err(err) => state.log(format!("command error: {err}")),
            }
        });
    }

    fn schedule_play(self: &Arc<Self>, filename: String, broadcast: bool) {
        let trimmed = filename.trim().to_owned();
        if trimmed.is_empty() {
            self.log(if broadcast {
                "broadcast play filename missing"
            } else {
                "play filename missing"
            });
            return;
        }
        let Some(socket) = self.current_socket() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let state = Arc::clone(self);
        thread::spawn(move || {
            let action = if broadcast { "broadcast-play" } else { "play" };
            let mut payload = serde_json::Map::new();
            payload.insert(
                "filename".into(),
                serde_json::Value::String(trimmed.clone()),
            );
            let result = socket
                .request(action, Some(payload))
                .map_err(|e| e.to_string());
            match result {
                Ok(_) => {
                    if broadcast {
                        state.log(format!("broadcast play sent: {trimmed}"));
                    } else {
                        state.log(format!("play invoked: {trimmed}"));
                    }
                }
                Err(err) => state.log(err),
            }
        });
    }

    fn schedule_broadcast(self: &Arc<Self>, message: String) {
        let trimmed = message.trim().to_owned();
        if trimmed.is_empty() {
            self.log("broadcast message missing");
            return;
        }
        self.set_broadcast_text("");
        let Some(socket) = self.current_socket() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let state = Arc::clone(self);
        thread::spawn(move || {
            let mut payload = serde_json::Map::new();
            payload.insert("message".into(), serde_json::Value::String(trimmed.clone()));
            let result = socket
                .request("broadcast", Some(payload))
                .map_err(|e| e.to_string());
            match result {
                Ok(_) => state.log("broadcast sent"),
                Err(err) => state.log(err),
            }
        });
    }

    fn schedule_upload(self: &Arc<Self>, remote: String) {
        let path = {
            let guard = self.upload_path.lock().unwrap();
            guard.clone()
        };
        let Some(path) = path else {
            self.log("no upload file selected");
            return;
        };
        let remote_name = {
            let trimmed = remote.trim();
            if trimmed.is_empty() {
                file_name_from_path(&path).unwrap_or_else(|| "upload.bin".into())
            } else {
                trimmed.to_string()
            }
        };
        let Some(socket) = self.current_socket() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let state = Arc::clone(self);
        thread::spawn(move || {
            let data = std::fs::read(&path).map_err(|e| format!("read error: {e}"));
            let result = data.and_then(|bytes| {
                let mut payload = serde_json::Map::new();
                payload.insert(
                    "filename".into(),
                    serde_json::Value::String(remote_name.clone()),
                );
                payload.insert(
                    "base64".into(),
                    serde_json::Value::String(Base64Engine.encode(bytes)),
                );
                payload.insert(
                    "contentType".into(),
                    serde_json::Value::String(detect_content_type(&remote_name).to_string()),
                );
                socket
                    .request("upload", Some(payload))
                    .map_err(|e| e.to_string())
                    .and_then(|msg| {
                        parse_data::<UploadResponse>(msg.data).map_err(|e| e.to_string())
                    })
            });
            match result {
                Ok(resp) => {
                    state.log(format!(
                        "upload complete: {} ({} bytes)",
                        resp.filename, resp.size
                    ));
                    state.schedule_fetch_status();
                }
                Err(err) => state.log(format!("upload error: {err}")),
            }
        });
    }

    fn choose_file(self: &Arc<Self>) {
        let state = Arc::clone(self);
        thread::spawn(move || {
            if let Some(path) = rfd::FileDialog::new().pick_file() {
                let name = file_name_from_path(&path).unwrap_or_else(|| "".into());
                {
                    let mut guard = state.upload_path.lock().unwrap();
                    *guard = Some(path.clone());
                }
                state.set_upload_name(&name);
                state.log(format!("upload selected: {}", path.display()));
            }
        });
    }

    fn handle_status_update(self: &Arc<Self>, update: StatusUpdate) {
        let StatusUpdate {
            status,
            files,
            audio_error,
        } = update;
        self.update_audio_files(files.clone());

        let host = status.host.clone().unwrap_or_else(|| "unknown".into());
        self.set_status(format!("Status: {} (connected={})", host, status.connected));
        self.log(format!(
            "status ok: host={} connected={}",
            host, status.connected
        ));
        match audio_error {
            Some(err) => self.log(format!("audio list error: {err}")),
            None if files.is_empty() => self.log("audio list empty"),
            None => {
                let preview: Vec<_> = files.iter().take(6).map(|f| f.name.as_str()).collect();
                self.log(format!(
                    "audio list ({}): {}",
                    files.len(),
                    preview.join(", ")
                ));
            }
        }
    }

    fn update_audio_files(self: &Arc<Self>, files: Vec<AudioFile>) {
        let names: Vec<SharedString> = files
            .iter()
            .map(|f| SharedString::from(f.name.clone()))
            .collect();
        let weak = self.ui.clone();
        slint::invoke_from_event_loop(move || {
            if let Some(ui) = weak.upgrade() {
                let model = VecModel::from_slice(&names);
                ui.set_audio_files(ModelRc::new(model));
            }
        })
        .ok();
    }

    fn handle_socket_event(self: &Arc<Self>, message: SocketMessage) {
        match message.event.as_deref() {
            Some("hello") => {
                if let Some(payload) = message.payload {
                    if let Some(info) = payload.as_object() {
                        let host = info
                            .get("host")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let since = info
                            .get("connectedAt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        self.log(format!("socket hello from {host} (since {since})"));
                    } else if let Some(text) = payload.as_str() {
                        self.log(format!("socket hello: {}", text.trim()));
                    }
                } else {
                    self.log("socket hello");
                }
            }
            Some("status") => {
                if let Some(payload) = message.payload {
                    match serde_json::from_value::<StatusResponse>(payload.clone()) {
                        Ok(status) => {
                            let (files, audio_error) = parse_audio_list(status.audio_list.clone());
                            let update = StatusUpdate {
                                status,
                                files,
                                audio_error,
                            };
                            self.handle_status_update(update);
                        }
                        Err(err) => self.log(format!("socket status parse error: {err}")),
                    }
                }
            }
            Some("hub-message") => {
                if let Some(payload) = message.payload {
                    match serde_json::to_string(&payload) {
                        Ok(text) => self.log(format!("hub message: {text}")),
                        Err(err) => self.log(format!("hub message encode error: {err}")),
                    }
                } else {
                    self.log("hub message (empty)");
                }
            }
            Some("broadcast-play") => {
                if let Some(payload) = message.payload {
                    match serde_json::from_value::<BroadcastPlayEvent>(payload) {
                        Ok(event) => {
                            let label = if event.from.is_empty() {
                                "unknown"
                            } else {
                                event.from.as_str()
                            };
                            if event.is_self {
                                self.log(format!(
                                    "broadcast play acknowledged: {} (self)",
                                    event.filename
                                ));
                            } else {
                                self.log(format!(
                                    "broadcast play from {}: {}",
                                    label, event.filename
                                ));
                            }
                        }
                        Err(err) => self.log(format!("broadcast-play parse error: {err}")),
                    }
                } else {
                    self.log("broadcast-play event (no payload)");
                }
            }
            Some("log") => {
                if let Some(payload) = message.payload {
                    if let Some(text) = payload.as_str() {
                        self.log(format!("log event: {}", text.trim()));
                    } else {
                        self.log("log event received");
                    }
                }
            }
            Some("error") => {
                if let Some(err) = message.error {
                    self.log(format!("socket error event: {err}"));
                } else {
                    self.log("socket error event");
                }
            }
            Some("disconnect") => {
                if let Some(err) = message.error {
                    self.log(format!("socket disconnected: {err}"));
                } else {
                    self.log("socket disconnected");
                }
                self.on_socket_disconnected();
            }
            Some(other) => self.log(format!("socket event {other}")),
            None => {}
        }
    }
}

fn fetch_status(socket: SharedSocketClient) -> Result<StatusUpdate, String> {
    let message = socket.request("status", None).map_err(|e| e.to_string())?;
    let status: StatusResponse = parse_data(message.data).map_err(|e| e.to_string())?;
    let (files, audio_error) = parse_audio_list(status.audio_list.clone());
    Ok(StatusUpdate {
        status,
        files,
        audio_error,
    })
}

fn parse_data<T: serde::de::DeserializeOwned>(
    data: Option<serde_json::Value>,
) -> Result<T, serde_json::Error> {
    match data {
        Some(value) => serde_json::from_value(value),
        None => serde_json::from_value(serde_json::Value::Null),
    }
}

fn fetch_files(socket: SharedSocketClient) -> Result<Vec<String>, String> {
    let message = socket.request("files", None).map_err(|e| e.to_string())?;
    let response: FilesResponse = parse_data(message.data).map_err(|e| e.to_string())?;
    Ok(response.files)
}

fn parse_audio_list(raw: Option<serde_json::Value>) -> (Vec<AudioFile>, Option<String>) {
    match raw {
        None | Some(serde_json::Value::Null) => (Vec::new(), None),
        Some(serde_json::Value::Object(map)) => {
            if let Some(serde_json::Value::String(err)) = map.get("error") {
                if !err.is_empty() {
                    return (Vec::new(), Some(err.clone()));
                }
            }
            if let Some(value) = map.get("result") {
                return parse_audio_list(Some(value.clone()));
            }
            if let Some(value) = map.get("files") {
                return parse_audio_list(Some(value.clone()));
            }
            if let Some(serde_json::Value::String(name)) = map.get("name") {
                return (
                    vec![AudioFile {
                        name: name.clone(),
                        size: map.get("size").and_then(parse_audio_size),
                        uploaded: map
                            .get("uploaded")
                            .and_then(|v| v.as_str().map(|s| s.to_string())),
                    }],
                    None,
                );
            }
            if let Some(serde_json::Value::String(key)) = map.get("key") {
                return (
                    vec![AudioFile {
                        name: key.clone(),
                        size: map.get("size").and_then(parse_audio_size),
                        uploaded: map
                            .get("uploaded")
                            .and_then(|v| v.as_str().map(|s| s.to_string())),
                    }],
                    None,
                );
            }
            (Vec::new(), None)
        }
        Some(serde_json::Value::Array(items)) => {
            let mut files = Vec::new();
            for item in items {
                match item {
                    serde_json::Value::String(name) => {
                        if !name.is_empty() {
                            files.push(AudioFile {
                                name,
                                size: None,
                                uploaded: None,
                            });
                        }
                    }
                    serde_json::Value::Object(map) => {
                        let name = map
                            .get("name")
                            .and_then(|v| v.as_str())
                            .or_else(|| map.get("key").and_then(|v| v.as_str()));
                        if let Some(name) = name {
                            files.push(AudioFile {
                                name: name.to_string(),
                                size: map.get("size").and_then(parse_audio_size),
                                uploaded: map
                                    .get("uploaded")
                                    .and_then(|v| v.as_str().map(|s| s.to_string())),
                            });
                        }
                    }
                    _ => {}
                }
            }
            (files, None)
        }
        _ => (Vec::new(), None),
    }
}

fn parse_audio_size(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(num) => num.as_i64(),
        serde_json::Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    }
}

fn detect_content_type(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else if lower.ends_with(".ogg") {
        "audio/ogg"
    } else if lower.ends_with(".flac") {
        "audio/flac"
    } else if lower.ends_with(".m4a") {
        "audio/mp4"
    } else {
        "application/octet-stream"
    }
}

fn file_name_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|s| s.to_string())
}

fn compute_socket_address(control_url: &Url) -> Result<String, String> {
    let host = control_url.host_str().unwrap_or("127.0.0.1");
    if let Ok(port_var) = std::env::var("CLIENT_SOCKET_PORT") {
        let port: u16 = port_var
            .parse()
            .map_err(|e| format!("invalid CLIENT_SOCKET_PORT: {e}"))?;
        return Ok(join_host_port(host, port));
    }
    let port = control_url.port().unwrap_or(DEFAULT_CONTROL_PORT);
    Ok(join_host_port(host, port))
}

fn join_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn parse_control_url() -> Url {
    let control =
        std::env::var("CLIENT_CONTROL_URL").unwrap_or_else(|_| DEFAULT_CONTROL_URL.to_string());
    Url::parse(&control).unwrap_or_else(|err| {
        eprintln!("invalid CLIENT_CONTROL_URL: {err}");
        std::process::exit(1);
    })
}

fn main() {
    let control_url = parse_control_url();
    let app = AppWindow::new().expect("failed to construct UI");

    // Set up a persistent log model to avoid re-binding the property
    let log_model: Rc<VecModel<SharedString>> = Rc::new(VecModel::from(Vec::<SharedString>::new()));
    app.set_log_entries(ModelRc::new(log_model.clone()));
    app.set_audio_files(ModelRc::new(VecModel::from(Vec::<SharedString>::new())));
    app.set_command_text("".into());
    app.set_play_text("".into());
    app.set_broadcast_text("".into());
    app.set_upload_name_text("".into());

    // Channel for log entries; updates to the UI model are batched on the UI thread
    let (log_tx, log_rx) = std::sync::mpsc::channel::<SharedString>();

    // Spawn a helper thread that applies log updates on the Slint event loop,
    // mutating the persistent VecModel instead of re-binding the model each time.
    {
        let ui_weak_outer = app.as_weak();
        std::thread::spawn(move || {
            while let Ok(entry) = log_rx.recv() {
                let ui_weak = ui_weak_outer.clone();
                slint::invoke_from_event_loop(move || {
                    // Only update if UI still alive
                    if let Some(ui) = ui_weak.upgrade() {
                        let model = ui.get_log_entries();
                        // Downcast to VecModel to mutate in place
                        if let Some(vec_model) = model.as_any().downcast_ref::<VecModel<SharedString>>() {
                            while vec_model.row_count() >= LOG_LIMIT {
                                vec_model.remove(0);
                            }
                            vec_model.push(entry);
                            // Trigger UI to apply scroll formula
                            let rev = ui.get_log_force_rev();
                            ui.set_log_force_rev(rev + 1);
                        } else {
                            // Fallback: re-set the model (should be rare)
                            let mut current: Vec<SharedString> = Vec::new();
                            for i in 0..model.row_count() {
                                if let Some(v) = model.row_data(i) { current.push(v); }
                            }
                            if current.len() >= LOG_LIMIT { current.remove(0); }
                            current.push(entry);
                            ui.set_log_entries(ModelRc::new(VecModel::from(current)));
                            let rev = ui.get_log_force_rev();
                            ui.set_log_force_rev(rev + 1);
                        }
                    }
                })
                .ok();
            }
        });
    }

    let state = AppState::new(control_url, app.as_weak(), log_tx);

    {
        let state = Arc::clone(&state);
        app.on_refresh_status(move || {
            state.schedule_fetch_status();
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_fetch_files(move || {
            state.schedule_fetch_files();
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_show_peers(move || {
            state.log("peers command requested");
            state.schedule_command("peers".into());
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_send_command(move |cmd| {
            state.schedule_command(cmd.to_string());
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_play_audio(move |filename| {
            state.schedule_play(filename.to_string(), false);
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_broadcast_message(move |message| {
            state.schedule_broadcast(message.to_string());
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_broadcast_play(move |filename| {
            state.schedule_play(filename.to_string(), true);
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_audio_file_clicked(move |name| {
            state.schedule_play(name.to_string(), true);
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_choose_file(move || {
            state.choose_file();
        });
    }

    {
        let state = Arc::clone(&state);
        app.on_upload_file(move |remote| {
            state.schedule_upload(remote.to_string());
        });
    }

    state.start_connect();

    app.run().unwrap();
}
