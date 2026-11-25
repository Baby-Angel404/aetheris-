pub mod cache;
pub mod stream_server;
pub mod ytdlp;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let base_cache = app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?;
            let videos_dir = base_cache.join("videos");
            std::fs::create_dir_all(&videos_dir)
                .map_err(|e| format!("Failed to create video cache dir: {e}"))?;

            let cache_state = cache::CacheState::new(videos_dir.clone(), cache::DEFAULT_MAX_CACHE_BYTES);
            app.manage(cache_state);

            let native_h264 = stream_server::has_native_h264_aac_decoders();
            let proxy_port = tauri::async_runtime::block_on(stream_server::start_stream_server(videos_dir))?;
            app.manage(stream_server::StreamProxyState {
                port: proxy_port,
                native_h264,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ytdlp::resolve_stream,
            ytdlp::search_videos,
            ytdlp::get_video_info,
            ytdlp::check_dependencies,
            stream_server::get_stream_proxy_port,
            cache::cache_video,
            cache::get_cache_summary,
            cache::remove_cached_video,
            cache::clear_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
