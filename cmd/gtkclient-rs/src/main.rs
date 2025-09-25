mod socket_client;

use crate::socket_client::{SharedSocketClient, SocketClient, SocketMessage};

use base64::engine::general_purpose::STANDARD as Base64Engine;
use base64::Engine;
use chrono::{DateTime, Local};
use relm4::gtk;
use relm4::gtk::prelude::*;
use relm4::prelude::*;
use relm4::Sender;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value};
use std::collections::VecDeque;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use url::Url;

const DEFAULT_CONTROL_URL: &str = "http://127.0.0.1:4455";
const DEFAULT_CONTROL_PORT: u16 = 4455;
const LOG_LIMIT: usize = 500;

#[derive(Debug, Clone)]
struct AudioFile {
    name: String,
    size: Option<i64>,
    uploaded: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    host: Option<String>,
    connected: bool,
    timestamp: Option<String>,
    #[serde(default)]
    whoami: Option<Value>,
    #[serde(default)]
    audio_list: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct FilesResponse {
    files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CommandResponse {
    #[serde(default)]
    result: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    filename: String,
    size: i64,
    #[allow(dead_code)]
    content_type: String,
}

#[derive(Debug, Clone)]
struct StatusUpdate {
    status: StatusResponse,
    files: Vec<AudioFile>,
    audio_error: Option<String>,
}

#[derive(Debug, Clone)]
enum AppMsg {
    Initialize,
    SocketConnected(Result<(SharedSocketClient, String), String>),
    SocketEvent(SocketMessage),
    FetchStatus,
    StatusFetched(Result<StatusUpdate, String>),
    FetchFiles,
    FilesFetched(Result<Vec<String>, String>),
    SendCommand(String),
    CommandResult(Result<Option<Value>, String>),
    Play(String),
    Broadcast(String),
    BroadcastPlay(String),
    StartUpload { remote: String },
    UploadResult(Result<UploadResponse, String>),
    UploadFileChosen(Option<PathBuf>),
    Log(String),
    RetryConnect,
}

struct AppModel {
    control_url: Url,
    socket: Option<SharedSocketClient>,
    log_lines: VecDeque<String>,
    status_label: String,
    audio_files: Vec<AudioFile>,
    audio_error: Option<String>,
    log_limit: usize,
    upload_path: Option<PathBuf>,
    input_sender: Sender<AppMsg>,
    connecting: bool,
    reconnect_pending: bool,
}

struct AppWidgets {
    _window: gtk::ApplicationWindow,
    _main_box: gtk::Box,
    status_label: gtk::Label,
    _command_entry: gtk::Entry,
    _play_entry: gtk::Entry,
    _broadcast_entry: gtk::Entry,
    _upload_name_entry: gtk::Entry,
    audio_flow: gtk::FlowBox,
    log_view: gtk::TextView,
    log_buffer: gtk::TextBuffer,
}

impl SimpleComponent for AppModel {
    type Init = Url;
    type Input = AppMsg;
    type Output = ();
    type Root = gtk::ApplicationWindow;
    type Widgets = AppWidgets;

    fn init_root() -> Self::Root {
        gtk::ApplicationWindow::builder().build()
    }

    fn init(
        control_url: Self::Init,
        window: Self::Root,
        sender: ComponentSender<Self>,
    ) -> ComponentParts<Self> {
        window.set_title(Some("Brain Hub (Relm4)"));
        window.set_default_size(900, 600);

        let main_box = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(8)
            .margin_top(12)
            .margin_bottom(12)
            .margin_start(12)
            .margin_end(12)
            .build();

        // status row
        let status_row = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(8)
            .build();
        let status_label = gtk::Label::builder()
            .hexpand(true)
            .wrap(true)
            .label("Status: pending...")
            .build();
        status_row.append(&status_label);
        let refresh_button = gtk::Button::with_label("Refresh Status");
        {
            let sender = sender.clone();
            refresh_button.connect_clicked(move |_| {
                sender.input(AppMsg::FetchStatus);
            });
        }
        status_row.append(&refresh_button);
        main_box.append(&status_row);

        // List files button
        let list_files_button = gtk::Button::with_label("List Files");
        {
            let sender = sender.clone();
            list_files_button.connect_clicked(move |_| {
                sender.input(AppMsg::FetchFiles);
            });
        }
        main_box.append(&list_files_button);

        // Show peers button
        let peers_button = gtk::Button::with_label("Show Peers");
        {
            let sender = sender.clone();
            peers_button.connect_clicked(move |_| {
                sender.input(AppMsg::Log("peers command requested".into()));
                sender.input(AppMsg::SendCommand("peers".into()));
            });
        }
        main_box.append(&peers_button);

        // command row
        let command_row = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(6)
            .build();
        let command_label = gtk::Label::new(Some("Command:"));
        command_row.append(&command_label);
        let command_entry = gtk::Entry::builder()
            .hexpand(true)
            .placeholder_text("e.g. audio list")
            .build();
        {
            let sender = sender.clone();
            command_entry.connect_activate(move |entry| {
                sender.input(AppMsg::SendCommand(entry.text().to_string()));
            });
        }
        command_row.append(&command_entry);
        let command_button = gtk::Button::with_label("Send");
        {
            let sender = sender.clone();
            let entry = command_entry.clone();
            command_button.connect_clicked(move |_| {
                sender.input(AppMsg::SendCommand(entry.text().to_string()));
            });
        }
        command_row.append(&command_button);
        main_box.append(&command_row);

        // play row
        let play_row = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(6)
            .build();
        let play_label = gtk::Label::new(Some("Play filename:"));
        play_row.append(&play_label);
        let play_entry = gtk::Entry::builder().hexpand(true).build();
        play_row.append(&play_entry);
        let play_button = gtk::Button::with_label("Play");
        {
            let sender = sender.clone();
            let entry = play_entry.clone();
            play_button.connect_clicked(move |_| {
                sender.input(AppMsg::Play(entry.text().to_string()));
            });
        }
        play_row.append(&play_button);
        main_box.append(&play_row);

        // broadcast row
        let broadcast_row = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(6)
            .build();
        let broadcast_label = gtk::Label::new(Some("Broadcast message:"));
        broadcast_row.append(&broadcast_label);
        let broadcast_entry = gtk::Entry::builder().hexpand(true).build();
        broadcast_row.append(&broadcast_entry);
        let broadcast_button = gtk::Button::with_label("Broadcast");
        {
            let sender = sender.clone();
            let entry = broadcast_entry.clone();
            broadcast_button.connect_clicked(move |_| {
                sender.input(AppMsg::Broadcast(entry.text().to_string()));
            });
        }
        broadcast_row.append(&broadcast_button);
        let broadcast_play_button = gtk::Button::with_label("Broadcast Play");
        {
            let sender = sender.clone();
            let entry = play_entry.clone();
            broadcast_play_button.connect_clicked(move |_| {
                sender.input(AppMsg::BroadcastPlay(entry.text().to_string()));
            });
        }
        broadcast_row.append(&broadcast_play_button);
        main_box.append(&broadcast_row);

        // upload row
        let upload_row = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(6)
            .build();
        let choose_button = gtk::Button::with_label("Choose File");
        upload_row.append(&choose_button);
        let remote_label = gtk::Label::new(Some("Remote name:"));
        upload_row.append(&remote_label);
        let upload_name_entry = gtk::Entry::builder()
            .hexpand(true)
            .placeholder_text("leave blank to use file name")
            .build();
        upload_row.append(&upload_name_entry);
        let upload_button = gtk::Button::with_label("Upload");
        {
            let sender = sender.clone();
            let entry = upload_name_entry.clone();
            upload_button.connect_clicked(move |_| {
                sender.input(AppMsg::StartUpload {
                    remote: entry.text().to_string(),
                });
            });
        }
        upload_row.append(&upload_button);
        {
            let sender = sender.clone();
            let window_clone = window.clone();
            let upload_entry = upload_name_entry.clone();
            choose_button.connect_clicked(move |_| {
                let dialog = gtk::FileChooserNative::new(
                    Some("Select file to upload"),
                    Some(&window_clone),
                    gtk::FileChooserAction::Open,
                    Some("Select"),
                    Some("Cancel"),
                );
                let sender_clone = sender.clone();
                let entry_clone = upload_entry.clone();
                dialog.connect_response(move |dialog, response| {
                    if response == gtk::ResponseType::Accept {
                        if let Some(file) = dialog.file() {
                            if let Some(path) = file.path() {
                                if let Some(name) = file_name_from_path(&path) {
                                    entry_clone.set_text(&name);
                                }
                                sender_clone.input(AppMsg::UploadFileChosen(Some(path)));
                            }
                        }
                    }
                    dialog.destroy();
                });
                dialog.show();
            });
        }
        main_box.append(&upload_row);

        // audio frame
        let audio_flow = gtk::FlowBox::builder()
            .column_spacing(6)
            .row_spacing(6)
            .max_children_per_line(3)
            .selection_mode(gtk::SelectionMode::None)
            .build();
        let audio_scroll = gtk::ScrolledWindow::builder()
            .hexpand(true)
            .min_content_height(160)
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .child(&audio_flow)
            .build();
        let audio_frame = gtk::Frame::builder()
            .label("Remote Audio Files")
            .child(&audio_scroll)
            .build();
        main_box.append(&audio_frame);

        // log view
        let log_view = gtk::TextView::builder()
            .editable(false)
            .wrap_mode(gtk::WrapMode::WordChar)
            .build();
        let log_buffer = log_view.buffer();
        let log_scroll = gtk::ScrolledWindow::builder()
            .hexpand(true)
            .vexpand(true)
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .child(&log_view)
            .build();
        main_box.append(&log_scroll);

        window.set_child(Some(&main_box));

        let widgets = AppWidgets {
            _window: window.clone(),
            _main_box: main_box,
            status_label,
            _command_entry: command_entry,
            _play_entry: play_entry,
            _broadcast_entry: broadcast_entry,
            _upload_name_entry: upload_name_entry,
            audio_flow,
            log_view,
            log_buffer,
        };

        let model = AppModel {
            control_url,
            socket: None,
            log_lines: VecDeque::with_capacity(LOG_LIMIT),
            status_label: "Status: pending...".into(),
            audio_files: Vec::new(),
            audio_error: None,
            log_limit: LOG_LIMIT,
            upload_path: None,
            input_sender: sender.input_sender().clone(),
            connecting: false,
            reconnect_pending: false,
        };

        sender.input(AppMsg::Initialize);

        ComponentParts { model, widgets }
    }

    fn update(&mut self, msg: AppMsg, _sender: ComponentSender<Self>) {
        match msg {
            AppMsg::Initialize => {
                self.log("Control URL: ".to_string() + self.control_url.as_str());
                self.status_label = "Status: connecting...".into();
                self.start_connect();
            }
            AppMsg::SocketConnected(result) => {
                self.connecting = false;
                self.reconnect_pending = false;
                match result {
                    Ok((client, address)) => {
                        self.log(format!("socket connected: {address}"));
                        self.socket = Some(client);
                        self.status_label = "Status: connected".into();
                        self.schedule_fetch_status();
                    }
                    Err(err) => {
                        self.socket = None;
                        self.log(format!("socket connect error: {err}"));
                        self.status_label = "Status: disconnected".into();
                        self.schedule_reconnect();
                    }
                }
            }
            AppMsg::SocketEvent(message) => self.handle_socket_event(message),
            AppMsg::FetchStatus => self.schedule_fetch_status(),
            AppMsg::StatusFetched(result) => match result {
                Ok(update) => {
                    let host = update
                        .status
                        .host
                        .clone()
                        .unwrap_or_else(|| "unknown".into());
                    let connected = update.status.connected;
                    let file_count = update.files.len();
                    self.apply_status_update(&update);
                    self.log(format!("status ok: host={} connected={}", host, connected));
                    match update.audio_error {
                        Some(err) => self.log(format!("audio list error: {err}")),
                        None if file_count == 0 => self.log("audio list empty"),
                        None => {
                            let preview: Vec<_> = update
                                .files
                                .iter()
                                .take(6)
                                .map(|f| f.name.as_str())
                                .collect();
                            self.log(format!(
                                "audio list ({}): {}",
                                file_count,
                                preview.join(", ")
                            ));
                        }
                    }
                }
                Err(err) => self.log(format!("status error: {err}")),
            },
            AppMsg::FetchFiles => self.schedule_fetch_files(),
            AppMsg::FilesFetched(result) => match result {
                Ok(files) => {
                    let mut preview = files.clone();
                    if preview.len() > 12 {
                        preview.truncate(12);
                    }
                    self.log(format!("files ({}): {}", files.len(), preview.join(", ")));
                }
                Err(err) => self.log(format!("files error: {err}")),
            },
            AppMsg::SendCommand(command) => {
                let trimmed = command.trim();
                if trimmed.is_empty() {
                    self.log("command empty");
                } else {
                    self.schedule_command(trimmed.to_string());
                }
            }
            AppMsg::CommandResult(result) => match result {
                Ok(value) => {
                    let encoded = value
                        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "null".into()))
                        .unwrap_or_else(|| "null".into());
                    self.log(format!("command result: {encoded}"));
                }
                Err(err) => self.log(format!("command error: {err}")),
            },
            AppMsg::Play(name) => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    self.log("play filename missing");
                } else {
                    self.schedule_simple_action(
                        "play",
                        json_object(vec![("filename", Value::String(trimmed.to_string()))]),
                        format!("play invoked: {trimmed}"),
                    );
                }
            }
            AppMsg::Broadcast(message) => {
                let trimmed = message.trim();
                if trimmed.is_empty() {
                    self.log("broadcast message missing");
                } else {
                    self.schedule_simple_action(
                        "broadcast",
                        json_object(vec![("message", Value::String(trimmed.to_string()))]),
                        "broadcast sent".into(),
                    );
                }
            }
            AppMsg::BroadcastPlay(name) => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    self.log("broadcast play filename missing");
                } else {
                    self.schedule_simple_action(
                        "broadcast-play",
                        json_object(vec![("filename", Value::String(trimmed.to_string()))]),
                        format!("broadcast play sent: {trimmed}"),
                    );
                }
            }
            AppMsg::StartUpload { remote } => {
                let path = match self.upload_path.clone() {
                    Some(path) => path,
                    None => {
                        self.log("no upload file selected");
                        return;
                    }
                };
                let remote_name = {
                    let trimmed = remote.trim();
                    if trimmed.is_empty() {
                        file_name_from_path(&path).unwrap_or_else(|| "upload.bin".into())
                    } else {
                        trimmed.to_string()
                    }
                };
                self.schedule_upload(path, remote_name);
            }
            AppMsg::UploadResult(result) => match result {
                Ok(resp) => {
                    self.log(format!(
                        "upload complete: {} ({} bytes)",
                        resp.filename, resp.size
                    ));
                    self.schedule_fetch_status();
                }
                Err(err) => self.log(format!("upload error: {err}")),
            },
            AppMsg::UploadFileChosen(path) => {
                if let Some(path) = path {
                    self.upload_path = Some(path.clone());
                    self.log(format!("upload selected: {}", path.display()));
                }
            }
            AppMsg::Log(text) => self.log(text),
            AppMsg::RetryConnect => {
                self.reconnect_pending = false;
                if self.socket.is_some() {
                    self.status_label = "Status: connected".into();
                    return;
                }
                self.start_connect();
            }
        }
    }

    fn update_view(&self, widgets: &mut Self::Widgets, _sender: ComponentSender<Self>) {
        widgets.status_label.set_text(&self.status_label);

        while let Some(child) = widgets.audio_flow.first_child() {
            widgets.audio_flow.remove(&child);
        }

        if let Some(err) = &self.audio_error {
            let label = gtk::Label::new(Some(&format!("Audio error: {err}")));
            label.set_xalign(0.0);
            label.set_margin_all(6);
            widgets.audio_flow.append(&label);
        } else if self.audio_files.is_empty() {
            let label = gtk::Label::new(Some("No audio files found"));
            label.set_xalign(0.0);
            label.set_margin_all(6);
            widgets.audio_flow.append(&label);
        } else {
            for file in &self.audio_files {
                let button = gtk::Button::with_label(&format_audio_button_label(file));
                button.set_tooltip_text(Some(&format!("Broadcast play {}", file.name)));
                button.set_hexpand(false);
                button.set_vexpand(false);
                button.set_halign(gtk::Align::Fill);
                button.set_valign(gtk::Align::Center);
                button.set_margin_all(4);
                button.set_size_request(220, 36);
                let filename = file.name.clone();
                let sender = self.input_sender.clone();
                button.connect_clicked(move |_| {
                    let _ = sender.send(AppMsg::BroadcastPlay(filename.clone()));
                });
                widgets.audio_flow.append(&button);
            }
        }

        let mut text = String::with_capacity(self.log_lines.len() * 32);
        for entry in &self.log_lines {
            text.push_str(entry);
        }
        widgets.log_buffer.set_text(&text);
        let mut iter = widgets.log_buffer.end_iter();
        widgets
            .log_view
            .scroll_to_iter(&mut iter, 0.0, false, 0.0, 1.0);
    }
}

impl Drop for AppModel {
    fn drop(&mut self) {
        if let Some(socket) = &self.socket {
            socket.close();
        }
    }
}

impl AppModel {
    fn start_connect(&mut self) {
        if self.socket.is_some() {
            return;
        }
        if self.connecting {
            return;
        }
        self.connecting = true;
        self.status_label = "Status: connecting...".into();
        let url = self.control_url.clone();
        let sender = self.input_sender.clone();
        thread::spawn(move || {
            let address = match compute_socket_address(&url) {
                Ok(addr) => addr,
                Err(err) => {
                    sender.send(AppMsg::SocketConnected(Err(err))).ok();
                    return;
                }
            };
            sender
                .send(AppMsg::Log(format!("attempting socket connect: {address}")))
                .ok();
            let (event_tx, event_rx) = mpsc::channel();
            match SocketClient::connect(&address, event_tx) {
                Ok(client) => {
                    let event_sender = sender.clone();
                    thread::spawn(move || {
                        while let Ok(event) = event_rx.recv() {
                            if event_sender.send(AppMsg::SocketEvent(event)).is_err() {
                                break;
                            }
                        }
                    });
                    sender
                        .send(AppMsg::SocketConnected(Ok((client, address))))
                        .ok();
                }
                Err(err) => {
                    sender
                        .send(AppMsg::SocketConnected(Err(err.to_string())))
                        .ok();
                }
            }
        });
    }

    fn schedule_fetch_status(&mut self) {
        let Some(socket) = self.socket.clone() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let sender = self.input_sender.clone();
        thread::spawn(move || {
            let result = fetch_status(socket);
            sender.send(AppMsg::StatusFetched(result)).ok();
        });
    }

    fn schedule_fetch_files(&mut self) {
        let Some(socket) = self.socket.clone() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let sender = self.input_sender.clone();
        thread::spawn(move || {
            let result = fetch_files(socket);
            sender.send(AppMsg::FilesFetched(result)).ok();
        });
    }

    fn schedule_command(&mut self, command: String) {
        let Some(socket) = self.socket.clone() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let sender = self.input_sender.clone();
        thread::spawn(move || {
            let mut payload = JsonMap::new();
            payload.insert("command".into(), Value::String(command));
            let result = socket
                .request("command", Some(payload))
                .map_err(|e| e.to_string())
                .and_then(|msg| parse_data::<CommandResponse>(msg.data).map_err(|e| e.to_string()))
                .map(|res| res.result);
            sender.send(AppMsg::CommandResult(result)).ok();
        });
    }

    fn schedule_simple_action(
        &mut self,
        action: &str,
        payload: Option<JsonMap<String, Value>>,
        success_message: String,
    ) {
        let Some(socket) = self.socket.clone() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let sender = self.input_sender.clone();
        let action_name = action.to_string();
        thread::spawn(move || {
            let response = socket
                .request(&action_name, payload)
                .map_err(|e| e.to_string());
            match response {
                Ok(_) => {
                    sender.send(AppMsg::Log(success_message)).ok();
                }
                Err(err) => {
                    sender
                        .send(AppMsg::Log(format!("{action_name} error: {err}")))
                        .ok();
                }
            }
        });
    }

    fn schedule_upload(&mut self, path: PathBuf, remote: String) {
        let Some(socket) = self.socket.clone() else {
            self.log("socket not connected");
            self.schedule_reconnect();
            return;
        };
        let sender = self.input_sender.clone();
        thread::spawn(move || {
            let data = std::fs::read(&path).map_err(|e| format!("read error: {e}"));
            let result = data.and_then(|bytes| {
                let mut payload = JsonMap::new();
                payload.insert("filename".into(), Value::String(remote.clone()));
                payload.insert("base64".into(), Value::String(Base64Engine.encode(bytes)));
                payload.insert(
                    "contentType".into(),
                    Value::String(detect_content_type(&remote).to_string()),
                );
                socket
                    .request("upload", Some(payload))
                    .map_err(|e| e.to_string())
                    .and_then(|msg| {
                        parse_data::<UploadResponse>(msg.data).map_err(|e| e.to_string())
                    })
            });
            sender.send(AppMsg::UploadResult(result)).ok();
        });
    }

    fn apply_status_update(&mut self, update: &StatusUpdate) {
        let host = update
            .status
            .host
            .clone()
            .unwrap_or_else(|| "unknown".into());
        self.status_label = format!("Status: {} (connected={})", host, update.status.connected);
        self.audio_files = update.files.clone();
        self.audio_error = update.audio_error.clone();
    }

    fn handle_socket_event(&mut self, message: SocketMessage) {
        let Some(event) = message.event.as_deref() else {
            return;
        };
        match event {
            "hello" => {
                if let Some(payload) = message.payload {
                    if let Some(info) = payload.as_object() {
                        let host = info
                            .get("host")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        let since = info
                            .get("connectedAt")
                            .and_then(Value::as_str)
                            .unwrap_or("?");
                        self.log(format!("socket hello from {host} (since {since})"));
                    } else if let Some(text) = payload.as_str() {
                        self.log(format!("socket hello: {}", text.trim()));
                    } else if let Ok(text) = serde_json::to_string(&payload) {
                        self.log(format!("socket hello: {text}"));
                    }
                } else {
                    self.log("socket hello");
                }
            }
            "status" => {
                if let Some(payload) = message.payload {
                    match serde_json::from_value::<StatusResponse>(payload.clone()) {
                        Ok(status) => {
                            let (files, audio_error) = parse_audio_list(status.audio_list.clone());
                            let update = StatusUpdate {
                                status,
                                files,
                                audio_error,
                            };
                            let host = update
                                .status
                                .host
                                .clone()
                                .unwrap_or_else(|| "unknown".into());
                            let connected = update.status.connected;
                            let file_count = update.files.len();
                            self.apply_status_update(&update);
                            self.log(format!(
                                "socket status update: host={} connected={} files={}",
                                host, connected, file_count
                            ));
                            match update.audio_error {
                                Some(err) => self.log(format!("audio list error: {err}")),
                                None if file_count == 0 => self.log("audio list empty"),
                                None => {
                                    let preview: Vec<_> = update
                                        .files
                                        .iter()
                                        .take(6)
                                        .map(|f| f.name.as_str())
                                        .collect();
                                    self.log(format!(
                                        "audio list ({}): {}",
                                        file_count,
                                        preview.join(", ")
                                    ));
                                }
                            }
                        }
                        Err(err) => self.log(format!("socket status parse error: {err}")),
                    }
                }
            }
            "hub-message" => {
                if let Some(payload) = message.payload {
                    match serde_json::to_string(&payload) {
                        Ok(text) => self.log(format!("hub message: {text}")),
                        Err(err) => self.log(format!("hub message encode error: {err}")),
                    }
                } else {
                    self.log("hub message (empty)");
                }
            }
            "broadcast-play" => {
                if let Some(payload) = message.payload {
                    match serde_json::from_value::<BroadcastPlayEvent>(payload) {
                        Ok(event) => {
                            let label = if event.from.is_empty() {
                                "unknown"
                            } else {
                                &event.from
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
            "log" => {
                if let Some(payload) = message.payload {
                    if let Some(text) = payload.as_str() {
                        self.log(format!("log event: {}", text.trim()));
                    } else {
                        self.log("log event received");
                    }
                }
            }
            "error" => {
                if let Some(err) = message.error {
                    self.log(format!("socket error event: {err}"));
                } else {
                    self.log("socket error event");
                }
                if self.socket.is_none() {
                    self.schedule_reconnect();
                }
            }
            "disconnect" => {
                if let Some(err) = message.error {
                    self.log(format!("socket disconnected: {err}"));
                } else {
                    self.log("socket disconnected");
                }
                self.socket = None;
                self.schedule_reconnect();
            }
            other => {
                self.log(format!("socket event {other}"));
            }
        }
    }

    fn schedule_reconnect(&mut self) {
        if self.connecting || self.reconnect_pending {
            return;
        }
        self.reconnect_pending = true;
        self.status_label = "Status: reconnecting...".into();
        let sender = self.input_sender.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            sender.send(AppMsg::RetryConnect).ok();
        });
    }

    fn log(&mut self, text: impl Into<String>) {
        let timestamp = Local::now().format("%H:%M:%S");
        let line = format!("[{}] {}\n", timestamp, text.into());
        if self.log_lines.len() >= self.log_limit {
            self.log_lines.pop_front();
        }
        self.log_lines.push_back(line);
    }
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct BroadcastPlayEvent {
    filename: String,
    #[serde(default)]
    from: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(rename = "self", default)]
    is_self: bool,
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

fn fetch_files(socket: SharedSocketClient) -> Result<Vec<String>, String> {
    let message = socket.request("files", None).map_err(|e| e.to_string())?;
    let response: FilesResponse = parse_data(message.data).map_err(|e| e.to_string())?;
    Ok(response.files)
}

fn parse_data<T: DeserializeOwned>(data: Option<Value>) -> Result<T, serde_json::Error> {
    match data {
        Some(value) => serde_json::from_value(value),
        None => serde_json::from_value(Value::Null),
    }
}

fn parse_audio_list(raw: Option<Value>) -> (Vec<AudioFile>, Option<String>) {
    match raw {
        None | Some(Value::Null) => (Vec::new(), None),
        Some(Value::Object(map)) => {
            if let Some(Value::String(err)) = map.get("error") {
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
            if let Some(Value::String(name)) = map.get("name") {
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
            if let Some(Value::String(key)) = map.get("key") {
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
        Some(Value::Array(items)) => {
            let mut files = Vec::new();
            for item in items {
                match item {
                    Value::String(name) => {
                        if !name.is_empty() {
                            files.push(AudioFile {
                                name,
                                size: None,
                                uploaded: None,
                            });
                        }
                    }
                    Value::Object(map) => {
                        let name = map
                            .get("name")
                            .and_then(Value::as_str)
                            .or_else(|| map.get("key").and_then(Value::as_str));
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

fn parse_audio_size(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    }
}

fn format_audio_button_label(file: &AudioFile) -> String {
    let mut parts = vec![file.name.clone()];
    if let Some(size) = file.size {
        if size > 0 {
            parts.push(format!("({})", format_bytes(size)));
        }
    }
    if let Some(uploaded) = &file.uploaded {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(uploaded) {
            parts.push(format!(
                "@ {}",
                parsed.with_timezone(&Local).format("%Y-%m-%d")
            ));
        } else {
            parts.push(format!("@ {uploaded}"));
        }
    }
    parts.join(" ")
}

fn format_bytes(size: i64) -> String {
    if size <= 0 {
        return "0 B".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = size as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if value < 10.0 && unit > 0 {
        format!("{value:.1} {}", units[unit])
    } else {
        format!("{value:.0} {}", units[unit])
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
    if let Ok(port_var) = env::var("CLIENT_SOCKET_PORT") {
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

fn json_object(entries: Vec<(&str, Value)>) -> Option<JsonMap<String, Value>> {
    if entries.is_empty() {
        return None;
    }
    let mut map = JsonMap::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Some(map)
}

fn parse_control_url() -> Url {
    let control =
        env::var("CLIENT_CONTROL_URL").unwrap_or_else(|_| DEFAULT_CONTROL_URL.to_string());
    Url::parse(&control).unwrap_or_else(|err| {
        eprintln!("invalid CLIENT_CONTROL_URL: {err}");
        std::process::exit(1);
    })
}

fn main() {
    let control_url = parse_control_url();
    let app = RelmApp::new("com.example.brainhub");
    app.run::<AppModel>(control_url);
}
