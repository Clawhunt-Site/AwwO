fn main() {
    println!("cargo:rerun-if-env-changed=AWWO_WINDOWS_CLOUD_URL");
    tauri_build::build();
}
