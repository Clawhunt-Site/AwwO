fn main() {
    // By default tauri-build embeds the Windows EXE icon by resolving
    // `bundle.icon` (a path relative to this crate) through the MS Resource
    // Compiler (rc.exe). rc.exe mangles some characters in the *absolute* source
    // path it derives — most notably an apostrophe in an ancestor directory
    // (e.g. a checkout under `.../Bob's code/...`) becomes `\'` and fails with
    // RC2135 "file not found". `SUPERCLAW_WINDOWS_ICON` is an escape hatch: point
    // it at a copy of the .ico on an RC-safe path and only the embedded EXE icon
    // uses it; the installer bundler still reads `bundle.icon` as usual. Unset on
    // normal / CI checkouts (clean paths), so the default behavior is unchanged.
    #[allow(unused_mut)]
    let mut attributes = tauri_build::Attributes::new();
    #[cfg(windows)]
    {
        if let Ok(icon) = std::env::var("SUPERCLAW_WINDOWS_ICON") {
            if !icon.trim().is_empty() {
                attributes = attributes.windows_attributes(
                    tauri_build::WindowsAttributes::new().window_icon_path(icon),
                );
            }
        }
    }
    tauri_build::try_build(attributes).expect("failed to run tauri build script");
}
