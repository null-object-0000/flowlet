fn main() {
    println!("cargo:rustc-check-cfg=cfg(mobile)");
    #[cfg(feature = "mobile")]
    tauri_build::build();
}
