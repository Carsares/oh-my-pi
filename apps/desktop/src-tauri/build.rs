use std::{fs, path::PathBuf};

/// Hard guarantee: a Picot release build CANNOT be produced without the
/// embedded OMP binary inside `src-tauri/resources/omp/`.
///
/// Why this lives in build.rs
/// --------------------------
/// `tauri.conf.json` already lists `./resources/omp` under `bundle.resources`,
/// and the package scripts run `stage:omp` as a `prebuild` / `beforeBuildCommand`
/// hook. But it is still possible to run `cargo build --release` directly
/// (CI matrix shortcuts, IDE "build" buttons, manual debugging of bundling)
/// without ever going through bun. When that happens the .app is silently
/// produced WITHOUT an OMP binary and end users hit the runtime "Could not
/// find embedded OMP binary" screen — exactly what we are trying to prevent.
///
/// This build script makes that failure mode impossible: in any non-debug
/// cargo build we panic at compile time if the binary is missing, with a
/// clear message pointing the developer at `bun run stage:omp`. Debug builds
/// keep working without the binary so `cargo check` / `clippy` / IDE flows
/// don't require a network round-trip.
fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let extension_dist_dir = manifest_dir.join("..").join("extensions").join("dist");

    // Tauri validates every configured bundle resource while running the build
    // script, even for debug `cargo check` / clippy flows. The extension bundle
    // is generated, so a clean checkout may not have this directory yet.
    fs::create_dir_all(&extension_dist_dir).unwrap_or_else(|err| {
        panic!(
            "failed to create generated extension resource directory at {}: {}",
            extension_dist_dir.display(),
            err
        )
    });

    tauri_build::build();

    // Expose the bundled OMP version as a compile-time env var so Rust code can
    // reference it via env!("PICOT_OMP_VERSION_BUNDLED") instead of
    // duplicating the literal string across multiple files.
    let omp_package_json = manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("coding-agent")
        .join("package.json");
    if let Ok(contents) = fs::read_to_string(&omp_package_json) {
        // Minimal parse: extract the "version" field without pulling in serde.
        if let Some(version) = contents
            .lines()
            .find(|l| l.contains("\"version\""))
            .and_then(|l| l.split('"').nth(3))
        {
            println!("cargo:rustc-env=PICOT_OMP_VERSION_BUNDLED={version}");
        }
    }

    // Re-run if the OMP package or staged binary changes, so cached builds
    // notice when stage:omp has been run between invocations.
    println!("cargo:rerun-if-changed=resources/omp/.version");
    println!("cargo:rerun-if-changed=../../../packages/coding-agent/package.json");
    println!("cargo:rerun-if-changed=../extensions/picot-bridge.ts");
    println!("cargo:rerun-if-changed=../extensions/dist/picot-bridge.mjs");
    println!("cargo:rerun-if-env-changed=PICOT_SKIP_OMP_BIN_CHECK");

    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile != "release" {
        return;
    }

    if std::env::var("PICOT_SKIP_OMP_BIN_CHECK").is_ok() {
        return;
    }

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let bin_name = if target_os == "windows" {
        "omp.exe"
    } else {
        "omp"
    };

    let bin_path = manifest_dir.join("resources").join("omp").join(bin_name);
    let extension_bundle_path = extension_dist_dir.join("picot-bridge.mjs");

    if !bin_path.is_file() {
        panic!(
            "\n\n\
             Picot release build aborted: embedded OMP binary is missing.\n\
             Expected: {}\n\n\
             Picot bundles the OMP runtime inside the app so end users do\n\
             not need to fetch anything. Release builds therefore refuse to\n\
             produce a .app without it.\n\n\
             Fix: run `bun run stage:omp` from apps/desktop before building.\n\
             (Or `bun run build`, which already does this for you.)\n\n\
             To bypass this check (NOT for shipping builds), set\n\
             PICOT_SKIP_OMP_BIN_CHECK=1.\n\n",
            bin_path.display()
        );
    }

    if !extension_bundle_path.is_file() {
        panic!(
            "\n\n\
             Picot release build aborted: picot-bridge extension bundle is missing.\n\
             Expected: {}\n\n\
             Release builds ship the bundled extension instead of relying on\n\
             repo-local TypeScript sources or node_modules.\n\n\
             Fix: run `bun run build:extensions` from the repo root before building.\n\
             (Or `bun run build`, which already does this for you.)\n\n\
             To bypass this check (NOT for shipping builds), set\n\
             PICOT_SKIP_OMP_BIN_CHECK=1.\n\n",
            extension_bundle_path.display()
        );
    }
}
