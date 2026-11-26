use super::*;
use crate::mail::test_server::{Length, Reply, TestServer};

fn transport() -> Transport {
    Transport::direct(&TransportConfig::default()).unwrap()
}

fn quick_transport() -> Transport {
    Transport::direct(&TransportConfig { total_timeout: Duration::from_millis(300), ..TransportConfig::default() })
        .unwrap()
}

#[test]
fn base_urls_accepted() {
    for (text, host) in [
        ("http://127.0.0.1:8080", "127.0.0.1:8080"),
        ("http://127.1.2.3:3000/", "127.1.2.3:3000"),
        ("https://localhost:3000/", "localhost:3000"),
        ("http://[::1]:8443", "[::1]:8443"),
        ("https://Mail.Example:443/", "mail.example"),
    ] {
        assert_eq!(BaseUrl::parse(text).unwrap().host(), host, "{text}");
    }
}

#[test]
fn base_urls_rejected() {
    for text in [
        "http://mail.example",
        // `http://` only to literal loopback IPs: the name `localhost` is resolved by the OS.
        "http://localhost:3000",
        "http://LOCALHOST:3000",
        "http://localhost.:3000",
        "http://10.0.0.1:8080",
        "https://mail.example/api",
        "https://mail.example/?a=1",
        "https://mail.example/#x",
        "https://user@mail.example",
        "https://u:p@mail.example",
        "ftp://127.0.0.1",
        "http://mail_server:8080",
        "no es una url",
        "file:///etc/passwd",
    ] {
        assert_eq!(BaseUrl::parse(text), Err(TransportError::BadUrl), "{text}");
    }
}

#[test]
fn paths_are_sent_exactly_or_rejected() {
    let base = BaseUrl::parse("http://127.0.0.1:8080").unwrap();
    assert_eq!(base.join("/v1/time?since=0").unwrap().as_str(), "http://127.0.0.1:8080/v1/time?since=0");
    for path in ["v1/time", "/a/../b", "/a/./b", "/a#b", "/a b", "", "@evil.example/"] {
        assert_eq!(base.join(path), Err(TransportError::BadUrl), "{path:?}");
    }
}

#[test]
fn tls_has_no_session_resumption_and_only_http1() {
    let config = tls_config().unwrap();
    assert_eq!(config.alpn_protocols, [b"http/1.1".to_vec()]);
    let resumption = format!("{:?}", config.resumption);
    assert!(resumption.contains("NoClientSessionStorage") && resumption.contains("Disabled"), "{resumption}");
}

#[tokio::test]
async fn get_returns_status_body_and_headers() {
    let server = TestServer::start(|_| {
        Reply::new(429).header("Date", "Sun, 06 Nov 1994 08:49:37 GMT").header("Retry-After", "7").body("busy")
    })
    .await;
    let response = transport().get(&server.base, "/x", &[("NightMail-Nonce", "ab")], 64).await.unwrap();
    assert_eq!(
        response,
        HttpResponse { status: 429, date: Some(784_111_777), retry_after: Some(7), body: b"busy".to_vec() }
    );
    let request = &server.requests()[0];
    assert_eq!((request.method.as_str(), request.target.as_str()), ("GET", "/x"));
    assert_eq!(request.header("nightmail-nonce"), Some("ab"));
    assert_eq!(request.header("user-agent"), Some(USER_AGENT));
}

#[tokio::test]
async fn answers_is_a_reply_below_500_in_time() {
    let within = Duration::from_millis(300);
    let server = TestServer::start(|r| match r.target.as_str() {
        "/lento" => Reply::hang(),
        "/proxy" => Reply::new(502),
        "/ocupado" => Reply::new(503),
        "/limite" => Reply::new(429),
        _ => Reply::new(405),
    })
    .await;
    assert!(transport().answers(&server.base, "/v1/relay", within).await, "a 405 also counts as answering");
    assert!(transport().answers(&server.base, "/limite", within).await, "a 429 is a live service");
    assert!(!transport().answers(&server.base, "/proxy", within).await, "a proxy with the service down");
    assert!(!transport().answers(&server.base, "/ocupado", within).await);
    assert!(!transport().answers(&server.base, "/lento", within).await, "no answer in time");
    assert!(!transport().answers(&server.base, "sin-barra", within).await);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed = BaseUrl::parse(&format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())).unwrap();
    drop(listener);
    assert!(!transport().answers(&closed, "/v1/time", within).await, "connection refused");
    let request = &server.requests()[0];
    assert_eq!((request.method.as_str(), request.target.as_str()), ("GET", "/v1/relay"));
}

#[tokio::test]
async fn post_json_sends_the_body() {
    let server = TestServer::start(|_| Reply::new(202).body("{}")).await;
    let response = transport().post_json(&server.base, "/v1/relay", b"{\"a\":1}".to_vec(), 64).await.unwrap();
    assert_eq!((response.status, response.body), (202, b"{}".to_vec()));
    let request = &server.requests()[0];
    assert_eq!((request.method.as_str(), request.body.as_slice()), ("POST", &b"{\"a\":1}"[..]));
    assert_eq!(request.header("content-type"), Some("application/json"));
    let bad = transport().post_json(&server.base, "relay", Vec::new(), 64).await;
    assert_eq!(bad, Err(TransportError::BadUrl));
}

#[tokio::test]
async fn retry_after_is_clamped_and_malformed_headers_ignored() {
    for (value, expected) in [
        ("18446744073709551615", Some(MAX_RETRY_AFTER)),
        ("99999999999999999999999", Some(MAX_RETRY_AFTER)),
        ("3601", Some(MAX_RETRY_AFTER)),
        ("pronto", None),
        ("-1", None),
        ("", None),
    ] {
        let server =
            TestServer::start(move |_| Reply::new(429).header("Date", "ayer").header("Retry-After", value)).await;
        let response = transport().get(&server.base, "/", &[], 64).await.unwrap();
        assert_eq!((response.date, response.retry_after), (None, expected), "{value:?}");
    }
}

#[tokio::test]
async fn each_request_uses_its_own_connection_without_cookies_even_if_the_server_keeps_it_alive() {
    let server = TestServer::start(|_| Reply::new(200).header("Set-Cookie", "id=1").body("ok")).await;
    let transport = transport();
    for _ in 0..3 {
        transport.get(&server.base, "/", &[], 64).await.unwrap();
        transport.post_json(&server.base, "/", b"{}".to_vec(), 64).await.unwrap();
    }
    assert_eq!(server.connection_count(), 6);
    assert!(server.requests().iter().all(|r| r.header("cookie").is_none() && r.header("referer").is_none()));
}

#[tokio::test]
async fn redirects_are_not_followed() {
    let server = TestServer::start(|_| Reply::new(302).header("Location", "/otra")).await;
    let response = transport().get(&server.base, "/", &[], 64).await.unwrap();
    assert_eq!(response.status, 302);
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn declared_length_above_the_limit_is_rejected_before_reading() {
    let server = TestServer::start(|_| Reply::new(200).length(Length::Declared(1 << 30))).await;
    assert_eq!(transport().get(&server.base, "/", &[], 1024).await, Err(TransportError::TooLarge));
}

#[tokio::test]
async fn streamed_body_above_the_limit_is_cut() {
    let server = TestServer::start(|_| Reply::new(200).body(vec![7u8; 5000]).length(Length::Missing)).await;
    let transport = transport();
    assert_eq!(transport.get(&server.base, "/", &[], 4999).await, Err(TransportError::TooLarge));
    assert_eq!(transport.get(&server.base, "/", &[], 5000).await.unwrap().body.len(), 5000);
}

#[tokio::test]
async fn total_timeout_applies_before_the_headers() {
    let server = TestServer::start(|_| Reply::hang()).await;
    assert_eq!(quick_transport().get(&server.base, "/", &[], 64).await, Err(TransportError::Timeout));
}

#[tokio::test]
async fn total_timeout_while_reading_the_body_is_an_interrupted_reply() {
    // Headers arrived, so the server answered: this is not a "no response" timeout.
    let server = TestServer::start(|_| Reply::new(200).body("abc").length(Length::Declared(100)).stall()).await;
    assert_eq!(quick_transport().get(&server.base, "/", &[], 1000).await, Err(TransportError::Interrupted));
}

#[tokio::test]
async fn body_cut_by_the_server_is_interrupted() {
    let server = TestServer::start(|_| Reply::new(200).body("abc").length(Length::Declared(100))).await;
    assert_eq!(transport().get(&server.base, "/", &[], 1000).await, Err(TransportError::Interrupted));
}

#[tokio::test]
async fn connection_refused_is_a_network_error() {
    // A bound port with no `listen()`: the OS refuses the connection, and while the socket lives no parallel test
    // server can be handed the same ephemeral port (dropping a listener used to free it).
    let reserved = tokio::net::TcpSocket::new_v4().unwrap();
    reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let base = BaseUrl::parse(&format!("http://127.0.0.1:{}", reserved.local_addr().unwrap().port())).unwrap();
    assert_eq!(transport().get(&base, "/", &[], 64).await, Err(TransportError::Network));
    drop(reserved);
}

#[tokio::test]
async fn bad_path_never_reaches_the_network() {
    let server = TestServer::start(|_| Reply::new(200)).await;
    assert_eq!(transport().get(&server.base, "/a/../b", &[], 64).await, Err(TransportError::BadUrl));
    assert_eq!(server.connection_count(), 0);
}

#[test]
fn errors_have_fixed_messages() {
    assert_eq!(TransportError::BadUrl.to_string(), "server address not allowed");
    assert_eq!(TransportError::Network.to_string(), "network error");
    assert_eq!(TransportError::Timeout.to_string(), "the server did not answer in time");
    assert_eq!(TransportError::TooLarge.to_string(), "response too large");
    assert_eq!(TransportError::Interrupted.to_string(), "response cut short");
}

/// Over `https` real TLS is spoken: against a server that does not speak it, the connection fails rather than
/// falling back to HTTP. A test with a real certificate would need a TLS test server (rcgen); not done yet.
#[tokio::test]
async fn https_really_uses_tls() {
    let server = TestServer::start(|_| Reply::new(200)).await;
    let port = server.base.host().rsplit(':').next().unwrap().to_owned();
    let base = BaseUrl::parse(&format!("https://localhost:{port}")).unwrap();
    assert_eq!(transport().get(&base, "/", &[], 64).await, Err(TransportError::Network));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn compressed_bodies_are_not_requested_nor_decoded() {
    let server = TestServer::start(|_| Reply::new(200).header("Content-Encoding", "gzip").body("no-gzip")).await;
    let response = transport().get(&server.base, "/", &[], 64).await.unwrap();
    assert_eq!(response.body, b"no-gzip");
    assert_eq!(server.requests()[0].header("accept-encoding"), None);
}
