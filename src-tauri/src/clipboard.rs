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
    #[cfg(not(any(target_os = "macos", windows)))]
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

    #[cfg(any(target_os = "macos", windows))]
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

    #[cfg(any(target_os = "macos", windows))]
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

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_snapshot() -> ClipboardSnapshot {
    platform_clipboard_snapshot()
}

#[cfg(windows)]
#[tauri::command]
pub async fn clipboard_snapshot() -> Result<ClipboardSnapshot, String> {
    tauri::async_runtime::spawn_blocking(windows::snapshot)
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

#[cfg(not(any(target_os = "macos", windows)))]
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

#[cfg(windows)]
mod windows {
    use super::{
        ClipboardSnapshot, MAX_CLIPBOARD_IMAGE_BYTES, MAX_CLIPBOARD_TEXT_UTF16_UNITS,
        MAX_CLIPBOARD_TYPES, MAX_CLIPBOARD_TYPE_UTF16_UNITS,
    };
    use std::time::Duration;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW,
        GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    const CF_TEXT: u32 = 1;
    const CF_BITMAP: u32 = 2;
    const CF_TIFF: u32 = 6;
    const CF_DIB: u32 = 8;
    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const CF_DIBV5: u32 = 17;
    const MAX_CLIPBOARD_RAW_BYTES: usize = 64 * 1024 * 1024;
    const MAX_DECODED_RGBA_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_CLIPBOARD_PIXELS: u64 = MAX_DECODED_RGBA_BYTES / 4;
    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const OPEN_CLIPBOARD_ATTEMPTS: u32 = 40;
    const OPEN_CLIPBOARD_RETRY_DELAY: Duration = Duration::from_millis(10);

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    fn open_clipboard() -> Option<ClipboardGuard> {
        for _ in 0..OPEN_CLIPBOARD_ATTEMPTS {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return Some(ClipboardGuard);
            }
            std::thread::sleep(OPEN_CLIPBOARD_RETRY_DELAY);
        }
        None
    }

    fn copy_global(handle: HANDLE, max_bytes: usize) -> Option<Vec<u8>> {
        if handle.is_null() {
            return None;
        }
        // SAFETY: `handle` is a clipboard HGLOBAL from GetClipboardData
        // on the currently open clipboard. GlobalLock is paired with
        // GlobalUnlock before this function returns, and the bytes are
        // copied out so the slice does not outlive the lock.
        unsafe {
            let size = GlobalSize(handle);
            if size == 0 || size > max_bytes {
                return None;
            }
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
            GlobalUnlock(handle);
            Some(bytes)
        }
    }

    fn clipboard_format_name(format: u32) -> String {
        match format {
            CF_TEXT => "CF_TEXT".to_string(),
            CF_BITMAP => "CF_BITMAP".to_string(),
            CF_TIFF => "CF_TIFF".to_string(),
            CF_DIB => "CF_DIB".to_string(),
            CF_UNICODETEXT => "CF_UNICODETEXT".to_string(),
            CF_HDROP => "CF_HDROP".to_string(),
            CF_DIBV5 => "CF_DIBV5".to_string(),
            other => {
                let mut buf = [0u16; MAX_CLIPBOARD_TYPE_UTF16_UNITS];
                let len =
                    unsafe { GetClipboardFormatNameW(other, buf.as_mut_ptr(), buf.len() as i32) };
                if len > 0 {
                    String::from_utf16_lossy(&buf[..len as usize])
                } else {
                    format!("CF_{other}")
                }
            }
        }
    }

    fn enumerate_formats() -> Vec<String> {
        let mut names = Vec::new();
        let mut format = 0u32;
        loop {
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 || names.len() >= MAX_CLIPBOARD_TYPES {
                break;
            }
            names.push(clipboard_format_name(format));
        }
        names
    }

    fn read_unicode_text() -> Option<String> {
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
            return None;
        }
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
        let bytes = copy_global(handle, MAX_CLIPBOARD_IMAGE_BYTES)?;
        if bytes.len() < 2 {
            return None;
        }
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        if units.len() > MAX_CLIPBOARD_TEXT_UTF16_UNITS {
            return None;
        }
        String::from_utf16(&units).ok()
    }

    fn registered_format(name: &str) -> u32 {
        let mut wide: Vec<u16> = name.encode_utf16().collect();
        wide.push(0);
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    fn read_format_bytes(format: u32, max_bytes: usize) -> Option<Vec<u8>> {
        if format == 0 || unsafe { IsClipboardFormatAvailable(format) } == 0 {
            return None;
        }
        let handle = unsafe { GetClipboardData(format) };
        copy_global(handle, max_bytes)
    }

    fn looks_like_png(bytes: &[u8]) -> bool {
        bytes.starts_with(PNG_MAGIC)
    }

    fn dib_pixel_count(dib: &[u8]) -> Option<u64> {
        if dib.len() < 12 {
            return None;
        }
        let width = i32::from_le_bytes(dib[4..8].try_into().ok()?);
        let height = i32::from_le_bytes(dib[8..12].try_into().ok()?);
        if width == 0 || height == 0 {
            return None;
        }
        Some(u64::from(width.unsigned_abs()).saturating_mul(u64::from(height.unsigned_abs())))
    }

    fn prepend_bmp_file_header(dib: &[u8]) -> Option<Vec<u8>> {
        if dib.len() < 40 {
            return None;
        }
        let header_size = u32::from_le_bytes(dib[0..4].try_into().ok()?) as usize;
        if header_size < 40 || header_size > dib.len() {
            return None;
        }
        let bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
        let compression = u32::from_le_bytes(dib[16..20].try_into().ok()?);
        let clr_used = u32::from_le_bytes(dib[32..36].try_into().ok()?);
        const BI_BITFIELDS: u32 = 3;
        const BI_ALPHABITFIELDS: u32 = 6;
        let mask_bytes = match compression {
            BI_BITFIELDS if header_size == 40 => 12,
            BI_ALPHABITFIELDS if header_size == 40 => 16,
            _ => 0,
        };
        let palette_bytes = if bit_count <= 8 {
            let entries = if clr_used == 0 {
                1usize << bit_count
            } else {
                clr_used as usize
            };
            entries.saturating_mul(4)
        } else {
            0
        };
        let off_bits = 14usize
            .saturating_add(header_size)
            .saturating_add(mask_bytes)
            .saturating_add(palette_bytes);
        if off_bits > 14 + dib.len() {
            return None;
        }
        let file_size = 14 + dib.len();
        if file_size > MAX_CLIPBOARD_RAW_BYTES + 14 {
            return None;
        }
        let mut bmp = Vec::with_capacity(file_size);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0]);
        bmp.extend_from_slice(&(off_bits as u32).to_le_bytes());
        bmp.extend_from_slice(dib);
        Some(bmp)
    }

    // Agents accept PNG attachments, not raw CF_DIB/BMP. Pixel cap keeps
    // decoded RGBA within MAX_DECODED_RGBA_BYTES before the BMP decoder runs.
    pub(super) fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
        if dib.len() > MAX_CLIPBOARD_RAW_BYTES {
            return None;
        }
        let pixels = dib_pixel_count(dib)?;
        if pixels == 0 || pixels > MAX_CLIPBOARD_PIXELS {
            return None;
        }
        let bmp = prepend_bmp_file_header(dib)?;
        let image = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp).ok()?;
        let mut out = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .ok()?;
        if out.is_empty() || out.len() > MAX_CLIPBOARD_IMAGE_BYTES {
            return None;
        }
        Some(out)
    }

    fn read_image_png() -> Option<Vec<u8>> {
        for name in ["PNG", "image/png"] {
            let format = registered_format(name);
            if let Some(bytes) = read_format_bytes(format, MAX_CLIPBOARD_IMAGE_BYTES) {
                if looks_like_png(&bytes) {
                    return Some(bytes);
                }
            }
        }
        for format in [CF_DIB, CF_DIBV5] {
            if let Some(dib) = read_format_bytes(format, MAX_CLIPBOARD_RAW_BYTES) {
                if let Some(png) = dib_to_png(&dib) {
                    return Some(png);
                }
            }
        }
        None
    }

    fn has_clipboard_image_format(types: &[String]) -> bool {
        types.iter().any(|kind| {
            matches!(
                kind.as_str(),
                "PNG" | "image/png" | "CF_DIB" | "CF_DIBV5" | "CF_BITMAP" | "CF_TIFF"
            )
        })
    }

    pub(super) fn snapshot() -> Result<ClipboardSnapshot, String> {
        let Some(_guard) = open_clipboard() else {
            return Err("The clipboard is busy or could not be opened".into());
        };
        let change_count = i64::from(unsafe { GetClipboardSequenceNumber() });
        let types = enumerate_formats();
        let text = read_unicode_text();
        match read_image_png() {
            Some(bytes) => Ok(ClipboardSnapshot::image(
                change_count,
                types,
                text,
                "image/png",
                "png",
                bytes,
            )),
            None if text.is_none() && has_clipboard_image_format(&types) => {
                Err("The clipboard image could not be read".into())
            }
            None => Ok(ClipboardSnapshot::empty(change_count, types, text)),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{dib_pixel_count, dib_to_png, looks_like_png, prepend_bmp_file_header};

        fn one_pixel_bgra_dib() -> Vec<u8> {
            let mut dib = vec![0u8; 44];
            dib[0..4].copy_from_slice(&40u32.to_le_bytes());
            dib[4..8].copy_from_slice(&1i32.to_le_bytes());
            dib[8..12].copy_from_slice(&1i32.to_le_bytes());
            dib[12..14].copy_from_slice(&1u16.to_le_bytes());
            dib[14..16].copy_from_slice(&32u16.to_le_bytes());
            dib[16..20].copy_from_slice(&0u32.to_le_bytes());
            dib[20..24].copy_from_slice(&4u32.to_le_bytes());
            dib[40..44].copy_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);
            dib
        }

        #[test]
        fn wraps_dib_as_bmp() {
            let dib = one_pixel_bgra_dib();
            let bmp = prepend_bmp_file_header(&dib).expect("bmp header");
            assert_eq!(&bmp[0..2], b"BM");
            assert_eq!(&bmp[14..], dib);
        }

        #[test]
        fn rejects_empty_dib_dimensions() {
            let mut dib = one_pixel_bgra_dib();
            dib[4..8].copy_from_slice(&0i32.to_le_bytes());
            assert_eq!(dib_pixel_count(&dib), None);
        }

        #[test]
        fn encodes_32bpp_dib_as_png() {
            let png = dib_to_png(&one_pixel_bgra_dib()).expect("png");
            assert!(looks_like_png(&png));
        }

        #[test]
        fn encodes_32bpp_bitfields_dib_as_png() {
            let mut dib = vec![0u8; 56];
            dib[0..4].copy_from_slice(&40u32.to_le_bytes());
            dib[4..8].copy_from_slice(&1i32.to_le_bytes());
            dib[8..12].copy_from_slice(&1i32.to_le_bytes());
            dib[12..14].copy_from_slice(&1u16.to_le_bytes());
            dib[14..16].copy_from_slice(&32u16.to_le_bytes());
            dib[16..20].copy_from_slice(&3u32.to_le_bytes());
            dib[20..24].copy_from_slice(&4u32.to_le_bytes());
            dib[40..44].copy_from_slice(&0x00FF_0000u32.to_le_bytes());
            dib[44..48].copy_from_slice(&0x0000_FF00u32.to_le_bytes());
            dib[48..52].copy_from_slice(&0x0000_00FFu32.to_le_bytes());
            dib[52..56].copy_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);
            let png = dib_to_png(&dib).expect("bitfields png");
            assert!(looks_like_png(&png));
        }

        #[test]
        fn rejects_oversize_declared_dimensions() {
            let mut dib = one_pixel_bgra_dib();
            dib[4..8].copy_from_slice(&20_000i32.to_le_bytes());
            dib[8..12].copy_from_slice(&20_000i32.to_le_bytes());
            assert!(dib_pixel_count(&dib).unwrap() > super::MAX_CLIPBOARD_PIXELS);
            assert!(dib_to_png(&dib).is_none());
        }
    }
}
