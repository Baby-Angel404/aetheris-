use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};
use tokio::time::timeout;

use crate::ytdlp::validate_video_id;

/// Default LRU disk budget: 5 GiB
pub const DEFAULT_MAX_CACHE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS: usize = 2;
const DOWNLOAD_TIMEOUT_SECS: u64 = 1800; // 30 minutes per video max

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CacheJobStatus {
    Queued,
    Downloading,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheJobInfo {
    pub video_id: String,
    pub title: String,
    pub status: CacheJobStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub video_id: String,
    pub title: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub last_accessed_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSummary {
    pub cache_dir: String,
    pub total_bytes: u64,
    pub max_bytes: u64,
    pub file_count: usize,
    pub entries: Vec<CacheEntry>,
    pub active_jobs: Vec<CacheJobInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheAck {
    pub video_id: String,
    pub already_cached: bool,
    pub file_path: Option<String>,
    pub status: CacheJobStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarMeta {
    video_id: String,
    title: String,
    last_accessed_unix: u64,
}

#[derive(Clone)]
pub struct CacheState {
    pub cache_dir: PathBuf,
    pub max_bytes: u64,
    semaphore: Arc<Semaphore>,
    jobs: Arc<Mutex<HashMap<String, CacheJobInfo>>>,
    fs_lock: Arc<Mutex<()>>,
}

impl CacheState {
    pub fn new(cache_dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            cache_dir,
            max_bytes,
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            fs_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn video_path(&self, video_id: &str) -> PathBuf {
        self.cache_dir.join(format!("{video_id}.webm"))
    }

    pub fn part_path(&self, video_id: &str) -> PathBuf {
        self.cache_dir.join(format!("{video_id}.webm.part"))
    }

    pub async fn get_cached_path_and_touch(&self, video_id: &str) -> Option<PathBuf> {
        let path = self.video_path(video_id);
        if !path.is_file() {
            return None;
        }
        let _guard = self.fs_lock.lock().await;
        touch_sidecar_access(&self.cache_dir, video_id, None);
        Some(path)
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sidecar_path(cache_dir: &Path, video_id: &str) -> PathBuf {
    cache_dir.join(format!("{video_id}.meta.json"))
}

fn read_sidecar(cache_dir: &Path, video_id: &str) -> Option<SidecarMeta> {
    let raw = std::fs::read_to_string(sidecar_path(cache_dir, video_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_sidecar(cache_dir: &Path, meta: &SidecarMeta) {
    if let Ok(json) = serde_json::to_string(meta) {
        let _ = std::fs::write(sidecar_path(cache_dir, &meta.video_id), json);
    }
}

fn touch_sidecar_access(cache_dir: &Path, video_id: &str, title: Option<&str>) {
    let existing = read_sidecar(cache_dir, video_id);
    let resolved_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| existing.map(|m| m.title))
        .unwrap_or_else(|| format!("Video {video_id}"));

    write_sidecar(
        cache_dir,
        &SidecarMeta {
            video_id: video_id.to_string(),
            title: resolved_title,
            last_accessed_unix: now_unix(),
        },
    );
}

fn file_modified_unix(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Scans cached `.mp4` files in `cache_dir` (ignoring `.part` and `.meta.json`).
pub fn scan_cache_entries(cache_dir: &Path) -> Result<Vec<CacheEntry>, String> {
    if !cache_dir.exists() {
        return Ok(Vec::new());
    }

    let read_dir = std::fs::read_dir(cache_dir).map_err(|e| format!("Failed reading cache dir: {e}"))?;
    let mut entries = Vec::new();

    for item in read_dir.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if ext != "webm" && ext != "mp4" {
            continue;
        }
        let Some(video_id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let Ok(fs_meta) = item.metadata() else {
            continue;
        };
        let sidecar = read_sidecar(cache_dir, &video_id);
        let last_accessed_unix = sidecar
            .as_ref()
            .map(|m| m.last_accessed_unix)
            .unwrap_or_else(|| file_modified_unix(&fs_meta));
        let title = sidecar
            .map(|m| m.title)
            .unwrap_or_else(|| format!("Video {video_id}"));

        entries.push(CacheEntry {
            video_id,
            title,
            file_path: path.to_string_lossy().to_string(),
            size_bytes: fs_meta.len(),
            last_accessed_unix,
        });
    }

    // Most recently accessed first for UI display
    entries.sort_by(|a, b| b.last_accessed_unix.cmp(&a.last_accessed_unix));
    Ok(entries)
}

/// Enforces `max_bytes` using Least Recently Used eviction.
/// Entries in `protected_ids` are skipped so an actively promoted video isn't evicted immediately.
pub fn enforce_lru_limit(
    cache_dir: &Path,
    max_bytes: u64,
    protected_ids: &[&str],
) -> Result<Vec<String>, String> {
    let mut entries = scan_cache_entries(cache_dir)?;
    let mut total_bytes: u64 = entries.iter().map(|e| e.size_bytes).sum();
    if total_bytes <= max_bytes {
        return Ok(Vec::new());
    }

    // Sort oldest accessed first for eviction
    entries.sort_by(|a, b| {
        a.last_accessed_unix
            .cmp(&b.last_accessed_unix)
            .then_with(|| a.video_id.cmp(&b.video_id))
    });

    let mut evicted = Vec::new();
    for entry in entries {
        if total_bytes <= max_bytes {
            break;
        }
        if protected_ids.contains(&entry.video_id.as_str()) {
            continue;
        }

        if std::fs::remove_file(&entry.file_path).is_ok() {
            let _ = std::fs::remove_file(sidecar_path(cache_dir, &entry.video_id));
            total_bytes = total_bytes.saturating_sub(entry.size_bytes);
            evicted.push(entry.video_id);
        }
    }

    Ok(evicted)
}

async fn emit_cache_update(app: &tauri::AppHandle, video_id: &str, status: CacheJobStatus) {
    let payload = serde_json::json!({
        "videoId": video_id,
        "status": status,
    });
    let _ = app.emit("cache-updated", payload);
}

#[tauri::command]
pub async fn cache_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, CacheState>,
    video_id: String,
    title: Option<String>,
) -> Result<CacheAck, String> {
    let clean_id = validate_video_id(&video_id)?;
    let display_title = title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&clean_id)
        .to_string();

    std::fs::create_dir_all(&state.cache_dir)
        .map_err(|e| format!("Failed creating cache directory: {e}"))?;

    let final_path = state.video_path(&clean_id);
    if final_path.is_file() {
        let _guard = state.fs_lock.lock().await;
        touch_sidecar_access(&state.cache_dir, &clean_id, Some(&display_title));
        return Ok(CacheAck {
            video_id: clean_id,
            already_cached: true,
            file_path: Some(final_path.to_string_lossy().to_string()),
            status: CacheJobStatus::Completed,
        });
    }

    {
        let mut jobs = state.jobs.lock().await;
        if let Some(existing) = jobs.get(&clean_id) {
            if matches!(
                existing.status,
                CacheJobStatus::Queued | CacheJobStatus::Downloading
            ) {
                return Ok(CacheAck {
                    video_id: clean_id,
                    already_cached: false,
                    file_path: None,
                    status: existing.status.clone(),
                });
            }
        }

        jobs.insert(
            clean_id.clone(),
            CacheJobInfo {
                video_id: clean_id.clone(),
                title: display_title.clone(),
                status: CacheJobStatus::Queued,
                error: None,
            },
        );
    }

    emit_cache_update(&app, &clean_id, CacheJobStatus::Queued).await;

    let state_clone = state.inner().clone();
    let app_clone = app.clone();
    let id_clone = clean_id.clone();
    let title_clone = display_title.clone();

    tauri::async_runtime::spawn(async move {
        let Ok(_permit) = state_clone.semaphore.clone().acquire_owned().await else {
            return;
        };

        {
            let mut jobs = state_clone.jobs.lock().await;
            if let Some(job) = jobs.get_mut(&id_clone) {
                job.status = CacheJobStatus::Downloading;
                job.error = None;
            }
        }
        emit_cache_update(&app_clone, &id_clone, CacheJobStatus::Downloading).await;

        let part_path = state_clone.part_path(&id_clone);
        let final_path = state_clone.video_path(&id_clone);
        let _ = std::fs::remove_file(&part_path);

        let watch_url = format!("https://www.youtube.com/watch?v={id_clone}");
        let part_str = part_path.to_string_lossy().to_string();

        let mut cmd = Command::new("yt-dlp");
        cmd.args([
            "--js-runtimes",
            "node",
            "-f",
            "bestvideo[height<=1080][ext=webm]+bestaudio[ext=webm]/best[ext=webm]/bestvideo[height<=1080]+bestaudio/best[height<=1080]",
            "--merge-output-format",
            "webm",
            "--no-playlist",
            "--no-warnings",
            "-o",
            &part_str,
            &watch_url,
        ]);

        let result = timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS), cmd.output()).await;

        let outcome: Result<(), String> = match result {
            Ok(Ok(out)) if out.status.success() => {
                if part_path.is_file() {
                    let _guard = state_clone.fs_lock.lock().await;
                    if let Err(e) = std::fs::rename(&part_path, &final_path) {
                        let _ = std::fs::remove_file(&part_path);
                        Err(format!("Failed finalizing cached video: {e}"))
                    } else {
                        touch_sidecar_access(&state_clone.cache_dir, &id_clone, Some(&title_clone));
                        let _ = enforce_lru_limit(
                            &state_clone.cache_dir,
                            state_clone.max_bytes,
                            &[id_clone.as_str()],
                        );
                        Ok(())
                    }
                } else {
                    Err("yt-dlp exited successfully but output file is missing".to_string())
                }
            }
            Ok(Ok(out)) => {
                let _ = std::fs::remove_file(&part_path);
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if msg.is_empty() {
                    "yt-dlp failed downloading video".to_string()
                } else {
                    msg
                })
            }
            Ok(Err(e)) => {
                let _ = std::fs::remove_file(&part_path);
                Err(format!("Failed to launch yt-dlp: {e}"))
            }
            Err(_) => {
                let _ = std::fs::remove_file(&part_path);
                Err("Background download timed out".to_string())
            }
        };

        match outcome {
            Ok(()) => {
                let mut jobs = state_clone.jobs.lock().await;
                if let Some(job) = jobs.get_mut(&id_clone) {
                    job.status = CacheJobStatus::Completed;
                    job.error = None;
                }
                drop(jobs);
                emit_cache_update(&app_clone, &id_clone, CacheJobStatus::Completed).await;
            }
            Err(err_msg) => {
                let mut jobs = state_clone.jobs.lock().await;
                if let Some(job) = jobs.get_mut(&id_clone) {
                    job.status = CacheJobStatus::Failed;
                    job.error = Some(err_msg);
                }
                drop(jobs);
                emit_cache_update(&app_clone, &id_clone, CacheJobStatus::Failed).await;
            }
        }
    });

    Ok(CacheAck {
        video_id: clean_id,
        already_cached: false,
        file_path: None,
        status: CacheJobStatus::Queued,
    })
}

#[tauri::command]
pub async fn get_cache_summary(state: tauri::State<'_, CacheState>) -> Result<CacheSummary, String> {
    let entries = {
        let _guard = state.fs_lock.lock().await;
        scan_cache_entries(&state.cache_dir)?
    };
    let total_bytes = entries.iter().map(|e| e.size_bytes).sum();
    let file_count = entries.len();

    let jobs_guard = state.jobs.lock().await;
    let active_jobs: Vec<CacheJobInfo> = jobs_guard
        .values()
        .filter(|j| matches!(j.status, CacheJobStatus::Queued | CacheJobStatus::Downloading | CacheJobStatus::Failed))
        .cloned()
        .collect();

    Ok(CacheSummary {
        cache_dir: state.cache_dir.to_string_lossy().to_string(),
        total_bytes,
        max_bytes: state.max_bytes,
        file_count,
        entries,
        active_jobs,
    })
}

#[tauri::command]
pub async fn remove_cached_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, CacheState>,
    video_id: String,
) -> Result<(), String> {
    let clean_id = validate_video_id(&video_id)?;
    {
        let _guard = state.fs_lock.lock().await;
        let path = state.video_path(&clean_id);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Failed removing cached file: {e}"))?;
        }
        let _ = std::fs::remove_file(sidecar_path(&state.cache_dir, &clean_id));
    }
    state.jobs.lock().await.remove(&clean_id);
    emit_cache_update(&app, &clean_id, CacheJobStatus::Completed).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, CacheState>,
) -> Result<usize, String> {
    let mut removed = 0usize;
    {
        let _guard = state.fs_lock.lock().await;
        let entries = scan_cache_entries(&state.cache_dir)?;
        for entry in entries {
            if std::fs::remove_file(&entry.file_path).is_ok() {
                let _ = std::fs::remove_file(sidecar_path(&state.cache_dir, &entry.video_id));
                removed += 1;
            }
        }
    }
    state.jobs.lock().await.retain(|_, j| {
        matches!(j.status, CacheJobStatus::Queued | CacheJobStatus::Downloading)
    });
    emit_cache_update(&app, "all", CacheJobStatus::Completed).await;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_cache_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("my_yt_desktop_test_{name}_{}", now_unix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_dummy_video(dir: &Path, id: &str, bytes: usize, access_ts: u64) {
        fs::write(dir.join(format!("{id}.mp4")), vec![0u8; bytes]).unwrap();
        write_sidecar(
            dir,
            &SidecarMeta {
                video_id: id.to_string(),
                title: format!("Title {id}"),
                last_accessed_unix: access_ts,
            },
        );
    }

    #[test]
    fn scan_ignores_part_files_and_sorts_recent_first() {
        let dir = temp_cache_dir("scan");
        write_dummy_video(&dir, "vid_old1234", 100, 10);
        write_dummy_video(&dir, "vid_new1234", 200, 50);
        fs::write(dir.join("vid_part123.mp4.part"), vec![1u8; 999]).unwrap();

        let entries = scan_cache_entries(&dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].video_id, "vid_new1234");
        assert_eq!(entries[1].video_id, "vid_old1234");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lru_evicts_oldest_and_respects_protected_ids() {
        let dir = temp_cache_dir("lru");
        write_dummy_video(&dir, "oldest_0001", 400, 100);
        write_dummy_video(&dir, "middle_0002", 400, 200);
        write_dummy_video(&dir, "newest_0003", 400, 300);

        // Max budget = 700 bytes, protect oldest_0001 -> middle_0002 should be evicted first
        let evicted = enforce_lru_limit(&dir, 800, &["oldest_0001"]).unwrap();
        assert_eq!(evicted, vec!["middle_0002".to_string()]);
        assert!(dir.join("oldest_0001.mp4").exists());
        assert!(!dir.join("middle_0002.mp4").exists());
        assert!(dir.join("newest_0003.mp4").exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
