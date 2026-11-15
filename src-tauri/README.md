# Flowlet Android host

This crate contains the Android synchronization viewer only. Desktop Electron and Web/Docker
use `packages/flowlet-core`; do not add desktop commands, local Agent adapters, proxy servers,
tray/window management, or legacy CLI binaries here.

Build with `npm run tauri:android:build`. Test the portable synchronization core with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --locked
```

The default Cargo feature is `mobile`. Shared resources live in `resources/`, and fixtures in
`tests/fixtures/`. Preserve the existing database schema, sync wire formats and credential keys.
See [Android Rust boundary](../docs/android-rust-boundary.md) for the retained dependency surface.
