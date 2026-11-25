use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
    routing::get,
    Router,
};
use bytes::Bytes;
use reqwest::Client;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};
use tokio_util::io::ReaderStream;

const CHUNK_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB read-ahead chunks
const MAX_CACHED_CHUNKS: usize = 32; // ~64 MiB cap
const READ_AHEAD_CHUNKS: u64 = 2;

#[derive(Debug, Clone, Copy)]
pub struct StreamProxyState {
    pub port: u16,
}

#[tauri::command]
pub fn get_stream_proxy_port(state: tauri::State<'_, StreamProxyState>) -> u16 {
    state.port
}

pub fn build_proxy_url(port: u16, target_url: &str) -> String {
    format!(
        "http://127.0.0.1:{port}/stream?url={}",
        urlencoding::encode(target_url)
    )
}

pub fn build_vod_proxy_url(port: u16, target_url: &str) -> String {
    format!(
        "http://127.0.0.1:{port}/vod?url={}",
        urlencoding::encode(target_url)
    )
}

pub fn build_live_proxy_url(port: u16, video_id: &str) -> String {
    format!(
        "http://127.0.0.1:{port}/live?id={}",
        urlencoding::encode(video_id)
    )
}

pub fn build_local_proxy_url(port: u16, video_id: &str) -> String {
    format!(
        "http://127.0.0.1:{port}/local?id={}",
        urlencoding::encode(video_id)
    )
}

fn is_allowed_upstream_url(url: &str) -> bool {
    #[cfg(test)]
    if url.starts_with("http://127.0.0.1:") {
        return true;
    }

    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_no_port = host.split(':').next().unwrap_or("");
    host_no_port.ends_with(".googlevideo.com")
        || host_no_port == "googlevideo.com"
        || host_no_port.ends_with(".youtube.com")
        || host_no_port == "youtube.com"
        || host_no_port.ends_with(".ytimg.com")
}

#[derive(Clone)]
struct StreamMeta {
    total_size: u64,
    content_type: String,
}

enum ChunkEntry {
    Loading(Arc<Notify>),
    Ready(Bytes),
}

struct ChunkCacheInner {
    metas: HashMap<String, StreamMeta>,
    chunks: HashMap<(String, u64), ChunkEntry>,
    lru: VecDeque<(String, u64)>,
}

#[derive(Clone)]
struct AppState {
    client: Client,
    cache: Arc<Mutex<ChunkCacheInner>>,
    cache_dir: PathBuf,
    port: u16,
}

impl AppState {
    fn new(client: Client, cache_dir: PathBuf, port: u16) -> Self {
        Self {
            client,
            cache: Arc::new(Mutex::new(ChunkCacheInner {
                metas: HashMap::new(),
                chunks: HashMap::new(),
                lru: VecDeque::new(),
            })),
            cache_dir,
            port,
        }
    }
}

/// Binds a local HTTP stream proxy on 127.0.0.1:0, spawns the Axum server,
/// and returns the bound port.
pub async fn start_stream_server(cache_dir: PathBuf) -> Result<u16, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Failed to build HTTP client for stream proxy: {e}"))?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local stream proxy: {e}"))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local stream proxy address: {e}"))?
        .port();

    let state = AppState::new(client, cache_dir, port);

    let app = Router::new()
        .route("/stream", get(proxy_handler))
        .route("/vod", get(vod_handler))
        .route("/live", get(live_handler))
        .route("/local", get(local_file_handler))
        .with_state(state);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("Stream proxy server error: {e}");
        }
    });

    Ok(port)
}

fn error_response(status: StatusCode, message: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        .body(Body::from(message))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn parse_content_range_total(val: &str) -> Option<u64> {
    let slash_pos = val.rfind('/')?;
    let total_str = val[slash_pos + 1..].trim();
    if total_str == "*" {
        return None;
    }
    total_str.parse::<u64>().ok()
}

fn parse_range_header(range_val: &str, total_size: u64) -> Option<(u64, u64)> {
    if total_size == 0 {
        return None;
    }
    let spec = range_val.strip_prefix("bytes=")?.trim();
    let (start_s, end_s) = spec.split_once('-')?;
    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_size.saturating_sub(suffix);
        return Some((start, total_size - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= total_size {
        return None;
    }
    let end = if end_s.is_empty() {
        total_size - 1
    } else {
        end_s.parse::<u64>().ok()?.min(total_size - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

async fn get_or_fetch_chunk(
    state: &AppState,
    url: &str,
    chunk_idx: u64,
) -> Result<(Bytes, StreamMeta), StatusCode> {
    let key = (url.to_string(), chunk_idx);

    loop {
        let maybe_notify = {
            let mut guard = state.cache.lock().await;
            if let Some(entry) = guard.chunks.get(&key) {
                match entry {
                    ChunkEntry::Ready(data) => {
                        if let Some(meta) = guard.metas.get(url).cloned() {
                            return Ok((data.clone(), meta));
                        }
                        None
                    }
                    ChunkEntry::Loading(notify) => Some(notify.clone()),
                }
            } else {
                let notify = Arc::new(Notify::new());
                guard.chunks.insert(key.clone(), ChunkEntry::Loading(notify.clone()));
                drop(guard);

                let start = chunk_idx * CHUNK_SIZE;
                let end = start + CHUNK_SIZE - 1;
                let range_hdr = format!("bytes={start}-{end}");

                let fetch_res = state
                    .client
                    .get(url)
                    .header(header::RANGE, range_hdr)
                    .send()
                    .await;

                let resp = match fetch_res {
                    Ok(r) if r.status().is_success() || r.status() == StatusCode::PARTIAL_CONTENT => r,
                    _ => {
                        let mut guard = state.cache.lock().await;
                        guard.chunks.remove(&key);
                        notify.notify_waiters();
                        return Err(StatusCode::BAD_GATEWAY);
                    }
                };

                let content_type = resp
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("video/mp4")
                    .to_string();

                let total_size_from_range = resp
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range_total);

                let content_length = resp.content_length();

                let body_bytes = match resp.bytes().await {
                    Ok(b) => b,
                    Err(_) => {
                        let mut guard = state.cache.lock().await;
                        guard.chunks.remove(&key);
                        notify.notify_waiters();
                        return Err(StatusCode::BAD_GATEWAY);
                    }
                };

                let total_size = total_size_from_range
                    .or_else(|| content_length.map(|l| start + l))
                    .unwrap_or(start + body_bytes.len() as u64);

                let meta = StreamMeta {
                    total_size,
                    content_type,
                };

                {
                    let mut guard = state.cache.lock().await;
                    if guard.metas.len() >= MAX_CACHED_CHUNKS && !guard.metas.contains_key(url) {
                        guard.metas.clear();
                    }
                    guard.metas.insert(url.to_string(), meta.clone());
                    guard.chunks.insert(key.clone(), ChunkEntry::Ready(body_bytes.clone()));
                    guard.lru.push_back(key.clone());

                    while guard.lru.len() > MAX_CACHED_CHUNKS {
                        if let Some(old_key) = guard.lru.pop_front() {
                            if old_key != key {
                                guard.chunks.remove(&old_key);
                            }
                        }
                    }
                }
                notify.notify_waiters();
                return Ok((body_bytes, meta));
            }
        };

        if let Some(notify) = maybe_notify {
            notify.notified().await;
        } else {
            let mut guard = state.cache.lock().await;
            guard.chunks.remove(&key);
        }
    }
}

fn spawn_read_ahead(state: AppState, url: String, from_chunk: u64, total_size: u64) {
    if total_size == 0 {
        return;
    }
    let max_chunk = total_size.saturating_sub(1) / CHUNK_SIZE;
    for offset in 1..=READ_AHEAD_CHUNKS {
        let next_chunk = from_chunk + offset;
        if next_chunk > max_chunk {
            break;
        }
        let st = state.clone();
        let u = url.clone();
        tokio::spawn(async move {
            let _ = get_or_fetch_chunk(&st, &u, next_chunk).await;
        });
    }
}

async fn proxy_handler(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    req_headers: HeaderMap,
) -> Response<Body> {
    let url = match params.get("url") {
        Some(u) if is_allowed_upstream_url(u) => u.clone(),
        _ => return error_response(StatusCode::BAD_REQUEST, "Missing or invalid stream url"),
    };

    let meta = {
        let guard = state.cache.lock().await;
        guard.metas.get(&url).cloned()
    };

    let meta = match meta {
        Some(m) => m,
        None => match get_or_fetch_chunk(&state, &url, 0).await {
            Ok((_, m)) => m,
            Err(status) => return error_response(status, "Failed to reach upstream stream"),
        },
    };

    let range_hdr = req_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());

    let (status, req_start, req_end) = if let Some(r_str) = range_hdr {
        match parse_range_header(r_str, meta.total_size) {
            Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
            None => return error_response(StatusCode::RANGE_NOT_SATISFIABLE, "Invalid Range"),
        }
    } else {
        (StatusCode::OK, 0, meta.total_size.saturating_sub(1))
    };

    let content_len = req_end.saturating_sub(req_start) + 1;

    // Stream the full requested range [req_start..=req_end] via duplex pipe + read-ahead chunks.
    // Never truncate open-ended Range requests (`bytes=0-`), so GStreamer/WebKitGTK never hits premature EOF.
    let (mut writer, reader) = tokio::io::duplex(256 * 1024);
    let st = state.clone();
    let u = url.clone();
    let total_size = meta.total_size;

    tokio::spawn(async move {
        let mut cursor = req_start;
        while cursor <= req_end {
            let c_idx = cursor / CHUNK_SIZE;
            spawn_read_ahead(st.clone(), u.clone(), c_idx, total_size);

            let (chunk_bytes, _) = match get_or_fetch_chunk(&st, &u, c_idx).await {
                Ok(res) => res,
                Err(_) => break,
            };

            let chunk_start = c_idx * CHUNK_SIZE;
            let offset_in_chunk = (cursor - chunk_start) as usize;
            if offset_in_chunk >= chunk_bytes.len() {
                break;
            }
            let avail = chunk_bytes.len() - offset_in_chunk;
            let needed = (req_end - cursor + 1) as usize;
            let take = avail.min(needed);
            if take == 0 {
                break;
            }

            if writer
                .write_all(&chunk_bytes[offset_in_chunk..offset_in_chunk + take])
                .await
                .is_err()
            {
                // Client closed connection (e.g. GStreamer seeked to another offset)
                break;
            }
            cursor += take as u64;
        }
    });

    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("Content-Range, Content-Length, Accept-Ranges"),
        )
        .header(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"))
        .header(header::CONTENT_TYPE, meta.content_type)
        .header(header::CONTENT_LENGTH, content_len.to_string());

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {req_start}-{req_end}/{}", meta.total_size),
        );
    }

    builder
        .body(Body::from_stream(ReaderStream::new(reader)))
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed building stream response"))
}

/// Serves cached local 1080p MP4 files over HTTP with full Range support,
/// avoiding WebKitGTK/GStreamer `asset://localhost` protocol decoding errors on Linux.
async fn local_file_handler(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    req_headers: HeaderMap,
) -> Response<Body> {
    let raw_id = match params.get("id") {
        Some(id) => id,
        None => return error_response(StatusCode::BAD_REQUEST, "Missing video id"),
    };

    let clean_id = match crate::ytdlp::validate_video_id(raw_id) {
        Ok(id) => id,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid video id"),
    };

    let webm_path = state.cache_dir.join(format!("{clean_id}.webm"));
    let mp4_path = state.cache_dir.join(format!("{clean_id}.mp4"));
    let (file_path, content_type) = if webm_path.is_file() {
        (webm_path, "video/webm")
    } else {
        (mp4_path, "video/mp4")
    };

    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return error_response(StatusCode::NOT_FOUND, "Cached file not found"),
    };

    let total_size = match file.metadata().await {
        Ok(m) if m.len() > 0 => m.len(),
        _ => return error_response(StatusCode::NOT_FOUND, "Empty or unreadable cached file"),
    };

    let range_hdr = req_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());

    let (status, req_start, req_end) = if let Some(r_str) = range_hdr {
        match parse_range_header(r_str, total_size) {
            Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
            None => return error_response(StatusCode::RANGE_NOT_SATISFIABLE, "Invalid Range"),
        }
    } else {
        (StatusCode::OK, 0, total_size - 1)
    };

    if req_start > 0 && file.seek(std::io::SeekFrom::Start(req_start)).await.is_err() {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed seeking cached file");
    }

    let content_len = req_end - req_start + 1;
    let limited_reader = file.take(content_len);
    let stream = ReaderStream::with_capacity(limited_reader, 128 * 1024);

    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("Content-Range, Content-Length, Accept-Ranges"),
        )
        .header(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"))
        .header(header::CONTENT_TYPE, HeaderValue::from_static(content_type))
        .header(header::CONTENT_LENGTH, content_len.to_string());

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {req_start}-{req_end}/{total_size}"),
        );
    }

    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed streaming cached file"))
}

struct ChildProcessGuard {
    _ytdlp: Option<Child>,
    _ffmpeg: Child,
}

#[derive(serde::Deserialize)]
struct VodParams {
    url: String,
    t: Option<f64>,
}

/// Real-time WebM (VP8 + Opus) transcoder for instant VOD playback,
/// reading from our local read-ahead `/stream` proxy so `ffmpeg` can seek `moov` in <1ms
/// and GStreamer (`vp8dec` + `opusdec`) decodes without H.264/AAC plugins.
async fn vod_handler(
    State(state): State<AppState>,
    Query(params): Query<VodParams>,
) -> Response<Body> {
    if !is_allowed_upstream_url(&params.url) {
        return error_response(StatusCode::BAD_REQUEST, "Missing or invalid stream url");
    }

    let local_stream = build_proxy_url(state.port, &params.url);

    let mut args: Vec<String> = vec!["-loglevel".into(), "error".into()];
    if let Some(seek_sec) = params.t.filter(|s| s.is_finite() && *s > 0.0) {
        args.push("-ss".into());
        args.push(format!("{seek_sec:.2}"));
    }
    args.extend([
        "-i".into(),
        local_stream,
        "-c:v".into(),
        "libvpx".into(),
        "-deadline".into(),
        "realtime".into(),
        "-cpu-used".into(),
        "8".into(),
        "-b:v".into(),
        "1500k".into(),
        "-threads".into(),
        "4".into(),
        "-c:a".into(),
        "libopus".into(),
        "-f".into(),
        "webm".into(),
        "pipe:1".into(),
    ]);

    let mut ffmpeg_cmd = Command::new("ffmpeg");
    ffmpeg_cmd
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let mut ffmpeg_child = match ffmpeg_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to launch ffmpeg for VOD stream"),
    };

    let ffmpeg_stdout = match ffmpeg_child.stdout.take() {
        Some(s) => s,
        None => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Missing ffmpeg stdout"),
    };

    let guard = Arc::new(ChildProcessGuard {
        _ytdlp: None,
        _ffmpeg: ffmpeg_child,
    });

    let stream = ReaderStream::new(ffmpeg_stdout);
    let guarded_stream = futures_util_map_guard(stream, guard);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        .header(header::ACCEPT_RANGES, HeaderValue::from_static("none"))
        .header(header::CONTENT_TYPE, HeaderValue::from_static("video/webm"))
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
        .body(Body::from_stream(guarded_stream))
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed building VOD stream response"))
}

async fn live_handler(Query(params): Query<HashMap<String, String>>) -> Response<Body> {
    let raw_id = match params.get("id") {
        Some(id) => id,
        None => return error_response(StatusCode::BAD_REQUEST, "Missing video id"),
    };

    let clean_id = match crate::ytdlp::validate_video_id(raw_id) {
        Ok(id) => id,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid video id"),
    };

    let watch_url = format!("https://www.youtube.com/watch?v={clean_id}");

    let mut ytdlp_cmd = Command::new("yt-dlp");
    ytdlp_cmd
        .args([
            "--js-runtimes",
            "node",
            "-f",
            "bestvideo[height<=1080][vcodec^=avc1]+bestaudio/best[height<=1080]/best",
            "--no-warnings",
            "-o",
            "-",
            &watch_url,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let mut ytdlp_child = match ytdlp_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to launch yt-dlp for live stream"),
    };

    let ytdlp_stdout = match ytdlp_child.stdout.take() {
        Some(s) => s,
        None => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Missing yt-dlp stdout"),
    };

    let std_stdout: Stdio = match ytdlp_stdout.try_into() {
        Ok(s) => s,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed piping yt-dlp to ffmpeg"),
    };

    let mut ffmpeg_cmd = Command::new("ffmpeg");
    ffmpeg_cmd
        .args([
            "-loglevel",
            "error",
            "-f",
            "mpegts",
            "-probesize",
            "256k",
            "-analyzeduration",
            "500000",
            "-i",
            "pipe:0",
            "-c:v",
            "libvpx",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-b:v",
            "2200k",
            "-threads",
            "4",
            "-c:a",
            "libopus",
            "-f",
            "webm",
            "pipe:1",
        ])
        .stdin(std_stdout)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let mut ffmpeg_child = match ffmpeg_cmd.spawn() {
        Ok(c) => c,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "Failed to launch ffmpeg for live stream"),
    };

    let ffmpeg_stdout = match ffmpeg_child.stdout.take() {
        Some(s) => s,
        None => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "Missing ffmpeg stdout"),
    };

    let guard = Arc::new(ChildProcessGuard {
        _ytdlp: Some(ytdlp_child),
        _ffmpeg: ffmpeg_child,
    });

    let stream = ReaderStream::new(ffmpeg_stdout);
    let guarded_stream = futures_util_map_guard(stream, guard);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        .header(header::ACCEPT_RANGES, HeaderValue::from_static("none"))
        .header(header::CONTENT_TYPE, HeaderValue::from_static("video/webm"))
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
        .body(Body::from_stream(guarded_stream))
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed building live stream response"))
}

fn futures_util_map_guard<S>(
    inner: S,
    guard: Arc<ChildProcessGuard>,
) -> impl futures_core::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static
where
    S: futures_core::Stream<Item = Result<Bytes, std::io::Error>> + Send + Unpin + 'static,
{
    struct GuardedStream<S> {
        inner: S,
        _guard: Arc<ChildProcessGuard>,
    }

    impl<S> futures_core::Stream for GuardedStream<S>
    where
        S: futures_core::Stream<Item = Result<Bytes, std::io::Error>> + Unpin,
    {
        type Item = Result<Bytes, std::io::Error>;

        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            std::pin::Pin::new(&mut self.inner).poll_next(cx)
        }
    }

    GuardedStream {
        inner,
        _guard: guard,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_encoded_proxy_url() {
        let url = build_proxy_url(45678, "https://rr1.googlevideo.com/videoplayback?id=abc&itag=18");
        assert!(url.starts_with("http://127.0.0.1:45678/stream?url="));
        assert!(url.contains("%3A%2F%2F"));
        assert!(!url.contains("&itag=18"));
    }

    #[test]
    fn builds_live_and_local_proxy_urls() {
        let live = build_live_proxy_url(45678, "rFZHOHl-L8A");
        assert_eq!(live, "http://127.0.0.1:45678/live?id=rFZHOHl-L8A");

        let local = build_local_proxy_url(45678, "dQw4w9WgXcQ");
        assert_eq!(local, "http://127.0.0.1:45678/local?id=dQw4w9WgXcQ");
    }

    #[test]
    fn parses_range_headers() {
        assert_eq!(parse_range_header("bytes=0-1023", 5000), Some((0, 1023)));
        assert_eq!(parse_range_header("bytes=100-", 5000), Some((100, 4999)));
        assert_eq!(parse_range_header("bytes=-500", 5000), Some((4500, 4999)));
        assert_eq!(parse_range_header("bytes=6000-", 5000), None);
        assert_eq!(parse_range_header("bytes=0-", 0), None);
    }

    #[test]
    fn validates_upstream_url_scheme() {
        assert!(is_allowed_upstream_url("https://rr1---sn-2uuxa3vh.googlevideo.com/videoplayback?id=1"));
        assert!(is_allowed_upstream_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        assert!(!is_allowed_upstream_url("http://169.254.169.254/latest/meta-data/"));
        assert!(!is_allowed_upstream_url("https://evil.com/googlevideo.com"));
        assert!(!is_allowed_upstream_url("http://rr1.googlevideo.com/v.mp4"));
        assert!(!is_allowed_upstream_url("file:///etc/passwd"));
        assert!(!is_allowed_upstream_url(""));
    }

    #[tokio::test]
    async fn serves_local_and_proxied_streams_with_open_and_bounded_ranges() {
        let temp_dir = std::env::temp_dir().join("aetheris_stream_server_test");
        let _ = std::fs::create_dir_all(&temp_dir);
        let test_id = "dQw4w9WgXcQ";
        let test_file = temp_dir.join(format!("{test_id}.mp4"));

        // Create a 100 KB payload
        let payload: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&test_file, &payload).unwrap();

        let port = start_stream_server(temp_dir.clone()).await.unwrap();
        let client = Client::new();

        // 1. Test /local open-ended Range: bytes=0- (must return full 100,000 bytes, not truncated)
        let local_url = build_local_proxy_url(port, test_id);
        let resp = client
            .get(&local_url)
            .header(header::RANGE, "bytes=0-")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 0-99999/100000"
        );
        let body = resp.bytes().await.unwrap();
        assert_eq!(body.len(), 100_000);
        assert_eq!(&body[..], &payload[..]);

        // 2. Test /stream proxy pointing to /local with bounded Range: bytes=500-1499
        let proxy_url = build_proxy_url(port, &local_url);
        let resp2 = client
            .get(&proxy_url)
            .header(header::RANGE, "bytes=500-1499")
            .send()
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp2.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 500-1499/100000"
        );
        let body2 = resp2.bytes().await.unwrap();
        assert_eq!(body2.len(), 1000);
        assert_eq!(&body2[..], &payload[500..1500]);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
