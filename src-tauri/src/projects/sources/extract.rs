//! Text of a project's document (projects-people-brief design.md,
//! decision 2):
//!
//! - `.md`, `.txt`: UTF-8, else Windows-1251;
//! - `.docx`: paragraphs (`w:p`) of `word/document.xml`, their text
//!   (`w:t`), tabs and line breaks;
//! - `.pdf`: `pdf-extract`; fewer than [`MIN_CHARS_PER_PAGE`] non-space
//!   characters a page on average is `no_text` (a scan).
//!
//! The text is cut at [`MAX_TEXT_CHARS`]. A parser that panics gives
//! `failed`, one that hangs gives `failed` after [`EXTRACT_TIMEOUT`]
//! ([`extract_in_background`]).

use std::{
    io::{Cursor, Read as _},
    panic::{self, AssertUnwindSafe},
    time::Duration,
};

use quick_xml::{escape::resolve_predefined_entity, events::Event};

use crate::storage::sources::SourceStatus;

/// Characters of text kept per document.
pub const MAX_TEXT_CHARS: usize = 200_000;
/// A PDF with fewer non-space characters per page on average has no text
/// layer worth reading.
pub const MIN_CHARS_PER_PAGE: usize = 20;
/// How long one document may take to read.
pub const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);
/// `word/document.xml` larger than this is not read (a zip bomb).
const MAX_DOCX_XML_BYTES: u64 = 256 * 1024 * 1024;

/// The document types the app reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Markdown,
    Text,
    Pdf,
    Docx,
}

impl FileKind {
    /// By the extension, any case, without the dot.
    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "md" | "markdown" => Some(Self::Markdown),
            "txt" => Some(Self::Text),
            "pdf" => Some(Self::Pdf),
            "docx" => Some(Self::Docx),
            _ => None,
        }
    }

    /// The extension the copy is stored with.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Text => "txt",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
        }
    }
}

/// What was read from a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extraction {
    pub status: SourceStatus,
    /// Empty unless `status` is `ready`.
    pub text: String,
    pub text_chars: u32,
    pub truncated: bool,
    pub error: Option<String>,
}

impl Extraction {
    fn ready(text: &str) -> Self {
        let text = normalize(text);
        if text.chars().all(char::is_whitespace) {
            return Self::no_text("В документе нет текста");
        }
        let (text, truncated) = cap(text);
        let text_chars = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
        Self {
            status: SourceStatus::Ready,
            text,
            text_chars,
            truncated,
            error: None,
        }
    }

    fn no_text(reason: &str) -> Self {
        Self {
            status: SourceStatus::NoText,
            text: String::new(),
            text_chars: 0,
            truncated: false,
            error: Some(reason.to_owned()),
        }
    }

    fn failed(error: impl Into<String>) -> Self {
        Self {
            status: SourceStatus::Failed,
            text: String::new(),
            text_chars: 0,
            truncated: false,
            error: Some(error.into()),
        }
    }
}

/// Unix line ends, no NULs, no blank edges.
fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace(['\r', '\u{c}'], "\n")
        .replace('\0', "")
        .trim()
        .to_owned()
}

/// At most [`MAX_TEXT_CHARS`] characters; `true` when cut.
fn cap(mut text: String) -> (String, bool) {
    match text.char_indices().nth(MAX_TEXT_CHARS) {
        Some((end, _)) => {
            text.truncate(end);
            (text, true)
        }
        None => (text, false),
    }
}

/// Reads the text of `bytes` as a `kind` document, here and now. A panic of
/// a parser is `failed`.
pub fn extract(kind: FileKind, bytes: &[u8]) -> Extraction {
    guarded(|| match kind {
        FileKind::Markdown | FileKind::Text => Extraction::ready(&decode_text(bytes)),
        FileKind::Docx => match docx_text(bytes) {
            Ok(text) => Extraction::ready(&text),
            Err(error) => Extraction::failed(format!("Не удалось прочитать DOCX: {error}")),
        },
        FileKind::Pdf => pdf_extraction(bytes),
    })
}

/// `failed` instead of a panic. Needs `panic = "unwind"` (the release
/// profile keeps it for this).
fn guarded(job: impl FnOnce() -> Extraction) -> Extraction {
    panic::catch_unwind(AssertUnwindSafe(job))
        .unwrap_or_else(|_| Extraction::failed("Не удалось прочитать файл: он повреждён"))
}

/// [`extract`] on a blocking thread, at most [`EXTRACT_TIMEOUT`].
pub async fn extract_in_background(kind: FileKind, bytes: Vec<u8>) -> Extraction {
    run_limited(EXTRACT_TIMEOUT, move || extract(kind, &bytes)).await
}

/// Runs `job` on a blocking thread; `failed` when it takes longer than
/// `limit` (the thread is left to finish on its own) or dies.
async fn run_limited(
    limit: Duration,
    job: impl FnOnce() -> Extraction + Send + 'static,
) -> Extraction {
    let handle = tauri::async_runtime::spawn_blocking(job);
    match tokio::time::timeout(limit, handle).await {
        Ok(Ok(extraction)) => extraction,
        Ok(Err(error)) => Extraction::failed(format!("Не удалось прочитать файл: {error}")),
        Err(_) => Extraction::failed(format!("Файл читается дольше {} с", limit.as_secs().max(1))),
    }
}

/// UTF-8 (a BOM is dropped), else Windows-1251.
fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => encoding_rs::WINDOWS_1251
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
    }
}

/// The text of `word/document.xml`: a line per paragraph.
fn docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let entry = archive
        .by_name("word/document.xml")
        .map_err(|_| "в архиве нет word/document.xml".to_owned())?;
    let mut xml = String::new();
    entry
        .take(MAX_DOCX_XML_BYTES)
        .read_to_string(&mut xml)
        .map_err(|error| error.to_string())?;
    document_xml_text(&xml)
}

fn document_xml_text(xml: &str) -> Result<String, String> {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut text = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(element) => match element.local_name().as_ref() {
                "t" => in_text = true,
                "tab" => text.push('\t'),
                "br" | "cr" => text.push('\n'),
                _ => {}
            },
            Event::Empty(element) => match element.local_name().as_ref() {
                "tab" => text.push('\t'),
                "br" | "cr" => text.push('\n'),
                "p" => text.push('\n'),
                _ => {}
            },
            Event::End(element) => match element.local_name().as_ref() {
                "t" => in_text = false,
                "p" => text.push('\n'),
                _ => {}
            },
            Event::Text(content) if in_text => text.push_str(&content.xml10_content()),
            Event::CData(content) if in_text => {
                text.push_str(&content.into_inner());
            }
            Event::GeneralRef(reference) if in_text => {
                if let Ok(Some(character)) = reference.resolve_char_ref() {
                    text.push(character);
                } else if let Some(entity) = resolve_predefined_entity(&reference.xml10_content()) {
                    text.push_str(entity);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(text)
}

fn pdf_extraction(bytes: &[u8]) -> Extraction {
    let pages = match pdf_extract::extract_text_from_mem_by_pages(bytes) {
        Ok(pages) => pages,
        Err(error) => return Extraction::failed(format!("Не удалось прочитать PDF: {error}")),
    };
    let visible: usize = pages
        .iter()
        .map(|page| page.chars().filter(|c| !c.is_whitespace()).count())
        .sum();
    if pages.is_empty() || visible < MIN_CHARS_PER_PAGE * pages.len() {
        return Extraction::no_text("Нет текста: похоже на скан");
    }
    Extraction::ready(&pages.join("\n\n"))
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Tiny documents built in the tests, so no binary fixture is committed.

    use std::io::Write as _;

    /// A one-page PDF per entry of `pages`; each page shows its text in
    /// Helvetica, or only a filled rectangle and a 1×1 image (a scan) when
    /// the text is `None`.
    pub fn pdf(pages: &[Option<&str>]) -> Vec<u8> {
        // Objects: 1 catalog, 2 pages, 3 font, 4 image, then per page a page
        // and its content stream.
        let mut objects: Vec<String> = Vec::new();
        let kids: Vec<String> = (0..pages.len())
            .map(|index| format!("{} 0 R", 5 + index * 2))
            .collect();
        objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_owned());
        objects.push(format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        ));
        objects.push(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_owned(),
        );
        objects.push(
            "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray \
             /BitsPerComponent 8 /Length 1 >>\nstream\n\u{7f}\nendstream"
                .to_owned(),
        );
        for (index, page) in pages.iter().enumerate() {
            let content = match page {
                Some(text) => {
                    let escaped = text
                        .replace('\\', "\\\\")
                        .replace('(', "\\(")
                        .replace(')', "\\)");
                    format!("BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET")
                }
                None => "0.5 g 0 0 612 792 re f q 612 0 0 792 0 0 cm /Im1 Do Q".to_owned(),
            };
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R \
                 /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> >>",
                6 + index * 2
            ));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ));
        }
        let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            write!(out, "{} 0 obj\n{object}\nendobj\n", index + 1).unwrap();
        }
        let xref = out.len();
        write!(out, "xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).unwrap();
        for offset in offsets {
            writeln!(out, "{offset:010} 00000 n ").unwrap();
        }
        write!(
            out,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .unwrap();
        out
    }

    /// A DOCX whose body is `body` (the inside of `w:body`).
    pub fn docx(body: &str) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("[Content_Types].xml", options).unwrap();
            zip.write_all(
                br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            )
            .unwrap();
            zip.start_file("word/document.xml", options).unwrap();
            write!(
                zip,
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
            )
            .unwrap();
            zip.finish().unwrap();
        }
        out.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::{fixtures::*, *};

    fn ready_text(extraction: &Extraction) -> &str {
        assert_eq!(
            extraction.status,
            SourceStatus::Ready,
            "{:?}",
            extraction.error
        );
        &extraction.text
    }

    #[test]
    fn markdown_in_utf8() {
        let extraction = extract(
            FileKind::Markdown,
            "\u{feff}# ТЗ\r\n\r\nМедэлемент и Одесса\r\n".as_bytes(),
        );
        assert_eq!(ready_text(&extraction), "# ТЗ\n\nМедэлемент и Одесса");
        assert_eq!(
            extraction.text_chars as usize,
            extraction.text.chars().count()
        );
        assert!(!extraction.truncated);
        assert_eq!(extraction.error, None);
    }

    #[test]
    fn text_in_windows_1251() {
        let (bytes, _, unmappable) = encoding_rs::WINDOWS_1251.encode("Привет, Одесса! Счёт №5");
        assert!(!unmappable);
        assert!(std::str::from_utf8(&bytes).is_err());
        let extraction = extract(FileKind::Text, &bytes);
        assert_eq!(ready_text(&extraction), "Привет, Одесса! Счёт №5");
    }

    #[test]
    fn an_empty_text_file_has_no_text() {
        let extraction = extract(FileKind::Text, b"  \n\t ");
        assert_eq!(extraction.status, SourceStatus::NoText);
        assert_eq!(extraction.text, "");
    }

    #[test]
    fn docx_paragraphs_tabs_and_breaks() {
        let bytes = docx(
            r#"<w:p><w:r><w:t>Техническое</w:t></w:r><w:r><w:t xml:space="preserve"> задание</w:t></w:r></w:p>
<w:p><w:r><w:t>Модуль</w:t><w:tab/><w:t>Очередь &amp; звонки</w:t><w:br/><w:t>вторая строка</w:t></w:r></w:p>
<w:p/><w:p><w:r><w:t>Конец &#8212; всё</w:t></w:r></w:p><w:sectPr/>"#,
        );
        let extraction = extract(FileKind::Docx, &bytes);
        assert_eq!(
            ready_text(&extraction),
            "Техническое задание\nМодуль\tОчередь & звонки\nвторая строка\n\nКонец — всё"
        );
    }

    #[test]
    fn docx_without_a_document_fails() {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            zip.start_file("other.xml", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.finish().unwrap();
        }
        let extraction = extract(FileKind::Docx, &out.into_inner());
        assert_eq!(extraction.status, SourceStatus::Failed);
        assert!(
            extraction
                .error
                .as_deref()
                .unwrap()
                .contains("document.xml"),
            "{:?}",
            extraction.error
        );
    }

    #[test]
    fn pdf_with_text() {
        let bytes = pdf(&[
            Some("Project Telemedia: call queue for operators"),
            Some("Second page about the mobile application"),
        ]);
        let extraction = extract(FileKind::Pdf, &bytes);
        let text = ready_text(&extraction);
        assert!(text.contains("Telemedia"), "{text:?}");
        assert!(text.contains("mobile application"), "{text:?}");
    }

    #[test]
    fn image_only_pdf_has_no_text() {
        let extraction = extract(FileKind::Pdf, &pdf(&[None, None]));
        assert_eq!(extraction.status, SourceStatus::NoText);
        assert_eq!(
            extraction.error.as_deref(),
            Some("Нет текста: похоже на скан")
        );
        assert_eq!(extraction.text, "");
    }

    #[test]
    fn a_few_words_on_many_pages_is_a_scan_too() {
        let extraction = extract(FileKind::Pdf, &pdf(&[Some("Page 1"), None, None]));
        assert_eq!(extraction.status, SourceStatus::NoText);
    }

    #[test]
    fn broken_files_fail() {
        for kind in [FileKind::Pdf, FileKind::Docx] {
            let extraction = extract(kind, b"definitely not a document \x00\x01\x02");
            assert_eq!(extraction.status, SourceStatus::Failed, "{kind:?}");
            assert!(extraction.error.is_some());
            assert_eq!(extraction.text, "");
        }
        // A PDF cut in the middle.
        let whole = pdf(&[Some("Some text that is long enough to count")]);
        let extraction = extract(FileKind::Pdf, &whole[..whole.len() / 2]);
        assert_ne!(extraction.status, SourceStatus::Ready);
    }

    #[test]
    fn long_text_is_cut_at_the_limit() {
        let text = "я".repeat(MAX_TEXT_CHARS + 10);
        let extraction = extract(FileKind::Text, text.as_bytes());
        assert!(extraction.truncated);
        assert_eq!(extraction.text_chars as usize, MAX_TEXT_CHARS);
        assert_eq!(extraction.text.chars().count(), MAX_TEXT_CHARS);

        let exact = extract(FileKind::Text, "я".repeat(MAX_TEXT_CHARS).as_bytes());
        assert!(!exact.truncated);
    }

    #[test]
    fn extensions() {
        assert_eq!(FileKind::from_extension("DOCX"), Some(FileKind::Docx));
        assert_eq!(FileKind::from_extension("Md"), Some(FileKind::Markdown));
        assert_eq!(FileKind::from_extension("xlsx"), None);
        assert_eq!(FileKind::from_extension("doc"), None);
    }

    #[test]
    fn a_slow_or_dying_parser_fails_instead_of_hanging() {
        let slow = tauri::async_runtime::block_on(run_limited(Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_millis(300));
            Extraction::ready("поздно")
        }));
        assert_eq!(slow.status, SourceStatus::Failed);
        assert!(slow.error.unwrap().contains("дольше"));

        let fine = tauri::async_runtime::block_on(extract_in_background(
            FileKind::Text,
            b"ok text".to_vec(),
        ));
        assert_eq!(fine.text, "ok text");
    }

    #[test]
    fn a_panicking_parser_is_failed() {
        let extraction = guarded(|| panic!("a parser bug"));
        assert_eq!(extraction.status, SourceStatus::Failed);
        assert!(extraction.error.unwrap().contains("повреждён"));
    }
}
