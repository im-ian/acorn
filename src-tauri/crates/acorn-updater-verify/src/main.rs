use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_ENCODED_SIGNATURE_BYTES: u64 = 64 * 1024;
const MAX_DECODED_KEY_BYTES: usize = 16 * 1024;
const MAX_DECODED_SIGNATURE_BYTES: usize = 64 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_ARTIFACT_PAIRS: usize = 16;

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn read_bounded_regular_file(path: &Path, max_bytes: u64, label: &str) -> io::Result<Vec<u8>> {
    let (file, metadata) = acorn_platform::fs::open_regular_nofollow(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("cannot safely open {label} {path:?}: {error}"),
        )
    })?;
    if metadata.len() > max_bytes {
        return Err(invalid_data(format!(
            "{label} exceeds the {max_bytes}-byte limit: {path:?}"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid_data(format!(
            "{label} exceeds the {max_bytes}-byte limit: {path:?}"
        )));
    }
    Ok(bytes)
}

fn exact_lines<'a>(value: &'a str, expected: usize, label: &str) -> io::Result<Vec<&'a str>> {
    let lines = value.lines().collect::<Vec<_>>();
    if lines.len() != expected || lines.iter().any(|line| line.is_empty()) {
        return Err(invalid_data(format!(
            "{label} must contain exactly {expected} non-empty lines"
        )));
    }
    Ok(lines)
}

fn decode_public_key(config_bytes: &[u8]) -> io::Result<PublicKey> {
    let config: serde_json::Value = serde_json::from_slice(config_bytes)
        .map_err(|error| invalid_data(format!("invalid Tauri config JSON: {error}")))?;
    let encoded = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid_data("Tauri config is missing plugins.updater.pubkey"))?;
    if encoded.len() > MAX_DECODED_KEY_BYTES * 2 {
        return Err(invalid_data("encoded updater public key is too large"));
    }
    let decoded = BASE64
        .decode(encoded)
        .map_err(|_| invalid_data("updater public key is not valid base64"))?;
    if decoded.len() > MAX_DECODED_KEY_BYTES {
        return Err(invalid_data("decoded updater public key is too large"));
    }
    let text = std::str::from_utf8(&decoded)
        .map_err(|_| invalid_data("decoded updater public key is not UTF-8"))?;
    let lines = exact_lines(text, 2, "updater public key")?;
    if !lines[0].starts_with("untrusted comment: ") {
        return Err(invalid_data(
            "updater public key is missing its untrusted comment",
        ));
    }
    PublicKey::decode(text)
        .map_err(|error| invalid_data(format!("invalid updater public key: {error}")))
}

fn decode_signature(encoded_bytes: &[u8]) -> io::Result<Signature> {
    let encoded = std::str::from_utf8(encoded_bytes)
        .map_err(|_| invalid_data("encoded updater signature is not UTF-8"))?
        .trim();
    if encoded.is_empty() {
        return Err(invalid_data("encoded updater signature is empty"));
    }
    let decoded = BASE64
        .decode(encoded)
        .map_err(|_| invalid_data("updater signature is not valid base64"))?;
    if decoded.len() > MAX_DECODED_SIGNATURE_BYTES {
        return Err(invalid_data("decoded updater signature is too large"));
    }
    let text = std::str::from_utf8(&decoded)
        .map_err(|_| invalid_data("decoded updater signature is not UTF-8"))?;
    let lines = exact_lines(text, 4, "decoded updater signature")?;
    if !lines[0].starts_with("untrusted comment: ") || !lines[2].starts_with("trusted comment: ") {
        return Err(invalid_data(
            "decoded updater signature has invalid comment framing",
        ));
    }
    Signature::decode(text)
        .map_err(|error| invalid_data(format!("invalid updater signature: {error}")))
}

fn verify_reader<R: Read>(
    public_key: &PublicKey,
    signature: &Signature,
    mut reader: R,
    expected_bytes: u64,
) -> io::Result<()> {
    let mut verifier = public_key
        .verify_stream(signature)
        .map_err(|error| invalid_data(format!("cannot initialize signature verifier: {error}")))?;
    let mut total = 0u64;
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| invalid_data("artifact size overflowed while verifying"))?;
        if total > expected_bytes || total > MAX_ARTIFACT_BYTES {
            return Err(invalid_data(
                "artifact grew or exceeded its size limit while verifying",
            ));
        }
        verifier.update(&buffer[..read]);
    }
    if total != expected_bytes {
        return Err(invalid_data(format!(
            "artifact changed size while verifying: expected {expected_bytes}, read {total}"
        )));
    }
    verifier
        .finalize()
        .map_err(|error| invalid_data(format!("updater signature verification failed: {error}")))
}

fn verify_artifact(public_key: &PublicKey, artifact: &Path, signature: &Path) -> io::Result<()> {
    let signature_bytes =
        read_bounded_regular_file(signature, MAX_ENCODED_SIGNATURE_BYTES, "updater signature")?;
    let signature = decode_signature(&signature_bytes)?;

    let (file, metadata) = acorn_platform::fs::open_regular_nofollow(artifact)?;
    if metadata.len() == 0 || metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(invalid_data(format!(
            "updater artifact has an invalid size {}: {artifact:?}",
            metadata.len()
        )));
    }
    verify_reader(public_key, &signature, file, metadata.len())?;
    println!("verified updater signature: {artifact:?}");
    Ok(())
}

fn parse_arguments(
    arguments: impl IntoIterator<Item = OsString>,
) -> io::Result<(PathBuf, Vec<(PathBuf, PathBuf)>)> {
    let values = arguments.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    if values.len() < 3 || (values.len() - 1) % 2 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: acorn-updater-verify <tauri.conf.json> <artifact> <signature> [<artifact> <signature> ...]",
        ));
    }
    let pair_count = (values.len() - 1) / 2;
    if pair_count > MAX_ARTIFACT_PAIRS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("cannot verify more than {MAX_ARTIFACT_PAIRS} artifact pairs"),
        ));
    }
    let config = values[0].clone();
    let pairs = values[1..]
        .chunks_exact(2)
        .map(|pair| (pair[0].clone(), pair[1].clone()))
        .collect();
    Ok((config, pairs))
}

fn run() -> io::Result<()> {
    let (config, pairs) = parse_arguments(std::env::args_os().skip(1))?;
    let config_bytes = read_bounded_regular_file(&config, MAX_CONFIG_BYTES, "Tauri config")?;
    let public_key = decode_public_key(&config_bytes)?;
    for (artifact, signature) in &pairs {
        verify_artifact(&public_key, artifact, signature)?;
    }
    println!("verified {} updater artifact pair(s)", pairs.len());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("updater verification failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";

    fn test_public_key() -> PublicKey {
        let config = serde_json::json!({
            "plugins": {
                "updater": {
                    "pubkey": BASE64.encode(PUBLIC_KEY),
                }
            }
        });
        decode_public_key(&serde_json::to_vec(&config).unwrap()).unwrap()
    }

    fn test_signature() -> Signature {
        decode_signature(BASE64.encode(PREHASHED_SIGNATURE).as_bytes()).unwrap()
    }

    #[test]
    fn verifies_tauri_encoded_prehashed_signature() {
        verify_reader(
            &test_public_key(),
            &test_signature(),
            Cursor::new(b"test"),
            4,
        )
        .unwrap();
    }

    #[test]
    fn rejects_tampered_artifact_and_extra_signature_lines() {
        assert!(verify_reader(
            &test_public_key(),
            &test_signature(),
            Cursor::new(b"Test"),
            4,
        )
        .is_err());

        let extra = format!("{PREHASHED_SIGNATURE}unexpected\n");
        assert!(decode_signature(BASE64.encode(extra).as_bytes()).is_err());
    }

    #[test]
    fn bounds_pair_count_and_requires_complete_pairs() {
        assert!(parse_arguments([OsString::from("config")]).is_err());
        assert!(parse_arguments([
            OsString::from("config"),
            OsString::from("artifact"),
            OsString::from("signature"),
        ])
        .is_ok());
        assert!(parse_arguments([
            OsString::from("config"),
            OsString::from("artifact"),
            OsString::from("signature"),
            OsString::from("orphan"),
        ])
        .is_err());
    }
}
