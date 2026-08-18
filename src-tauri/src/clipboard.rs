use serde::Serialize;

const MAX_CLIPBOARD_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT_UTF16_UNITS: usize = 4 * 1024 * 1024;
const MAX_CLIPBOARD_TYPES: usize = 128;
const MAX_CLIPBOARD_TYPE_UTF16_UNITS: usize = 1024;

const _: () = {
    assert!(MAX_CLIPBOARD_IMAGE_BYTES >= 10 * 1024 * 1024);
    assert!(MAX_CLIPBOARD_TEXT_UTF16_UNITS >= 1024 * 1024);
    assert!(MAX_CLIPBOARD_TYPES >= 32);
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSnapshot {
    pub supported: bool,
    pub change_count: Option<i64>,
    pub types: Vec<String>,
    pub text: Option<String>,
    pub has_image: bool,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub data_b64: Option<String>,
}

impl ClipboardSnapshot {
    #[cfg(not(target_os = "macos"))]
    fn unsupported() -> Self {
        Self {
            supported: false,
            change_count: None,
            types: Vec::new(),
            text: None,
            has_image: false,
            mime_type: None,
            extension: None,
            data_b64: None,
        }
    }

    #[cfg(target_os = "macos")]
    fn empty(change_count: i64, types: Vec<String>, text: Option<String>) -> Self {
        Self {
            supported: true,
            change_count: Some(change_count),
            types,
            text,
            has_image: false,
            mime_type: None,
            extension: None,
            data_b64: None,
        }
    }

    #[cfg(target_os = "macos")]
    fn image(
        change_count: i64,
        types: Vec<String>,
        text: Option<String>,
        mime_type: &'static str,
        extension: &'static str,
        bytes: Vec<u8>,
    ) -> Self {
        use base64::Engine as _;

        Self {
            supported: true,
            change_count: Some(change_count),
            types,
            text,
            has_image: true,
            mime_type: Some(mime_type.to_string()),
            extension: Some(extension.to_string()),
            data_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        }
    }
}

#[tauri::command]
pub fn clipboard_snapshot() -> ClipboardSnapshot {
    platform_clipboard_snapshot()
}

#[cfg(not(target_os = "macos"))]
fn platform_clipboard_snapshot() -> ClipboardSnapshot {
    ClipboardSnapshot::unsupported()
}

#[cfg(target_os = "macos")]
fn platform_clipboard_snapshot() -> ClipboardSnapshot {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
    };

    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        let change_count = pasteboard.changeCount() as i64;
        let types = pasteboard
            .types()
            .map(|types| {
                types
                    .iter()
                    .take(MAX_CLIPBOARD_TYPES)
                    .filter(|kind| kind.length() <= MAX_CLIPBOARD_TYPE_UTF16_UNITS)
                    .map(|kind| kind.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let text = pasteboard
            .stringForType(unsafe { NSPasteboardTypeString })
            .filter(|value| value.length() <= MAX_CLIPBOARD_TEXT_UTF16_UNITS)
            .map(|value| value.to_string());

        if let Some(data) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
            if data.len() > MAX_CLIPBOARD_IMAGE_BYTES {
                return ClipboardSnapshot::empty(change_count, types, text);
            }
            return ClipboardSnapshot::image(
                change_count,
                types,
                text,
                "image/png",
                "png",
                data.to_vec(),
            );
        }

        let Some(tiff_data) = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF }) else {
            return ClipboardSnapshot::empty(change_count, types, text);
        };
        if tiff_data.len() > MAX_CLIPBOARD_IMAGE_BYTES {
            return ClipboardSnapshot::empty(change_count, types, text);
        }

        // Do not decode arbitrary TIFF clipboard payloads inside the Acorn
        // process. Keeping the original bounded bytes avoids decompression
        // bombs while preserving the TIFF attachment fallback.
        ClipboardSnapshot::image(
            change_count,
            types,
            text,
            "image/tiff",
            "tiff",
            tiff_data.to_vec(),
        )
    })
}
