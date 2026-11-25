// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Ensure user-local binaries (e.g. ~/.local/bin/yt-dlp) are discoverable even when
        // launched from a GUI file manager / AppImage desktop entry without shell PATH.
        if let Some(home) = std::env::var_os("HOME") {
            let local_bin = std::path::PathBuf::from(home).join(".local/bin");
            if local_bin.is_dir() {
                let current_path = std::env::var_os("PATH").unwrap_or_default();
                let mut paths: Vec<std::path::PathBuf> = std::env::split_paths(&current_path).collect();
                if !paths.iter().any(|p| p == &local_bin) {
                    paths.insert(0, local_bin);
                    if let Ok(joined) = std::env::join_paths(paths) {
                        std::env::set_var("PATH", joined);
                    }
                }
            }
        }

        if std::env::var_os("APPIMAGE").is_some() {
            // AppRun sets PYTHONHOME/PYTHONPATH pointing inside the AppImage mount, which crashes
            // host Python-based tools like yt-dlp (`Fatal Python error: init_fs_encoding`).
            std::env::remove_var("PYTHONHOME");
            std::env::remove_var("PYTHONPATH");

            // Avoid WebKitGTK DMABUF blank-frame/crash issues inside AppImage on Wayland/Linux
            if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }

            // AppRun sets GST_PLUGIN_SYSTEM_PATH_1_0 to a missing directory inside the AppImage mount,
            // hiding host GStreamer plugins (vp8dec, vp9dec, opusdec, matroska, soup) from WebKitGTK.
            for candidate in [
                "/usr/lib/gstreamer-1.0",
                "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
                "/usr/lib64/gstreamer-1.0",
            ] {
                if std::path::Path::new(candidate).is_dir() {
                    std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", candidate);
                    std::env::set_var("GST_PLUGIN_SYSTEM_PATH", candidate);
                    break;
                }
            }
        }
    }

    my_yt_desktop_lib::run()
}
