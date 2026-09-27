fn main() {
    println!("cargo:rerun-if-env-changed=AWWO_WINDOWS_CLOUD_URL");
    println!("cargo:rerun-if-env-changed=AWWO_WINDOWS_ACCESS_ORIGIN");
    println!("cargo:rerun-if-env-changed=AWWO_WINDOWS_IDP_ORIGINS");
    tauri_build::build();
}
