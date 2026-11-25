use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

use crate::cache::CacheState;
use crate::stream_server::{
    build_live_proxy_url, build_local_proxy_url, build_vod_proxy_url, StreamProxyState,
};

const YTDLP_RESOLVE_TIMEOUT_SECS: u64 = 25;
const YTDLP_SEARCH_TIMEOUT_SECS: u64 = 35;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoMeta {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration_seconds: Option<u64>,
    pub thumbnail: String,
    pub view_count: Option<u64>,
    pub upload_date: Option<String>,
    pub is_live: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamResolution {
    pub video_id: String,
    pub stream_url: Option<String>,
    pub local_stream_url: Option<String>,
    pub cached_path: Option<String>,
    pub is_cached: bool,
    pub quality_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub ytdlp_available: bool,
    pub ytdlp_version: Option<String>,
    pub ffmpeg_available: bool,
}

/// Validates a YouTube video ID or extracts & validates one from a YouTube URL.
/// Rejects arbitrary strings/flags so yt-dlp never receives untrusted CLI arguments.
pub fn validate_video_id(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if is_valid_id(trimmed) {
        return Ok(trimmed.to_string());
    }

    if let Some(extracted) = extract_id_from_url(trimmed) {
        if is_valid_id(&extracted) {
            return Ok(extracted);
        }
    }

    Err("Invalid YouTube video ID or URL".to_string())
}

fn is_valid_id(candidate: &str) -> bool {
    candidate.len() == 11
        && candidate
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn extract_id_from_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return None;
    }

    // Handle youtu.be/<id>
    if let Some(pos) = lower.find("youtu.be/") {
        let rest = &url[pos + "youtu.be/".len()..];
        let id = rest.split(['?', '&', '/', '#']).next()?;
        return Some(id.to_string());
    }

    // Only accept youtube.com hosts
    if !lower.contains("youtube.com/") {
        return None;
    }

    // Handle /shorts/<id> or /embed/<id>
    for marker in ["/shorts/", "/embed/", "/live/"] {
        if let Some(pos) = lower.find(marker) {
            let rest = &url[pos + marker.len()..];
            let id = rest.split(['?', '&', '/', '#']).next()?;
            return Some(id.to_string());
        }
    }

    // Handle ?v=<id> or &v=<id>
    if let Some(query_start) = url.find('?') {
        let query = &url[query_start + 1..];
        for pair in query.split('&') {
            if let Some(val) = pair.strip_prefix("v=") {
                let id = val.split('#').next()?;
                return Some(id.to_string());
            }
        }
    }

    None
}

pub fn sanitize_search_query(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    if cleaned.chars().count() > 120 {
        return Err("Search query is too long (max 120 characters)".to_string());
    }
    Ok(cleaned)
}

#[derive(Debug, Deserialize)]
struct RawYtDlpItem {
    id: Option<String>,
    title: Option<String>,
    channel: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    thumbnails: Option<Vec<RawThumbnail>>,
    view_count: Option<u64>,
    upload_date: Option<String>,
    live_status: Option<String>,
    is_live: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RawThumbnail {
    url: Option<String>,
}

pub fn parse_ytdlp_json_line(line: &str) -> Option<VideoMeta> {
    let raw: RawYtDlpItem = serde_json::from_str(line).ok()?;
    let id = raw.id.filter(|v| is_valid_id(v))?;
    let title = raw
        .title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Video {id}"));
    let channel = raw
        .channel
        .or(raw.uploader)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown Channel".to_string());

    let thumbnail = raw
        .thumbnail
        .filter(|u| !u.is_empty())
        .or_else(|| {
            raw.thumbnails
                .and_then(|list| list.into_iter().rev().find_map(|t| t.url))
        })
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"));

    let duration_seconds = raw
        .duration
        .filter(|d| d.is_finite() && *d >= 0.0)
        .map(|d| d.round() as u64);

    let is_live = raw.is_live.unwrap_or(false)
        || matches!(raw.live_status.as_deref(), Some("is_live" | "is_upcoming"));

    Some(VideoMeta {
        id,
        title,
        channel,
        duration_seconds,
        thumbnail,
        view_count: raw.view_count,
        upload_date: raw.upload_date,
        is_live,
    })
}

#[tauri::command]
pub async fn check_dependencies() -> Result<DependencyStatus, String> {
    let ytdlp_out = Command::new("yt-dlp").arg("--version").output().await;
    let (ytdlp_available, ytdlp_version) = match ytdlp_out {
        Ok(out) if out.status.success() => {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (true, Some(ver))
        }
        _ => (false, None),
    };

    let ffmpeg_available = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    Ok(DependencyStatus {
        ytdlp_available,
        ytdlp_version,
        ffmpeg_available,
    })
}

#[tauri::command]
pub async fn resolve_stream(
    video_id: String,
    is_live: Option<bool>,
    cache_state: tauri::State<'_, CacheState>,
    proxy_state: tauri::State<'_, StreamProxyState>,
) -> Result<StreamResolution, String> {
    let clean_id = validate_video_id(&video_id)?;

    let local_url = build_local_proxy_url(proxy_state.port, &clean_id);

    if is_live.unwrap_or(false) {
        return Ok(StreamResolution {
            video_id: clean_id.clone(),
            stream_url: Some(build_live_proxy_url(proxy_state.port, &clean_id)),
            local_stream_url: None,
            cached_path: None,
            is_cached: false,
            quality_label: "Live 1080p".to_string(),
        });
    }

    // Fast path: if already cached locally in HD, touch LRU timestamp and return HTTP local stream URL.
    if let Some(cached_path) = cache_state.get_cached_path_and_touch(&clean_id).await {
        return Ok(StreamResolution {
            video_id: clean_id,
            stream_url: Some(local_url.clone()),
            local_stream_url: Some(local_url),
            cached_path: Some(cached_path.to_string_lossy().to_string()),
            is_cached: true,
            quality_label: "1080p Cached".to_string(),
        });
    }

    let watch_url = format!("https://www.youtube.com/watch?v={clean_id}");
    let mut cmd = Command::new("yt-dlp");
    cmd.args([
        "--js-runtimes",
        "node",
        "--extractor-args",
        "youtube:player_client=android,tv",
        "-f",
        "best[ext=mp4]/best",
        "--no-playlist",
        "--no-warnings",
        "--get-url",
        &watch_url,
    ]);

    let output = timeout(Duration::from_secs(YTDLP_RESOLVE_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "Timed out resolving video stream via yt-dlp".to_string())?
        .map_err(|e| format!("Failed to launch yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "yt-dlp failed to resolve stream URL".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw_url = stdout
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))
        .ok_or_else(|| "No playable progressive HTTP stream URL returned by yt-dlp".to_string())?;

    let proxy_url = build_vod_proxy_url(proxy_state.port, raw_url);

    Ok(StreamResolution {
        video_id: clean_id,
        stream_url: Some(proxy_url),
        local_stream_url: Some(local_url),
        cached_path: None,
        is_cached: false,
        quality_label: "Instant Stream".to_string(),
    })
}

#[tauri::command]
pub async fn search_videos(
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<VideoMeta>, String> {
    let clean_query = sanitize_search_query(&query)?;
    let page_size = limit.unwrap_or(16).clamp(1, 24);
    let start = offset.unwrap_or(0).saturating_add(1);
    let end = start.saturating_add(page_size).saturating_sub(1);
    let search_expr = format!("ytsearch{end}:{clean_query}");
    let start_str = start.to_string();
    let end_str = end.to_string();

    let mut cmd = Command::new("yt-dlp");
    cmd.args([
        "--dump-json",
        "--flat-playlist",
        "--playlist-start",
        &start_str,
        "--playlist-end",
        &end_str,
        "--no-warnings",
        "--skip-download",
        &search_expr,
    ]);

    let output = timeout(Duration::from_secs(YTDLP_SEARCH_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "Timed out searching YouTube via yt-dlp".to_string())?
        .map_err(|e| format!("Failed to launch yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "yt-dlp search failed".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let videos: Vec<VideoMeta> = stdout
        .lines()
        .filter_map(parse_ytdlp_json_line)
        .collect();

    Ok(videos)
}

#[tauri::command]
pub async fn get_video_info(video_id: String) -> Result<VideoMeta, String> {
    let clean_id = validate_video_id(&video_id)?;
    let watch_url = format!("https://www.youtube.com/watch?v={clean_id}");

    let mut cmd = Command::new("yt-dlp");
    cmd.args([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        &watch_url,
    ]);

    let output = timeout(Duration::from_secs(YTDLP_RESOLVE_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "Timed out fetching video info".to_string())?
        .map_err(|e| format!("Failed to launch yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "yt-dlp failed to fetch video info".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(parse_ytdlp_json_line)
        .ok_or_else(|| "Failed to parse video metadata from yt-dlp".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_raw_and_url_video_ids() {
        assert_eq!(validate_video_id("dQw4w9WgXcQ").unwrap(), "dQw4w9WgXcQ");
        assert_eq!(
            validate_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s").unwrap(),
            "dQw4w9WgXcQ"
        );
        assert_eq!(
            validate_video_id("https://youtu.be/dQw4w9WgXcQ?si=abc").unwrap(),
            "dQw4w9WgXcQ"
        );
        assert_eq!(
            validate_video_id("https://youtube.com/shorts/abcdefghijk").unwrap(),
            "abcdefghijk"
        );
    }

    #[test]
    fn rejects_invalid_or_malicious_ids() {
        assert!(validate_video_id("").is_err());
        assert!(validate_video_id("short").is_err());
        assert!(validate_video_id("--exec=rm -rf /").is_err());
        assert!(validate_video_id("https://evil.com/watch?v=dQw4w9WgXcQ").is_err());
        assert!(validate_video_id("dQw4w9WgXcQ; ls").is_err());
    }

    #[test]
    fn sanitizes_search_queries() {
        assert_eq!(sanitize_search_query("  rust tauri \n").unwrap(), "rust tauri");
        assert!(sanitize_search_query("   ").is_err());
        assert!(sanitize_search_query(&"a".repeat(121)).is_err());
    }

    #[test]
    fn parses_ytdlp_json_line() {
        let line = r#"{"id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","uploader":"Rick","duration":212.4,"view_count":1000}"#;
        let meta = parse_ytdlp_json_line(line).expect("should parse");
        assert_eq!(meta.id, "dQw4w9WgXcQ");
        assert_eq!(meta.title, "Never Gonna Give You Up");
        assert_eq!(meta.channel, "Rick");
        assert_eq!(meta.duration_seconds, Some(212));
        assert_eq!(
            meta.thumbnail,
            "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
        );
    }
}
