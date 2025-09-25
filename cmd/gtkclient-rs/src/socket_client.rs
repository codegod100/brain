use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value};
use thiserror::Error;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Error)]
pub enum SocketError {
    #[allow(dead_code)]
    #[error("not connected")]
    NotConnected,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("socket request failed: {0}")]
    Message(String),
    #[error("socket request timed out")]
    Timeout,
    #[error("socket closed")]
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocketMessage {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

pub type SharedSocketClient = Arc<SocketClient>;

pub struct SocketClient {
    writer: Mutex<TcpStream>,
    pending: Mutex<HashMap<String, mpsc::Sender<SocketMessage>>>,
    request_id: AtomicU64,
    closed: AtomicBool,
    event_sender: mpsc::Sender<SocketMessage>,
}

impl fmt::Debug for SocketClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SocketClient").finish_non_exhaustive()
    }
}

impl SocketClient {
    pub fn connect(
        address: &str,
        event_sender: mpsc::Sender<SocketMessage>,
    ) -> Result<SharedSocketClient, SocketError> {
        let stream = TcpStream::connect(address)?;
        stream.set_nodelay(true)?;
        let reader_stream = stream.try_clone()?;

        let client = Arc::new(SocketClient {
            writer: Mutex::new(stream),
            pending: Mutex::new(HashMap::new()),
            request_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            event_sender,
        });

        SocketClient::start_reader(Arc::clone(&client), reader_stream);
        Ok(client)
    }

    pub fn request(
        &self,
        action: &str,
        payload: Option<JsonMap<String, Value>>,
    ) -> Result<SocketMessage, SocketError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(SocketError::Closed);
        }

        let id = self.next_id();
        let mut body = JsonMap::new();
        body.insert("id".into(), Value::String(id.clone()));
        body.insert("type".into(), Value::String(action.to_string()));
        if let Some(extra) = payload {
            for (key, value) in extra {
                body.insert(key, value);
            }
        }

        let mut encoded = serde_json::to_vec(&Value::Object(body))?;
        encoded.push(b'\n');

        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            pending.insert(id.clone(), tx);
        }

        {
            let mut writer = self.writer.lock().unwrap();
            if let Err(err) = writer.write_all(&encoded) {
                self.remove_pending(&id);
                return Err(SocketError::Io(err));
            }
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(message) => {
                if matches!(message.ok, Some(false)) {
                    let err_text = message
                        .error
                        .clone()
                        .unwrap_or_else(|| "socket request failed".to_string());
                    return Err(SocketError::Message(err_text));
                }
                Ok(message)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(&id);
                Err(SocketError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.remove_pending(&id);
                Err(SocketError::Closed)
            }
        }
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(writer) = self.writer.lock() {
            let _ = writer.shutdown(Shutdown::Both);
        }
        self.close_pending_with_error("socket closed");
    }

    fn start_reader(client: SharedSocketClient, reader_stream: TcpStream) {
        thread::spawn(move || {
            let mut reader = BufReader::new(reader_stream);
            let mut line = String::new();

            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        client.handle_disconnect(None);
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<SocketMessage>(trimmed) {
                            Ok(message) => {
                                if let Some(id) = message.id.clone() {
                                    client.deliver_response(id, message);
                                } else if message.msg_type == "event" {
                                    let _ = client.event_sender.send(message);
                                }
                            }
                            Err(err) => {
                                eprintln!("socket decode error: {err}");
                            }
                        }
                    }
                    Err(err) => {
                        client.handle_disconnect(Some(err.to_string()));
                        break;
                    }
                }
            }
        });
    }

    fn handle_disconnect(&self, error: Option<String>) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let message = SocketMessage {
            id: None,
            msg_type: "event".to_string(),
            ok: None,
            error: error.clone(),
            data: None,
            event: Some("disconnect".to_string()),
            payload: None,
        };
        let _ = self.event_sender.send(message);
        let err_text = error.unwrap_or_else(|| "socket closed".to_string());
        self.close_pending_with_error(&err_text);
    }

    fn close_pending_with_error(&self, text: &str) {
        let mut pending = self.pending.lock().unwrap();
        for (_, sender) in pending.drain() {
            let _ = sender.send(SocketMessage {
                id: None,
                msg_type: "error".to_string(),
                ok: Some(false),
                error: Some(text.to_string()),
                data: None,
                event: None,
                payload: None,
            });
        }
    }

    fn deliver_response(&self, id: String, message: SocketMessage) {
        let sender = {
            let mut pending = self.pending.lock().unwrap();
            pending.remove(&id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(message);
        }
    }

    fn remove_pending(&self, id: &str) {
        let mut pending = self.pending.lock().unwrap();
        pending.remove(id);
    }

    fn next_id(&self) -> String {
        let value = self.request_id.fetch_add(1, Ordering::SeqCst) + 1;
        format!("req-{value}")
    }
}

impl Drop for SocketClient {
    fn drop(&mut self) {
        self.close();
    }
}
