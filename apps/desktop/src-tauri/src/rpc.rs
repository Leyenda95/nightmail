//! JSON-RPC 2.0 client over a reader/writer pair (NDJSON).
//!
//! Generic over `AsyncRead`/`AsyncWrite`: the app connects it to the sidecar's stdio, tests to `tokio::io::duplex`.
//!
//! Guarantees:
//! - A single task writes; `call` only queues complete lines, so cancelling a `call` never leaves half a line.
//! - The `call` timeout covers both queueing and waiting for the response.
//! - A write stuck for longer than `write_timeout` closes the client (the supervisor then kills the process).
//! - Explicit closed state: once closed, `call` fails immediately.
//! - Abandoned requests (timeout, dropped future) are cleaned up automatically and the sidecar is asked to drop them
//!   (`$/cancel`).
//! - Params are serialised into a buffer wiped on drop (`Zeroizing`). Best effort only: intermediate `Vec`
//!   reallocations may leave copies.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::protocol::codes;

/// Maximum protocol line length (large responses such as `contract.snapshot`).
pub const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub enum RpcError {
    /// Error returned by the sidecar: JSON-RPC code, message (fixed, no sensitive data) and `data` with the reason
    /// when present (`CALL_REJECTED`, `STALE_STATE`, `NAME_REJECTED`…; the core reads it with `.ok()`).
    Remote { code: i64, message: String, data: Option<Value> },
    Timeout,
    /// The channel is closed (process died, write stuck, or shutdown).
    Closed,
    /// The response does not have the expected shape.
    BadResponse(String),
    /// The params could not be serialised.
    Encode(String),
}

/// Cap on the sidecar message when formatting it (the protocol bounds it, but a sidecar of another version might not).
const MESSAGE_SHOWN: usize = 80;

/// Like `Display`, without `data`.
impl std::fmt::Debug for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // `data` is not printed: it may carry `ageMs` or other details that must stay out of logs.
            RpcError::Remote { code, message, .. } => {
                let shown: String = message.chars().take(MESSAGE_SHOWN).collect();
                write!(f, "sidecar error {code}: {shown}")
            }
            RpcError::Timeout => write!(f, "sidecar timeout"),
            RpcError::Closed => write!(f, "sidecar closed"),
            RpcError::BadResponse(e) => write!(f, "bad sidecar response: {e}"),
            RpcError::Encode(e) => write!(f, "cannot encode params: {e}"),
        }
    }
}

impl std::error::Error for RpcError {}

/// Notification received from the sidecar (a message without `id`).
#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone)]
pub struct RpcOptions {
    pub write_timeout: Duration,
    pub max_line_bytes: usize,
    /// Write queue capacity (lines waiting to be written).
    pub queue: usize,
}

impl Default for RpcOptions {
    fn default() -> Self {
        Self { write_timeout: Duration::from_secs(10), max_line_bytes: MAX_LINE_BYTES, queue: 64 }
    }
}

type Reply = Result<Value, RpcError>;
/// `None` means the client is closed.
type Pending = Arc<Mutex<Option<HashMap<u32, oneshot::Sender<Reply>>>>>;
type Line = Zeroizing<Vec<u8>>;

pub struct RpcClient {
    tx: Mutex<Option<mpsc::Sender<Line>>>,
    pending: Pending,
    next_id: AtomicU32,
    // Only used by tests for now.
    #[allow(dead_code)]
    notifications: broadcast::Sender<Notification>,
}

impl std::fmt::Debug for RpcClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RpcClient").field("closed", &self.is_closed()).finish_non_exhaustive()
    }
}

/// Removes the request from `pending` on drop (timeout or dropped future).
struct PendingGuard {
    pending: Pending,
    id: u32,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(map) = self.pending.lock().unwrap().as_mut() {
            map.remove(&self.id);
        }
    }
}

/// Asks the sidecar to drop an already sent request if this is dropped without a response (timeout or dropped
/// future, e.g. the task aborted on lock), since nobody will use the result. Best effort: dropped if the queue is full.
struct CancelGuard {
    tx: Option<mpsc::Sender<Line>>,
    id: u32,
}

impl CancelGuard {
    fn answered(mut self) {
        self.tx = None;
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        let line = encode_line(&json!({ "jsonrpc": "2.0", "method": "$/cancel", "params": { "id": self.id } }));
        if let (Some(tx), Ok(line)) = (self.tx.take(), line) {
            let _ = tx.try_send(line);
        }
    }
}

fn close_pending(pending: &Pending) {
    let taken = pending.lock().unwrap().take();
    if let Some(map) = taken {
        for (_, tx) in map {
            let _ = tx.send(Err(RpcError::Closed));
        }
    }
}

impl RpcClient {
    /// Creates the client and spawns its read and write tasks. Requires a tokio runtime.
    pub fn new<R, W>(reader: R, writer: W, opts: RpcOptions) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(Some(HashMap::new())));
        let (tx, rx) = mpsc::channel::<Line>(opts.queue);
        let (notifications, _) = broadcast::channel(256);

        tokio::spawn(writer_loop(writer, rx, opts.write_timeout, pending.clone()));
        tokio::spawn(reader_loop(reader, opts.max_line_bytes, pending.clone(), notifications.clone()));

        Self { tx: Mutex::new(Some(tx)), pending, next_id: AtomicU32::new(1), notifications }
    }

    pub fn is_closed(&self) -> bool {
        self.pending.lock().unwrap().is_none()
    }

    /// Subscription to sidecar notifications (progress, etc.).
    #[allow(dead_code)]
    pub fn subscribe(&self) -> broadcast::Receiver<Notification> {
        self.notifications.subscribe()
    }

    /// Closes the client: fails pending calls and drops the writer (the sidecar sees EOF).
    pub fn close(&self) {
        self.tx.lock().unwrap().take();
        close_pending(&self.pending);
    }

    fn sender(&self) -> Result<mpsc::Sender<Line>, RpcError> {
        self.tx.lock().unwrap().clone().ok_or(RpcError::Closed)
    }

    /// Typed call.
    pub async fn call<P, R>(&self, method: &str, params: &P, timeout: Duration) -> Result<R, RpcError>
    where
        P: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let value = self.call_value(method, params, timeout).await?;
        serde_json::from_value(value).map_err(|e| RpcError::BadResponse(e.to_string()))
    }

    pub async fn call_value<P>(&self, method: &str, params: &P, timeout: Duration) -> Result<Value, RpcError>
    where
        P: Serialize + ?Sized,
    {
        let deadline = Instant::now() + timeout;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().unwrap();
            let map = guard.as_mut().ok_or(RpcError::Closed)?;
            map.insert(id, reply_tx);
        }
        let _guard = PendingGuard { pending: self.pending.clone(), id };

        let line = encode_line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let tx = self.sender()?;
        match tokio::time::timeout_at(deadline, tx.send(line)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(RpcError::Closed),
            Err(_) => return Err(RpcError::Timeout),
        }
        // Sent: if dropped without a response (deadline or dropped future), ask the sidecar to abandon it.
        let cancel = CancelGuard { tx: Some(tx), id };

        match tokio::time::timeout_at(deadline, reply_rx).await {
            Ok(Ok(reply)) => {
                cancel.answered();
                reply
            }
            Ok(Err(_)) => {
                cancel.answered();
                Err(RpcError::Closed)
            }
            Err(_) => Err(RpcError::Timeout),
        }
    }
}

fn encode_line(msg: &Value) -> Result<Line, RpcError> {
    let mut buf = Zeroizing::new(Vec::with_capacity(512));
    serde_json::to_writer(&mut *buf, msg).map_err(|e| RpcError::Encode(e.to_string()))?;
    buf.push(b'\n');
    Ok(buf)
}

async fn writer_loop<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut rx: mpsc::Receiver<Line>,
    write_timeout: Duration,
    pending: Pending,
) {
    while let Some(line) = rx.recv().await {
        let write = async {
            writer.write_all(&line).await?;
            writer.flush().await
        };
        match tokio::time::timeout(write_timeout, write).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                log::warn!("[sidecar] write error: {e}");
                break;
            }
            Err(_) => {
                log::warn!("[sidecar] write stuck for more than {write_timeout:?}: closing the channel");
                break;
            }
        }
    }
    close_pending(&pending);
    let _ = writer.shutdown().await;
}

/// Reads NDJSON lines. A line longer than `max_line_bytes` is discarded up to the next newline and reading continues
/// (a codec that ended the stream on that error would close the channel over a single line).
async fn reader_loop<R: AsyncRead + Unpin>(
    mut reader: R,
    max_line_bytes: usize,
    pending: Pending,
    notifications: broadcast::Sender<Notification>,
) {
    let mut line: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = vec![0u8; 64 * 1024];
    let mut discarding = false;
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) => {
                log::info!("[sidecar] end of the process output");
                break;
            }
            Ok(n) => n,
            Err(e) => {
                log::warn!("[sidecar] read error: {e}");
                break;
            }
        };
        let mut start = 0;
        while let Some(pos) = chunk[start..n].iter().position(|&b| b == b'\n') {
            let end = start + pos;
            if discarding {
                discarding = false;
            } else {
                line.extend_from_slice(&chunk[start..end]);
                if line.len() <= max_line_bytes {
                    handle_line(&line, &pending, &notifications);
                } else {
                    log::warn!("[sidecar] line longer than {max_line_bytes} bytes discarded");
                }
            }
            line.clear();
            start = end + 1;
        }
        if !discarding {
            line.extend_from_slice(&chunk[start..n]);
            if line.len() > max_line_bytes {
                log::warn!("[sidecar] line longer than {max_line_bytes} bytes discarded");
                discarding = true;
                line.clear();
            }
        }
    }
    close_pending(&pending);
}

fn handle_line(bytes: &[u8], pending: &Pending, notifications: &broadcast::Sender<Notification>) {
    let Ok(msg) = serde_json::from_slice::<Value>(bytes) else {
        log::warn!("[sidecar] non-JSON line ignored ({} bytes)", bytes.len());
        return;
    };
    match msg.get("id") {
        Some(Value::Number(n)) => {
            let Some(id) = n.as_u64().and_then(|v| u32::try_from(v).ok()) else {
                log::warn!("[sidecar] response with an invalid id");
                return;
            };
            let reply = match msg.get("error") {
                Some(err) => Err(RpcError::Remote {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(codes::INTERNAL_ERROR),
                    message: err.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                    data: err.get("data").cloned(),
                }),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let tx = pending.lock().unwrap().as_mut().and_then(|m| m.remove(&id));
            if let Some(tx) = tx {
                let _ = tx.send(reply);
            }
        }
        Some(Value::Null) => {
            let code = msg.pointer("/error/code").and_then(Value::as_i64);
            log::warn!("[sidecar] error without id (code {code:?}): probably a malformed request");
        }
        None => {
            if let Some(method) = msg.get("method").and_then(Value::as_str) {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let _ = notifications.send(Notification { method: method.to_string(), params });
            }
        }
        Some(_) => log::warn!("[sidecar] message with an id of unexpected type"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, duplex};

    /// Client connected to a simulated sidecar; returns the client and the peer ends.
    fn pair(opts: RpcOptions, buffer: usize) -> (RpcClient, BufReader<DuplexStream>, DuplexStream) {
        let (client_side_out, peer_in) = duplex(buffer); // client writes, peer reads
        let (peer_out, client_side_in) = duplex(buffer); // peer writes, client reads
        let client = RpcClient::new(client_side_in, client_side_out, opts);
        (client, BufReader::new(peer_in), peer_out)
    }

    async fn read_request(peer_in: &mut BufReader<DuplexStream>) -> Value {
        let mut line = String::new();
        peer_in.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }

    async fn reply(peer_out: &mut DuplexStream, msg: Value) {
        peer_out.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
    }

    const T: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn out_of_order_responses_reach_their_call() {
        let (client, mut peer_in, mut peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let client = Arc::new(client);
        let c1 = client.clone();
        let c2 = client.clone();
        let a = tokio::spawn(async move { c1.call_value("a", &json!(null), T).await });
        let b = tokio::spawn(async move { c2.call_value("b", &json!(null), T).await });
        let r1 = read_request(&mut peer_in).await;
        let r2 = read_request(&mut peer_in).await;
        // Reply in reverse order, echoing the method name.
        for r in [&r2, &r1] {
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":r["id"],"result":r["method"]})).await;
        }
        assert_eq!(a.await.unwrap().unwrap(), json!("a"));
        assert_eq!(b.await.unwrap().unwrap(), json!("b"));
    }

    #[tokio::test]
    async fn timeout_clears_pending_and_sends_cancel() {
        let (client, mut peer_in, _peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let err = client.call_value("lento", &json!(null), Duration::from_millis(100)).await.unwrap_err();
        assert_eq!(err, RpcError::Timeout);
        assert!(client.pending.lock().unwrap().as_ref().unwrap().is_empty());
        let req = read_request(&mut peer_in).await;
        let cancel = read_request(&mut peer_in).await;
        assert_eq!(cancel["method"], json!("$/cancel"));
        assert_eq!(cancel["params"]["id"], req["id"]);
        assert!(cancel.get("id").is_none(), "a notification carries no id");
    }

    #[tokio::test]
    async fn calls_fail_at_once_after_the_output_closes() {
        let (client, _peer_in, peer_out) = pair(RpcOptions::default(), 64 * 1024);
        drop(peer_out); // EOF: the "process" exited
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(client.is_closed());
        let start = std::time::Instant::now();
        let err = client.call_value("x", &json!(null), Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err, RpcError::Closed);
        assert!(start.elapsed() < Duration::from_secs(1), "must not wait for the timeout");
    }

    #[tokio::test]
    async fn dropped_future_leaks_nothing_and_asks_to_cancel() {
        let (client, mut peer_in, _peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let fut = client.call_value("x", &json!(null), T);
        // Poll until the request goes out, then drop the future.
        let req = tokio::select! {
            _ = fut => panic!("should not resolve"),
            req = read_request(&mut peer_in) => req,
        };
        assert!(client.pending.lock().unwrap().as_ref().unwrap().is_empty());
        // Nobody awaits the response any more: the sidecar abandons the work (e.g. a background registerDust on lock).
        let cancel = tokio::time::timeout(T, read_request(&mut peer_in)).await.expect("no $/cancel");
        assert_eq!((cancel["method"].clone(), cancel["params"]["id"].clone()), (json!("$/cancel"), req["id"].clone()));
    }

    #[tokio::test]
    async fn an_answered_call_does_not_ask_to_cancel() {
        let (client, mut peer_in, mut peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let answer = async {
            let req = read_request(&mut peer_in).await;
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":req["id"],"result":1})).await;
        };
        let (res, ()) = tokio::join!(client.call_value("x", &json!(null), T), answer);
        assert_eq!(res.unwrap(), json!(1));
        let next = client.call_value("siguiente", &json!(null), Duration::from_millis(50));
        let (_, line) = tokio::join!(next, read_request(&mut peer_in));
        assert_eq!(line["method"], json!("siguiente"), "the next message is not a $/cancel");
    }

    #[tokio::test]
    async fn message_larger_than_the_pipe_buffer() {
        let (client, mut peer_in, mut peer_out) = pair(RpcOptions::default(), 8 * 1024);
        let big = "x".repeat(5 * 1024 * 1024);
        let echo = tokio::spawn(async move {
            let req = read_request(&mut peer_in).await;
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":req["id"],"result":req["params"]})).await;
        });
        let res = client.call_value("echo", &json!(big), Duration::from_secs(20)).await.unwrap();
        echo.await.unwrap();
        assert_eq!(res.as_str().unwrap().len(), 5 * 1024 * 1024);
    }

    #[tokio::test]
    async fn stuck_write_closes_the_client() {
        // The "sidecar" never reads: with a 1 KB buffer the write gets stuck.
        let opts = RpcOptions { write_timeout: Duration::from_millis(200), ..RpcOptions::default() };
        let (client, _peer_in, _peer_out) = pair(opts, 1024);
        let err = client.call_value("x", &json!("y".repeat(64 * 1024)), Duration::from_secs(5)).await.unwrap_err();
        assert_eq!(err, RpcError::Closed);
        assert!(client.is_closed());
    }

    #[tokio::test]
    async fn garbage_lines_and_null_id_do_not_break_the_reader() {
        let (client, mut peer_in, mut peer_out) = pair(RpcOptions::default(), 64 * 1024);
        peer_out.write_all(b"esto no es json\n").await.unwrap();
        peer_out.write_all(&[0xff, 0xfe, b'\n']).await.unwrap(); // invalid UTF-8
        reply(&mut peer_out, json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})).await;
        let call = client.call_value("ok", &json!(null), T);
        let responder = async {
            let req = read_request(&mut peer_in).await;
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":req["id"],"result":1})).await;
        };
        let (res, _) = tokio::join!(call, responder);
        assert_eq!(res.unwrap(), json!(1));
    }

    #[tokio::test]
    async fn too_long_line_is_discarded_and_reading_goes_on() {
        let opts = RpcOptions { max_line_bytes: 1024, ..RpcOptions::default() };
        let (client, mut peer_in, mut peer_out) = pair(opts, 64 * 1024);
        peer_out.write_all(format!("{}\n", "z".repeat(4096)).as_bytes()).await.unwrap();
        let call = client.call_value("ok", &json!(null), T);
        let responder = async {
            let req = read_request(&mut peer_in).await;
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":req["id"],"result":"sigo"})).await;
        };
        let (res, _) = tokio::join!(call, responder);
        assert_eq!(res.unwrap(), json!("sigo"));
    }

    #[tokio::test]
    async fn notifications_reach_subscribers() {
        let (client, _peer_in, mut peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let mut sub = client.subscribe();
        reply(&mut peer_out, json!({"jsonrpc":"2.0","method":"progress","params":{"requestId":1,"stage":"proving","percent":50}})).await;
        let n = tokio::time::timeout(T, sub.recv()).await.unwrap().unwrap();
        assert_eq!(n.method, "progress");
        assert_eq!(n.params["percent"], json!(50));
    }

    #[tokio::test]
    async fn remote_error_keeps_code() {
        let (client, mut peer_in, mut peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let call = client.call_value("x", &json!(null), T);
        let responder = async {
            let req = read_request(&mut peer_in).await;
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":req["id"],"error":{"code":codes::NOT_INITIALIZED,"message":"Not initialized"}})).await;
        };
        let (res, _) = tokio::join!(call, responder);
        assert_eq!(
            res.unwrap_err(),
            RpcError::Remote { code: codes::NOT_INITIALIZED, message: "Not initialized".into(), data: None }
        );
    }

    #[tokio::test]
    async fn remote_error_keeps_data() {
        let (client, mut peer_in, mut peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let call = client.call_value("x", &json!(null), T);
        let responder = async {
            let req = read_request(&mut peer_in).await;
            let error = json!({"code":codes::CALL_REJECTED,"message":"Call rejected","data":{"reason":"no-slots-left"}});
            reply(&mut peer_out, json!({"jsonrpc":"2.0","id":req["id"],"error":error})).await;
        };
        let (res, _) = tokio::join!(call, responder);
        let RpcError::Remote { code, data, .. } = res.unwrap_err() else { panic!("expected a remote error") };
        assert_eq!(code, codes::CALL_REJECTED);
        assert_eq!(data, Some(json!({"reason":"no-slots-left"})));
    }

    #[tokio::test]
    async fn close_fails_pending_calls_and_sends_eof() {
        let (client, mut peer_in, _peer_out) = pair(RpcOptions::default(), 64 * 1024);
        let client = Arc::new(client);
        let c = client.clone();
        let pending = tokio::spawn(async move { c.call_value("x", &json!(null), T).await });
        read_request(&mut peer_in).await;
        client.close();
        assert_eq!(pending.await.unwrap().unwrap_err(), RpcError::Closed);
        let mut rest = String::new();
        let n = tokio::time::timeout(T, peer_in.read_line(&mut rest)).await.unwrap().unwrap();
        assert_eq!(n, 0, "the sidecar must receive EOF");
    }

    #[test]
    fn neither_display_nor_debug_write_data_and_the_message_is_bounded() {
        let stale = RpcError::Remote {
            code: codes::STALE_STATE,
            message: "Stale chain state".into(),
            data: Some(json!({"reason": "old", "ageMs": 123_456})),
        };
        for shown in [stale.to_string(), format!("{stale:?}")] {
            assert!(!shown.contains("123456") && !shown.contains("ageMs"), "{shown}");
            assert!(shown.contains("-32010"));
        }
        let long = RpcError::Remote { code: 1, message: "x".repeat(500), data: None };
        assert!(long.to_string().len() < 120, "bounded message");
    }
}
