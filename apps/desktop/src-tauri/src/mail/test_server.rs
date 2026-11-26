//! Minimal HTTP/1.1 server for tests: counts connections, records requests and answers whatever the handler says,
//! including responses a correct server would never give (no length, wrong length, going silent). It keeps
//! connections alive, so a client reusing connections would show up as `connection_count() < requests().len()`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::transport::BaseUrl;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub target: String,
    /// Lowercase names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Length {
    /// `Content-Length` with the real length.
    Exact,
    /// No `Content-Length`: the body ends when the connection closes.
    Missing,
    /// `Content-Length` with this value regardless of what is sent (then closes).
    Declared(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub length: Length,
    /// Never answer.
    pub hang: bool,
    /// Send headers and body, then go silent without closing.
    pub stall: bool,
}

impl Reply {
    pub fn new(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new(), length: Length::Exact, hang: false, stall: false }
    }

    pub fn hang() -> Self {
        Self { hang: true, ..Self::new(200) }
    }

    pub fn stall(self) -> Self {
        Self { stall: true, ..self }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    pub fn length(mut self, length: Length) -> Self {
        self.length = length;
        self
    }

    /// After this response the connection stays open for another request.
    fn keeps_alive(&self) -> bool {
        self.length == Length::Exact && !self.stall
    }

    fn head(&self) -> String {
        let connection = if self.keeps_alive() { "keep-alive" } else { "close" };
        let mut head = format!("HTTP/1.1 {} X\r\nConnection: {connection}\r\n", self.status);
        let length = match self.length {
            Length::Exact => Some(self.body.len() as u64),
            Length::Missing => None,
            Length::Declared(n) => Some(n),
        };
        if let Some(n) = length {
            head.push_str(&format!("Content-Length: {n}\r\n"));
        }
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head + "\r\n"
    }
}

type Handler = Arc<dyn Fn(&Request) -> Reply + Send + Sync>;

pub struct TestServer {
    pub base: BaseUrl,
    pub connections: Arc<AtomicUsize>,
    pub requests: Arc<Mutex<Vec<Request>>>,
    task: JoinHandle<()>,
}

impl TestServer {
    pub async fn start(handler: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = BaseUrl::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shared = (Arc::new(handler) as Handler, connections.clone(), requests.clone());
        let task = tokio::spawn(accept_loop(listener, shared));
        Self { base, connections, requests, task }
    }

    pub fn connection_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type Shared = (Handler, Arc<AtomicUsize>, Arc<Mutex<Vec<Request>>>);

async fn accept_loop(listener: TcpListener, shared: Shared) {
    while let Ok((stream, _)) = listener.accept().await {
        shared.1.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(serve(stream, shared.clone()));
    }
}

/// Serves requests on the same connection while the response allows it.
async fn serve(stream: TcpStream, (handler, _, requests): Shared) {
    let mut reader = BufReader::new(stream);
    while let Some(request) = read_request(&mut reader).await {
        requests.lock().unwrap().push(request.clone());
        let reply = handler(&request);
        if reply.hang {
            std::future::pending::<()>().await;
        }
        let stream = reader.get_mut();
        let _ = stream.write_all(reply.head().as_bytes()).await;
        let _ = stream.write_all(&reply.body).await;
        if reply.stall {
            std::future::pending::<()>().await;
        }
        if !reply.keeps_alive() {
            let _ = stream.shutdown().await;
            return;
        }
    }
}

async fn read_request(reader: &mut BufReader<TcpStream>) -> Option<Request> {
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.ok().filter(|&n| n > 0)?;
        if line == "\r\n" {
            break;
        }
        lines.push(line.trim_end().to_owned());
    }
    let mut request = parse_head(&lines)?;
    let length = request.header("content-length").and_then(|n| n.parse().ok()).unwrap_or(0);
    request.body = vec![0; length];
    reader.read_exact(&mut request.body).await.ok()?;
    Some(request)
}

fn parse_head(lines: &[String]) -> Option<Request> {
    let mut first = lines.first()?.split(' ');
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers = lines[1..]
        .iter()
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Some(Request { method, target, headers, body: Vec::new() })
}
