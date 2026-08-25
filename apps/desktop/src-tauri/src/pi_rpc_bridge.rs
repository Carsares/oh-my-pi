#![allow(dead_code)]

use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeFrame {
    Event(Value),
    ExtensionUi(Value),
    ProtocolError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    ProcessClosed,
    Timeout,
    Transport(String),
}

impl BridgeError {
    pub fn is_process_closed(&self) -> bool {
        matches!(self, Self::ProcessClosed)
    }
}

type PendingSender = oneshot::Sender<Result<Value, BridgeError>>;

struct PendingRequest {
    command: String,
    sender: PendingSender,
}

struct BridgeInner {
    next_id: AtomicU64,
    outbound: mpsc::Sender<Value>,
    frames: Mutex<mpsc::Receiver<BridgeFrame>>,
    pending: Mutex<HashMap<String, PendingRequest>>,
}

#[derive(Clone)]
pub struct PiRpcBridge {
    inner: Arc<BridgeInner>,
}

pub struct InMemoryPiProcess {
    outbound: mpsc::Receiver<Value>,
    incoming: Option<mpsc::Sender<Vec<u8>>>,
}

pub struct PiRpcProcess {
    child: Arc<StdMutex<Child>>,
    diagnostics: std::sync::mpsc::Receiver<String>,
}

impl PiRpcBridge {
    pub fn attach(
        mut child: Child,
        max_frame_bytes: usize,
    ) -> Result<(Self, PiRpcProcess), String> {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "OMP RPC process stdin is not piped".to_string())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "OMP RPC process stdout is not piped".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "OMP RPC process stderr is not piped".to_string())?;
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Value>(64);
        let (incoming_tx, incoming_rx) = mpsc::channel::<Vec<u8>>(64);
        let (frame_tx, frame_rx) = mpsc::channel(64);
        let inner = Arc::new(BridgeInner {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            frames: Mutex::new(frame_rx),
            pending: Mutex::new(HashMap::new()),
        });
        // `attach` is called synchronously from the Tauri `setup` hook (main
        // thread, no entered Tokio runtime), so a bare `tokio::spawn` here
        // panics with "there is no reactor running". `tauri::async_runtime::spawn`
        // holds Tauri's global runtime handle internally and works from any
        // thread — same pattern as `broker_ws.rs`.
        tauri::async_runtime::spawn(read_frames(
            incoming_rx,
            frame_tx,
            Arc::clone(&inner),
            max_frame_bytes,
        ));

        std::thread::Builder::new()
            .name("picot-pi-rpc-writer".into())
            .spawn(move || {
                while let Some(frame) = outbound_rx.blocking_recv() {
                    let mut encoded = frame.to_string();
                    encoded.push('\n');
                    if stdin.write_all(encoded.as_bytes()).is_err() || stdin.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Cannot start OMP RPC writer: {error}"))?;

        std::thread::Builder::new()
            .name("picot-pi-rpc-reader".into())
            .spawn(move || read_jsonl_stdout(&mut stdout, incoming_tx, max_frame_bytes))
            .map_err(|error| format!("Cannot start OMP RPC reader: {error}"))?;

        let (diagnostic_tx, diagnostic_rx) = std::sync::mpsc::sync_channel(64);
        std::thread::Builder::new()
            .name("picot-pi-rpc-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let bounded: String = line.chars().take(4096).collect();
                    let _ = diagnostic_tx.try_send(bounded);
                }
            })
            .map_err(|error| format!("Cannot start OMP RPC stderr reader: {error}"))?;

        Ok((
            Self { inner },
            PiRpcProcess {
                child: Arc::new(StdMutex::new(child)),
                diagnostics: diagnostic_rx,
            },
        ))
    }

    #[cfg(test)]
    pub(crate) fn in_memory(max_frame_bytes: usize) -> (Self, InMemoryPiProcess) {
        let (outbound_tx, outbound_rx) = mpsc::channel(32);
        let (incoming_tx, incoming_rx) = mpsc::channel(32);
        let (frame_tx, frame_rx) = mpsc::channel(32);
        let inner = Arc::new(BridgeInner {
            next_id: AtomicU64::new(1),
            outbound: outbound_tx,
            frames: Mutex::new(frame_rx),
            pending: Mutex::new(HashMap::new()),
        });
        tokio::spawn(read_frames(
            incoming_rx,
            frame_tx,
            Arc::clone(&inner),
            max_frame_bytes,
        ));
        (
            Self { inner },
            InMemoryPiProcess {
                outbound: outbound_rx,
                incoming: Some(incoming_tx),
            },
        )
    }

    pub async fn request(
        &self,
        mut command: Value,
        timeout: Duration,
    ) -> Result<Value, BridgeError> {
        let id = format!(
            "picot-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let object = command
            .as_object_mut()
            .ok_or_else(|| BridgeError::Transport("RPC command must be an object".into()))?;
        let command_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        object.insert("id".into(), Value::String(id.clone()));

        let (response_tx, response_rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(
                id.clone(),
                PendingRequest {
                    command: command_type,
                    sender: response_tx,
                },
            );
        if self.inner.outbound.send(command).await.is_err() {
            self.inner.pending.lock().await.remove(&id);
            return Err(BridgeError::ProcessClosed);
        }

        match tokio::time::timeout(timeout, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BridgeError::ProcessClosed),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(BridgeError::Timeout)
            }
        }
    }

    pub async fn send_frame(&self, frame: Value) -> Result<(), BridgeError> {
        self.inner
            .outbound
            .send(frame)
            .await
            .map_err(|_| BridgeError::ProcessClosed)
    }

    pub async fn next_frame(&self) -> Option<BridgeFrame> {
        self.inner.frames.lock().await.recv().await
    }
}

impl PiRpcProcess {
    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, String> {
        self.child
            .lock()
            .map_err(|_| "OMP RPC process lock poisoned".to_string())?
            .try_wait()
            .map_err(|error| format!("Cannot inspect OMP RPC process: {error}"))
    }

    pub fn wait(&mut self) -> Result<ExitStatus, String> {
        self.child
            .lock()
            .map_err(|_| "OMP RPC process lock poisoned".to_string())?
            .wait()
            .map_err(|error| format!("Cannot wait for OMP RPC process: {error}"))
    }

    pub fn kill(&mut self) -> Result<(), String> {
        self.child
            .lock()
            .map_err(|_| "OMP RPC process lock poisoned".to_string())?
            .kill()
            .map_err(|error| format!("Cannot stop OMP RPC process: {error}"))
    }

    pub fn take_diagnostic(&self) -> Option<String> {
        self.diagnostics.try_recv().ok()
    }
}

fn read_jsonl_stdout(
    stdout: &mut impl Read,
    incoming: mpsc::Sender<Vec<u8>>,
    max_frame_bytes: usize,
) {
    let mut chunk = [0_u8; 8192];
    let mut frame = Vec::new();
    let mut oversized = false;
    loop {
        let read = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                if oversized {
                    if incoming
                        .blocking_send(vec![0; max_frame_bytes + 1])
                        .is_err()
                    {
                        return;
                    }
                } else {
                    if frame.last() == Some(&b'\r') {
                        frame.pop();
                    }
                    if incoming.blocking_send(std::mem::take(&mut frame)).is_err() {
                        return;
                    }
                }
                frame.clear();
                oversized = false;
            } else if !oversized {
                frame.push(*byte);
                if frame.len() > max_frame_bytes {
                    frame.clear();
                    oversized = true;
                }
            }
        }
    }
}

async fn read_frames(
    mut incoming: mpsc::Receiver<Vec<u8>>,
    frames: mpsc::Sender<BridgeFrame>,
    inner: Arc<BridgeInner>,
    max_frame_bytes: usize,
) {
    let mut chunks = None;
    let mut protocol_v2 = false;
    while let Some(raw) = incoming.recv().await {
        if raw.len() > max_frame_bytes {
            let _ = frames
                .send(BridgeFrame::ProtocolError(format!(
                    "OMP RPC frame exceeded {max_frame_bytes} bytes"
                )))
                .await;
            continue;
        }
        let parsed = match serde_json::from_slice::<Value>(&raw) {
            Ok(value) => value,
            Err(error) => {
                let _ = frames
                    .send(BridgeFrame::ProtocolError(format!(
                        "Invalid OMP RPC JSONL frame: {error}"
                    )))
                    .await;
                continue;
            }
        };
        let parsed = match parsed.get("type").and_then(Value::as_str) {
            Some("rpc_chunk") => match reassemble_rpc_chunk(&mut chunks, parsed, max_frame_bytes) {
                Ok(frame) => frame,
                Err(message) => {
                    chunks = None;
                    let _ = frames.send(BridgeFrame::ProtocolError(message)).await;
                    continue;
                }
            },
            _ => {
                if chunks.take().is_some() {
                    let _ = frames
                        .send(BridgeFrame::ProtocolError(
                            "RPC chunk sequence interrupted".into(),
                        ))
                        .await;
                }
                Some(parsed)
            }
        };
        let Some(parsed) = parsed else {
            continue;
        };
        if parsed.get("type").and_then(Value::as_str) == Some("ready") && !protocol_v2 {
            let supports_v2 = parsed
                .get("supportedProtocolVersions")
                .and_then(Value::as_array)
                .is_some_and(|versions| versions.iter().any(|version| version.as_u64() == Some(2)));
            if supports_v2 {
                protocol_v2 = true;
                if inner
                    .outbound
                    .send(serde_json::json!({
                        "type": "negotiate_protocol",
                        "protocolVersion": 2,
                    }))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
        if parsed.get("type").and_then(Value::as_str) == Some("response")
            && parsed.get("command").and_then(Value::as_str) == Some("negotiate_protocol")
            && parsed.get("id").is_none()
        {
            if parsed.get("success").and_then(Value::as_bool) != Some(true) {
                let message = parsed
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("OMP RPC protocol v2 negotiation failed");
                let _ = frames
                    .send(BridgeFrame::ProtocolError(message.to_owned()))
                    .await;
            }
            continue;
        }
        if let Some(id) = parsed.get("id").and_then(Value::as_str) {
            if let Some(pending) = inner.pending.lock().await.remove(id) {
                let _ = pending.sender.send(Ok(parsed));
                continue;
            }
        }
        if parsed.get("type").and_then(Value::as_str) == Some("response")
            && parsed.get("id").is_none()
        {
            let pending_id = if let Some(command) = parsed.get("command").and_then(Value::as_str) {
                inner
                    .pending
                    .lock()
                    .await
                    .iter()
                    .find(|(_, request)| request.command == command)
                    .map(|(id, _)| id.clone())
            } else {
                None
            };
            if let Some(pending_id) = pending_id {
                if let Some(pending) = inner.pending.lock().await.remove(&pending_id) {
                    let _ = pending.sender.send(Ok(parsed));
                    continue;
                }
            }
        }
        let frame = if parsed
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.starts_with("extension_ui"))
        {
            BridgeFrame::ExtensionUi(parsed)
        } else {
            BridgeFrame::Event(parsed)
        };
        let _ = frames.send(frame).await;
    }

    for (_, pending) in inner.pending.lock().await.drain() {
        let _ = pending.sender.send(Err(BridgeError::ProcessClosed));
    }
}

const RPC_CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_RPC_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;

struct PendingRpcChunks {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    next_index: usize,
    chunks: Vec<Vec<u8>>,
    received_bytes: usize,
}

fn reassemble_rpc_chunk(
    pending: &mut Option<PendingRpcChunks>,
    frame: Value,
    max_frame_bytes: usize,
) -> Result<Option<Value>, String> {
    let chunk_id = frame
        .get("chunkId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| "Invalid RPC chunk metadata".to_string())?;
    let index = frame
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Invalid RPC chunk metadata".to_string())?;
    let count = frame
        .get("count")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Invalid RPC chunk metadata".to_string())?;
    let byte_length = frame
        .get("byteLength")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Invalid RPC chunk metadata".to_string())?;
    let max_count = MAX_RPC_REASSEMBLED_BYTES.div_ceil(RPC_CHUNK_PAYLOAD_BYTES);
    if count < 2
        || count > max_count
        || index >= count
        || byte_length <= max_frame_bytes
        || byte_length > MAX_RPC_REASSEMBLED_BYTES
    {
        return Err("Invalid RPC chunk metadata".into());
    }
    let data = frame
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid RPC chunk data".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid RPC chunk data".to_string())?;
    if bytes.is_empty() || bytes.len() > RPC_CHUNK_PAYLOAD_BYTES {
        return Err("Invalid RPC chunk data".into());
    }
    if base64::engine::general_purpose::STANDARD.encode(&bytes) != data {
        return Err("Invalid RPC chunk data".into());
    }

    if pending.is_none() {
        if index != 0 {
            return Err("RPC chunk sequence must start at index 0".into());
        }
        *pending = Some(PendingRpcChunks {
            chunk_id: chunk_id.to_owned(),
            count,
            byte_length,
            next_index: 0,
            chunks: Vec::with_capacity(count),
            received_bytes: 0,
        });
    }
    let state = pending.as_mut().expect("pending chunks initialized");
    if state.chunk_id != chunk_id
        || state.count != count
        || state.byte_length != byte_length
        || state.next_index != index
    {
        return Err("RPC chunk sequence mismatch".into());
    }
    state.received_bytes += bytes.len();
    if state.received_bytes > state.byte_length {
        return Err("RPC chunk sequence exceeds declared length".into());
    }
    state.chunks.push(bytes);
    state.next_index += 1;
    if state.next_index < state.count {
        return Ok(None);
    }
    if state.received_bytes != state.byte_length {
        return Err("RPC chunk sequence length mismatch".into());
    }
    let state = pending.take().expect("completed chunks present");
    let bytes = state.chunks.into_iter().flatten().collect::<Vec<_>>();
    let text = String::from_utf8(bytes).map_err(|_| "Invalid UTF-8 RPC chunk frame".to_string())?;
    let value = serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("Invalid reassembled RPC frame: {error}"))?;
    if !value.is_object() {
        return Err("Reassembled RPC frame must be an object".into());
    }
    Ok(Some(value))
}

#[cfg(test)]
impl InMemoryPiProcess {
    pub(crate) async fn read_request(&mut self) -> Option<Value> {
        self.outbound.recv().await
    }

    pub(crate) fn try_read_request(&mut self) -> Option<Value> {
        self.outbound.try_recv().ok()
    }

    pub(crate) async fn write_frame(&mut self, value: Value) -> Result<(), BridgeError> {
        self.write_raw(format!("{}\n", value)).await
    }

    async fn write_raw(&mut self, raw: String) -> Result<(), BridgeError> {
        self.incoming
            .as_ref()
            .ok_or(BridgeError::ProcessClosed)?
            .send(raw.trim_end_matches('\n').as_bytes().to_vec())
            .await
            .map_err(|_| BridgeError::ProcessClosed)
    }

    async fn close(&mut self) {
        self.incoming.take();
    }
}

#[cfg(test)]
mod tests {
    use super::{BridgeFrame, PiRpcBridge};
    use base64::Engine;
    use serde_json::json;
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[tokio::test]
    async fn correlates_responses_and_surfaces_events() {
        let (bridge, mut process) = PiRpcBridge::in_memory(1024);

        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "get_state" }), Duration::from_secs(1))
                    .await
            }
        });

        let outbound = process.read_request().await.expect("request frame");
        assert_eq!(outbound["type"], "get_state");
        let id = outbound["id"].as_str().expect("native request id");

        process
            .write_frame(json!({ "id": id, "type": "response", "success": true }))
            .await
            .expect("response frame");
        assert_eq!(request.await.unwrap().unwrap()["success"], true);

        process
            .write_frame(json!({ "type": "agent_start" }))
            .await
            .expect("event frame");
        assert_eq!(
            bridge.next_frame().await,
            Some(BridgeFrame::Event(json!({ "type": "agent_start" })))
        );
    }

    #[tokio::test]
    async fn negotiates_protocol_v2_after_ready() {
        let (bridge, mut process) = PiRpcBridge::in_memory(1024);
        process
            .write_frame(json!({
                "type": "ready",
                "protocolVersion": 1,
                "supportedProtocolVersions": [1, 2]
            }))
            .await
            .unwrap();

        let negotiation = process.read_request().await.unwrap();
        assert_eq!(negotiation, json!({ "type": "negotiate_protocol", "protocolVersion": 2 }));
        assert_eq!(bridge.next_frame().await, Some(BridgeFrame::Event(json!({
            "type": "ready",
            "protocolVersion": 1,
            "supportedProtocolVersions": [1, 2]
        }))));

        process
            .write_frame(json!({
                "type": "response",
                "command": "negotiate_protocol",
                "success": true
            }))
            .await
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(20), bridge.next_frame())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reassembles_rpc_chunks_before_dispatching_the_logical_frame() {
        let (bridge, mut process) = PiRpcBridge::in_memory(1024);
        let logical = serde_json::to_vec(&json!({
            "type": "notice",
            "text": "a sufficiently long event payload ".repeat(40)
        }))
        .unwrap();
        let chunk_size = logical.len().div_ceil(4);
        for index in 0..4 {
            let start = index * chunk_size;
            let end = (start + chunk_size).min(logical.len());
            let chunk = &logical[start..end];
            process
                .write_frame(json!({
                    "type": "rpc_chunk",
                    "chunkId": "rpc-1",
                    "index": index,
                    "count": 4,
                    "byteLength": logical.len(),
                    "data": base64::engine::general_purpose::STANDARD.encode(chunk)
                }))
                .await
                .unwrap();
        }

        assert_eq!(
            bridge.next_frame().await,
            Some(BridgeFrame::Event(json!({
                "type": "notice",
                "text": "a sufficiently long event payload ".repeat(40)
            })))
        );
    }

    #[tokio::test]
    async fn correlates_unknown_command_errors_without_an_id() {
        let (bridge, mut process) = PiRpcBridge::in_memory(1024);
        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "unsupported_command" }), Duration::from_secs(1))
                    .await
            }
        });
        process.read_request().await.unwrap();
        process
            .write_frame(json!({
                "type": "response",
                "command": "unsupported_command",
                "success": false,
                "error": "Unknown command: unsupported_command"
            }))
            .await
            .unwrap();

        let response = request.await.unwrap().unwrap();
        assert_eq!(response["success"], false);
        assert_eq!(response["command"], "unsupported_command");
    }

    #[tokio::test]
    async fn rejects_oversized_frames_and_pending_requests_on_exit() {
        let (bridge, mut process) = PiRpcBridge::in_memory(32);
        let request = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .request(json!({ "type": "get_state" }), Duration::from_secs(1))
                    .await
            }
        });

        process.read_request().await.expect("request frame");
        process
            .write_raw(format!("{{\"value\":\"{}\"}}\n", "x".repeat(64)))
            .await
            .expect("oversized frame");

        assert!(matches!(
            bridge.next_frame().await,
            Some(BridgeFrame::ProtocolError(_))
        ));
        process.close().await;
        assert!(request.await.unwrap().unwrap_err().is_process_closed());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn attaches_to_a_real_jsonl_subprocess() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("IFS= read -r line; printf '%s\\n' '{\"id\":\"picot-1\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true}'")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let (bridge, mut process) = PiRpcBridge::attach(child, 1024).unwrap();

        let response = bridge
            .request(json!({ "type": "get_state" }), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(response["command"], "get_state");
        assert!(process.wait().unwrap().success());
    }
}
