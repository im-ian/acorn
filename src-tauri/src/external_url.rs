use std::fs;

use tauri::Manager;
use url::Url;

const MAX_EXTERNAL_URL_BYTES: usize = 8 * 1024;
const ALLOWED_MAILTO_QUERY_FIELDS: &[&str] = &["bcc", "body", "cc", "subject"];

fn starts_with_ascii_case_insensitive(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn validate_external_url(value: &str) -> Result<Url, &'static str> {
    if value.is_empty()
        || value.len() > MAX_EXTERNAL_URL_BYTES
        || value.chars().any(|character| {
            character.is_whitespace() || character.is_control() || character == '\\'
        })
    {
        return Err("external URL is empty, oversized, or contains ambiguous characters");
    }

    let parsed = Url::parse(value).map_err(|_| "external URL is malformed")?;
    if starts_with_ascii_case_insensitive(value, "http://")
        || starts_with_ascii_case_insensitive(value, "https://")
    {
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none_or(str::is_empty)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("external web URL is not permitted");
        }
        return Ok(parsed);
    }

    if !starts_with_ascii_case_insensitive(value, "mailto:")
        || parsed.scheme() != "mailto"
        || parsed.path().is_empty()
        || parsed.fragment().is_some()
        || parsed.query_pairs().any(|(key, _)| {
            !ALLOWED_MAILTO_QUERY_FIELDS
                .iter()
                .any(|allowed| key.eq_ignore_ascii_case(allowed))
        })
    {
        return Err("external mail URL is not permitted");
    }

    Ok(parsed)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<bool, String> {
    let validated = validate_external_url(&url).map_err(str::to_owned)?;
    tauri_plugin_opener::open_url(validated.as_str(), None::<&str>)
        .map_err(|error| format!("failed to open external URL: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub fn reveal_themes_folder(app: tauri::AppHandle) -> Result<(), String> {
    let app_local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("failed to resolve application data directory: {error}"))?;
    let themes = app_local_data.join("themes");
    fs::create_dir_all(&themes)
        .map_err(|error| format!("failed to create themes directory: {error}"))?;

    let metadata = fs::symlink_metadata(&themes)
        .map_err(|error| format!("failed to inspect themes directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("themes path must be a real directory".to_string());
    }

    let canonical_root = app_local_data
        .canonicalize()
        .map_err(|error| format!("failed to resolve application data directory: {error}"))?;
    let canonical_themes = themes
        .canonicalize()
        .map_err(|error| format!("failed to resolve themes directory: {error}"))?;
    if !canonical_themes.starts_with(&canonical_root) {
        return Err("themes directory escaped application data".to_string());
    }

    tauri_plugin_opener::open_path(&canonical_themes, None::<&str>)
        .map_err(|error| format!("failed to reveal themes directory: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_explicit_web_and_safe_mail_urls() {
        for value in [
            "https://github.com/im-ian/acorn",
            "http://localhost:8010/path?q=1",
            "mailto:security@example.com?subject=Report&body=Details",
        ] {
            assert!(validate_external_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn rejects_ambiguous_or_privileged_urls() {
        let oversized = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_BYTES));
        let oversized_unicode = format!("https://example.com/{}", "한".repeat(3 * 1024));
        for value in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "//tracker.example/path",
            " https://tracker.example/path",
            "https://tracker.example/a path",
            "https://user:secret@tracker.example/path",
            "https:\\tracker.example\\path",
            "mailto:",
            "mailto:security@example.com?attach=/etc/passwd",
            "mailto:security@example.com#fragment",
            &oversized,
            &oversized_unicode,
        ] {
            assert!(validate_external_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn canonicalizes_only_after_strict_source_validation() {
        let parsed = validate_external_url("HTTPS://EXAMPLE.COM/a/../b").unwrap();
        assert_eq!(parsed.as_str(), "https://example.com/b");
        assert!(validate_external_url("https:\n//example.com").is_err());
    }
}
