use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub const AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
pub const PROJECT_DIR_NAME: &str = ".omp";

pub fn agent_dir() -> Result<PathBuf, String> {
    resolve_agent_dir(
        std::env::var_os(AGENT_DIR_ENV).as_deref(),
        dirs::home_dir(),
        std::env::current_dir().ok(),
    )
}

fn resolve_agent_dir(
    override_dir: Option<&OsStr>,
    home_dir: Option<PathBuf>,
    current_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(value) = override_dir.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            Ok(path)
        } else {
            current_dir
                .map(|current| current.join(path))
                .ok_or_else(|| format!("Cannot resolve relative {AGENT_DIR_ENV}"))
        };
    }
    home_dir
        .map(|home| home.join(PROJECT_DIR_NAME).join("agent"))
        .ok_or_else(|| "Cannot resolve home directory for OMP agent data".to_string())
}

pub fn sessions_dir() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("sessions"))
}

pub fn agent_inbox_dir() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("super-agent"))
}

pub fn session_dir_name(cwd: &Path) -> String {
    session_dir_name_with_roots(
        cwd,
        dirs::home_dir().as_deref(),
        Some(std::env::temp_dir()).as_deref(),
    )
}

fn session_dir_name_with_roots(cwd: &Path, home: Option<&Path>, temp: Option<&Path>) -> String {
    let cwd = equivalent_path(cwd);
    if let Some(relative) = home.and_then(|root| cwd.strip_prefix(equivalent_path(root)).ok()) {
        return encode_relative_session_dir("-", relative);
    }
    if let Some(relative) = temp.and_then(|root| cwd.strip_prefix(equivalent_path(root)).ok()) {
        return encode_relative_session_dir("-tmp", relative);
    }

    let raw = cwd.to_string_lossy();
    let stripped = raw.trim_start_matches(['/', '\\']);
    format!("--{}--", encode_path(stripped))
}

fn equivalent_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn encode_relative_session_dir(prefix: &str, relative: &Path) -> String {
    let encoded = encode_path(&relative.to_string_lossy());
    if encoded.is_empty() {
        prefix.to_string()
    } else if prefix.ends_with('-') {
        format!("{prefix}{encoded}")
    } else {
        format!("{prefix}-{encoded}")
    }
}

fn encode_path(path: &str) -> String {
    path.replace(['/', '\\', ':'], "-")
}

#[cfg(test)]
mod tests {
    use super::{resolve_agent_dir, session_dir_name_with_roots};
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    #[test]
    fn resolves_default_override_and_project_paths() {
        assert_eq!(
            resolve_agent_dir(None, Some(PathBuf::from("/Users/me")), None).unwrap(),
            PathBuf::from("/Users/me/.omp/agent")
        );
        assert_eq!(
            resolve_agent_dir(
                Some(OsStr::new("profiles/desktop")),
                None,
                Some(PathBuf::from("/work")),
            )
            .unwrap(),
            PathBuf::from("/work/profiles/desktop")
        );
    }

    #[test]
    fn matches_omp_session_directory_names() {
        let home = Path::new("/Users/me");
        let temp = Path::new("/omp-temp-root");
        assert_eq!(
            session_dir_name_with_roots(
                Path::new("/Users/me/.omp/agent/super-agent"),
                Some(home),
                Some(temp),
            ),
            "-.omp-agent-super-agent"
        );
        assert_eq!(
            session_dir_name_with_roots(
                Path::new("/omp-temp-root/project"),
                Some(home),
                Some(temp),
            ),
            "-tmp-project"
        );
        assert_eq!(
            session_dir_name_with_roots(Path::new("/opt/project"), Some(home), Some(temp)),
            "--opt-project--"
        );
    }
}
