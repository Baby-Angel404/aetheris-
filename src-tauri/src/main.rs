// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
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

    my_yt_desktop_lib::run()
}
