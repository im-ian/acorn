use std::fs;
use std::path::Path;

// Dotfiles materialised by `shell_init::ensure_shell_init_dir`. Each
// child PTY env carries `ACORN_STAGED_REV = hash(of these files)` so
// the app can detect a stale daemon session (spawned by an older
// build with different dotfile bodies) on boot and force-respawn it.
//
// FNV-1a 64-bit chosen over sha2 to avoid adding a build-dependency;
// collision risk is negligible for the small input set and the
// downstream check only needs equality.
const STAGED_DOTFILES: &[&str] = &[
    "shell-init/zshenv",
    "shell-init/zprofile",
    "shell-init/zshrc",
    "shell-init/zlogin",
];

fn main() {
    let mut hash: u64 = 0xcbf29ce4_84222325;
    for path in STAGED_DOTFILES {
        println!("cargo:rerun-if-changed={path}");
        let bytes = fs::read(Path::new(path))
            .unwrap_or_else(|e| panic!("read {path}: {e}"));
        for b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        // Inter-file separator so reordering bytes across files does
        // not collide with a contiguous-bytes input.
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    println!("cargo:rustc-env=ACORN_STAGED_REV={hash:016x}");

    tauri_build::build();
}
