use crate::native_pi_manager::NativeLaunchSpec;
use crate::omp_paths;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

mod extensions;

use extensions::resolve_bundled_extensions;

pub fn bundled_omp_version() -> &'static str {
    env!("PICOT_OMP_VERSION_BUNDLED")
}

#[derive(Clone)]
pub struct PiLaunchResolver {
    static_dir: PathBuf,
}

impl PiLaunchResolver {
    pub fn new(static_dir: PathBuf) -> Self {
        Self { static_dir }
    }

    pub fn native_launch_spec(
        &self,
        cwd: &str,
        session_path: Option<&str>,
    ) -> Result<NativeLaunchSpec, String> {
        let binary = self.resolve_bundled_pi()?;
        let extensions =
            resolve_bundled_extensions(&self.static_dir, Path::new(cwd), session_path.is_some())?;
        Ok(NativeLaunchSpec {
            binary,
            cwd: PathBuf::from(strip_verbatim_prefix(cwd)),
            session_path: session_path.map(|path| PathBuf::from(strip_verbatim_prefix(path))),
            extensions,
            agent_dir: omp_paths::agent_dir()?,
            omp_version: bundled_omp_version().to_owned(),
            path_env: build_augmented_path(),
        })
    }

    /// Run the embedded OMP CLI with the given arguments and return trimmed stdout.
    /// Blocking; callers on an async runtime should wrap this in `spawn_blocking`.
    pub fn run_omp_command(&self, args: &[&str], cwd: Option<&str>) -> Result<String, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        let mut command = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut command);
        if let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
            command.current_dir(strip_verbatim_prefix(cwd));
        }
        command
            .args(args)
            .env(omp_paths::AGENT_DIR_ENV, omp_paths::agent_dir()?)
            .env("PATH", augmented_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.output().map_err(|error| {
            format!("Failed to run embedded OMP command ({pi_bin_str} {args:?}): {error}")
        })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit status {}", output.status)
        };
        Err(format!(
            "Embedded OMP command failed: {pi_bin_str} {args:?}: {details}"
        ))
    }

    pub fn list_omp_plugins(&self, cwd: &str) -> Result<serde_json::Value, String> {
        let output = self.run_omp_command(&["plugin", "list", "--json"], Some(cwd))?;
        serde_json::from_str(&output)
            .map_err(|error| format!("OMP plugin list returned invalid JSON: {error}"))
    }

    pub fn install_omp_plugin(&self, source: &str, cwd: &str) -> Result<(), String> {
        self.run_omp_command(&["plugin", "install", source], Some(cwd))
            .map(|_| ())
    }

    pub fn uninstall_omp_plugin(
        &self,
        plugin_id: &str,
        kind: &str,
        scope: &str,
        cwd: &str,
    ) -> Result<(), String> {
        let mut args = vec!["plugin", "uninstall", plugin_id];
        if kind == "marketplace" {
            args.extend(["--scope", scope]);
        }
        self.run_omp_command(&args, Some(cwd)).map(|_| ())
    }

    pub fn update_omp_plugin(
        &self,
        plugin_id: &str,
        kind: &str,
        scope: &str,
        cwd: &str,
    ) -> Result<(), String> {
        if kind == "marketplace" {
            self.run_omp_command(
                &["plugin", "upgrade", plugin_id, "--scope", scope],
                Some(cwd),
            )
            .map(|_| ())
        } else {
            Err("OMP only supports in-place upgrades for marketplace plugins".to_string())
        }
    }

    pub fn set_omp_plugin_enabled(
        &self,
        plugin_id: &str,
        kind: &str,
        scope: &str,
        enabled: bool,
        cwd: &str,
    ) -> Result<(), String> {
        let action = if enabled { "enable" } else { "disable" };
        let mut args = vec!["plugin", action, plugin_id];
        if kind == "marketplace" {
            args.extend(["--scope", scope]);
        }
        self.run_omp_command(&args, Some(cwd)).map(|_| ())
    }

    /// Resolve the bundled `pi` binary path (as a spawnable command string,
    /// with any Windows verbatim prefix stripped) and its augmented `PATH`
    /// env var. Exposed for callers (e.g. model connectivity checks) that
    /// need to spawn the embedded CLI directly rather than through
    /// `run_omp_command`.
    pub fn resolve_bundled_pi_for_spawn(&self) -> Result<(String, String), String> {
        let binary = self.resolve_bundled_pi()?;
        let binary_str = strip_verbatim_prefix(&binary.to_string_lossy());
        Ok((binary_str, build_augmented_path()))
    }

    pub fn bundled_pi_path(&self) -> Result<PathBuf, String> {
        self.resolve_bundled_pi()
    }

    fn resolve_bundled_pi(&self) -> Result<PathBuf, String> {
        let bin_name = if cfg!(target_os = "windows") {
            "omp.exe"
        } else {
            "omp"
        };

        if let Ok(explicit) = std::env::var("OMP_BIN") {
            let candidate = PathBuf::from(explicit.trim());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }

        let mut tried = Vec::new();
        if let Some(candidate) = self
            .static_dir
            .parent()
            .map(|parent| parent.join("omp").join(bin_name))
        {
            if candidate.is_file() {
                return Ok(candidate);
            }
            tried.push(candidate);
        }

        if cfg!(debug_assertions) {
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("omp")
                .join(bin_name);
            if dev_path.is_file() {
                return Ok(dev_path);
            }
            tried.push(dev_path);
        }

        Err(format!(
            "Could not find embedded OMP binary. Tried:\n{}\n\n\
             For dev: run `bun run stage:omp` from apps/desktop.\n\
             For release: the app bundle is missing `resources/omp/{bin_name}`. \
             Reinstall Picot.",
            tried
                .iter()
                .map(|path| format!("  - {}", path.display()))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }
}

fn build_augmented_path() -> String {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let home = Path::new(&home);
            if let Ok(plugins_bin) = omp_paths::plugins_bin_dir() {
                extras.push(plugins_bin);
            }
            extras.push(home.join(".local/bin"));
            extras.push(home.join(".bun/bin"));
            extras.push(home.join(".volta/bin"));
            extras.push(home.join(".cargo/bin"));
            extras.push(home.join(".local/share/mise/shims"));
            let nvm_root = home.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extras.push(bin);
                    }
                }
            }
        }

        for extra in extras {
            if !dirs.iter().any(|dir| dir == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let home = Path::new(&home);
            if let Ok(plugins_bin) = omp_paths::plugins_bin_dir() {
                extras.push(plugins_bin);
            }
            extras.push(home.join(".cargo").join("bin"));
            extras.push(home.join(".bun").join("bin"));
            extras.push(home.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|dir| dir == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs)
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppTarget {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub app_name: Option<String>,
    pub command: Option<String>,
}

#[cfg(target_os = "macos")]
fn macos_installed_app_names() -> HashSet<String> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut names = HashSet::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                names.insert(stem.to_ascii_lowercase());
            }
        }
    }
    names
}

/// List launch targets Picot can use to open a workspace in an external app.
pub fn list_installed_apps() -> Vec<AppTarget> {
    let candidates: [(&str, &str, &[&str], &str); 6] = [
        ("vscode", "VS Code", &["Visual Studio Code", "Code"], "code"),
        ("cursor", "Cursor", &["Cursor"], "cursor"),
        (
            "webstorm",
            "WebStorm",
            &["WebStorm", "WebStorm EAP"],
            "webstorm",
        ),
        ("zed", "Zed", &["Zed"], "zed"),
        ("terminal", "Terminal", &["Terminal", "iTerm", "Warp"], ""),
        ("ghostty", "Ghostty", &["Ghostty"], ""),
    ];

    #[cfg(target_os = "macos")]
    {
        let installed = macos_installed_app_names();
        let mut targets = Vec::new();
        for (id, label, bundle_names, _command) in candidates {
            if let Some(app_name) = bundle_names
                .iter()
                .find(|name| installed.contains(&name.to_ascii_lowercase()))
            {
                targets.push(AppTarget {
                    id: id.to_string(),
                    label: label.to_string(),
                    kind: "app".to_string(),
                    app_name: Some((*app_name).to_string()),
                    command: None,
                });
            }
        }
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "Finder".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut targets: Vec<AppTarget> = candidates
            .iter()
            .filter(|(_, _, _, command)| !command.is_empty())
            .map(|(id, label, _, command)| AppTarget {
                id: id.to_string(),
                label: label.to_string(),
                kind: "command".to_string(),
                app_name: None,
                command: Some(command.to_string()),
            })
            .collect();
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "File Manager".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }
}

/// Open a project directory in an external app (editor / terminal / file manager). Blocking.
pub fn open_in_app(
    path: &str,
    app_name: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Missing path".to_string());
    }

    if let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) {
        let status = Command::new(command)
            .arg(trimmed_path)
            .status()
            .map_err(|error| format!("Failed to launch `{command}`: {error}"))?;
        if !status.success() {
            return Err(format!("`{command}` exited with status {status}"));
        }
        return Ok(());
    }

    if let Some(app_name) = app_name
        .map(str::trim)
        .filter(|app_name| !app_name.is_empty())
    {
        #[cfg(target_os = "macos")]
        let status = Command::new("open")
            .arg("-a")
            .arg(app_name)
            .arg(trimmed_path)
            .status();
        #[cfg(not(target_os = "macos"))]
        let status = Command::new(app_name).arg(trimmed_path).status();

        let status = status.map_err(|error| format!("Failed to open `{app_name}`: {error}"))?;
        if !status.success() {
            return Err(format!("`{app_name}` failed to open (status {status})"));
        }
        return Ok(());
    }

    open_path(trimmed_path)
}

fn open_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(path).status();
    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("explorer");
        configure_child_process_for_windows(&mut command);
        command.arg(path).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(path).status();

    match status.map_err(|error| format!("Failed to reveal path: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("File manager exited with status {code}")),
    }
}

/// Open a URL in the user's default browser via the OS opener. Blocking.
pub fn open_external(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Missing URL".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("cmd");
        configure_child_process_for_windows(&mut command);
        command.args(["/C", "start", "", trimmed]).status()
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    match status.map_err(|error| format!("Failed to open URL: {error}"))? {
        code if code.success() => Ok(()),
        code => Err(format!("Opener exited with status {code}")),
    }
}

#[cfg(target_os = "windows")]
fn configure_child_process_for_windows(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: keep console-less GUI children from flashing a window.
    command.creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process_for_windows(_command: &mut Command) {}

fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim_prefix;

    // Windows `std::fs::canonicalize` returns `\\?\`-prefixed extended-length
    // paths. Bun (the bundled OMP runtime) cannot resolve modules from such
    // paths, so the prefix must be stripped before any canonicalized path
    // reaches pi — as cwd, session path, binary, or extension argument.
    #[test]
    fn strip_verbatim_prefix_removes_extended_length_prefix() {
        // Drive-prefixed extended-length path: strip the `\\?\` prefix,
        // keep the drive letter.
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\WIN10\.omp\agent"),
            r"C:\Users\WIN10\.omp\agent"
        );
        // UNC extended-length path: collapse `\\?\UNC\` to the plain `\\`
        // UNC form.
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\dir"),
            r"\\server\share\dir"
        );
        // Plain Windows path: returned unchanged.
        assert_eq!(strip_verbatim_prefix(r"C:\Users\WIN10"), r"C:\Users\WIN10");
        // Plain POSIX path: returned unchanged (no prefix to strip).
        assert_eq!(
            strip_verbatim_prefix("/home/user/.omp/agent"),
            "/home/user/.omp/agent"
        );
        // Empty string is a valid no-op input.
        assert_eq!(strip_verbatim_prefix(""), "");
    }
}
