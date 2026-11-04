//! Text of a project's document (projects-people-brief design.md,
//! decision 2):
//!
//! - `.md`, `.txt`: UTF-8, else Windows-1251;
//! - `.docx`: paragraphs (`w:p`) of `word/document.xml`, their text
//!   (`w:t`), tabs and line breaks; the XML is streamed from the archive,
//!   at most [`MAX_DOCX_XML_BYTES`] of it, and reading stops once the text
//!   passes [`MAX_TEXT_CHARS`];
//! - `.pdf`: `pdf-extract`; fewer than [`MIN_CHARS_PER_PAGE`] non-space
//!   characters a page on average is `no_text` (a scan).
//!
//! The text is cut at [`MAX_TEXT_CHARS`], and a document cut anywhere is
//! `truncated`. [`extract`] reads here and now; the app reads `.md` and
//! `.txt` on a blocking thread and PDF and DOCX in a child process with a
//! memory limit and a timeout ([`super::isolated`]), through
//! [`extract_file`]. A parser that panics gives `failed`.

use std::{
    io::{BufReader, Cursor, Read, Take},
    panic::{self, AssertUnwindSafe},
    path::Path,
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
/// How much of `word/document.xml` is read: about what [`MAX_TEXT_CHARS`]
/// of text take with Word's markup around them. The rest of a larger one
/// (a zip bomb, or a huge document) is not read, and the text is
/// `truncated`.
pub const MAX_DOCX_XML_BYTES: u64 = 32 * 1024 * 1024;

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

    /// Read by a parser of a binary format, in a child process.
    pub fn isolated(self) -> bool {
        matches!(self, Self::Pdf | Self::Docx)
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
    /// `text` as read; `cut` when only a part of the document was read.
    pub fn ready(text: String, cut: bool) -> Self {
        let text = normalize(text);
        if text.chars().all(char::is_whitespace) {
            return Self::no_text("В документе нет текста");
        }
        let (text, capped) = cap(text);
        let text_chars = u32::try_from(text.chars().count()).unwrap_or(u32::MAX);
        Self {
            status: SourceStatus::Ready,
            text,
            text_chars,
            truncated: cut || capped,
            error: None,
        }
    }

    pub fn no_text(reason: &str) -> Self {
        Self {
            status: SourceStatus::NoText,
            text: String::new(),
            text_chars: 0,
            truncated: false,
            error: Some(reason.to_owned()),
        }
    }

    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            status: SourceStatus::Failed,
            text: String::new(),
            text_chars: 0,
            truncated: false,
            error: Some(error.into()),
        }
    }
}

/// Unix line ends, no NULs, no blank edges, in one pass and in place when
/// there is nothing to replace: a large text is never copied more than
/// once.
fn normalize(mut text: String) -> String {
    if text.contains(['\r', '\u{c}', '\0']) {
        let mut out = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(char) = chars.next() {
            match char {
                '\r' => {
                    chars.next_if_eq(&'\n');
                    out.push('\n');
                }
                '\u{c}' => out.push('\n'),
                '\0' => {}
                other => out.push(other),
            }
        }
        text = out;
    }
    let end = text.trim_end().len();
    text.truncate(end);
    let start = text.len() - text.trim_start().len();
    text.drain(..start);
    text
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
        FileKind::Markdown | FileKind::Text => Extraction::ready(decode_text(bytes), false),
        FileKind::Docx => match docx_text(bytes, MAX_DOCX_XML_BYTES, MAX_TEXT_CHARS) {
            Ok((text, cut)) => Extraction::ready(text, cut),
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

/// Reads the document whose bytes are `bytes` and whose copy is at `copy`:
/// `.md` and `.txt` on a blocking thread, PDF and DOCX in a child process
/// (a memory limit, killed after [`EXTRACT_TIMEOUT`]).
pub async fn extract_file(kind: FileKind, bytes: Vec<u8>, copy: &Path) -> Extraction {
    if kind.isolated() {
        drop(bytes);
        super::isolated::extract(kind, copy).await
    } else {
        run_limited(EXTRACT_TIMEOUT, move || extract(kind, &bytes)).await
    }
}

/// Runs `job` on a blocking thread; `failed` when it takes longer than
/// `limit` or dies. Only for text files, which can't hang: the thread of a
/// late job is left to finish on its own.
pub async fn run_limited(
    limit: Duration,
    job: impl FnOnce() -> Extraction + Send + 'static,
) -> Extraction {
    let handle = tauri::async_runtime::spawn_blocking(job);
    match tokio::time::timeout(limit, handle).await {
        Ok(Ok(extraction)) => extraction,
        Ok(Err(error)) => Extraction::failed(format!("Не удалось прочитать файл: {error}")),
        Err(_) => too_slow(limit),
    }
}

pub fn too_slow(limit: Duration) -> Extraction {
    Extraction::failed(format!("Файл читается дольше {} с", limit.as_secs().max(1)))
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

/// The text of `word/document.xml`, a line per paragraph, streamed from the
/// archive: at most `max_xml` bytes of XML are read, and reading stops once
/// the text has more than `max_chars` characters. `true` when either cut
/// the document short.
/// The XML cap was reached: what was read is not the whole document.
fn xml_cut<R: Read>(reader: &quick_xml::Reader<BufReader<Take<R>>>) -> bool {
    reader.get_ref().get_ref().limit() == 0
}

fn docx_text(bytes: &[u8], max_xml: u64, max_chars: usize) -> Result<(String, bool), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let entry = archive
        .by_name("word/document.xml")
        .map_err(|_| "в архиве нет word/document.xml".to_owned())?;
    let mut reader = quick_xml::Reader::from_reader(BufReader::new(entry.take(max_xml)));
    let mut text = DocxText::new(max_chars);
    let mut buffer = Vec::new();
    loop {
        let event = match reader.read_event_into(&mut buffer) {
            Ok(event) => event,
            // The XML ends where the cap cut it.
            Err(_) if xml_cut(&reader) => return Ok((text.out, true)),
            Err(error) => return Err(error.to_string()),
        };
        if matches!(event, Event::Eof) {
            break;
        }
        text.on(event);
        if text.full() {
            return Ok((text.out, true));
        }
        buffer.clear();
    }
    let cut = xml_cut(&reader);
    Ok((text.out, cut))
}

/// The text of `word/document.xml` as its events come.
struct DocxText {
    out: String,
    chars: usize,
    max_chars: usize,
    in_text: bool,
}

impl DocxText {
    fn new(max_chars: usize) -> Self {
        Self {
            out: String::new(),
            chars: 0,
            max_chars,
            in_text: false,
        }
    }

    fn push(&mut self, text: &str) {
        self.chars += text.chars().count();
        self.out.push_str(text);
    }

    /// More than the cap: the rest is not needed.
    fn full(&self) -> bool {
        self.chars > self.max_chars
    }

    fn on(&mut self, event: Event<'_>) {
        match event {
            Event::Start(element) => match element.local_name().as_ref() {
                "t" => self.in_text = true,
                "tab" => self.push("\t"),
                "br" | "cr" => self.push("\n"),
                _ => {}
            },
            Event::Empty(element) => match element.local_name().as_ref() {
                "tab" => self.push("\t"),
                "br" | "cr" | "p" => self.push("\n"),
                _ => {}
            },
            Event::End(element) => match element.local_name().as_ref() {
                "t" => self.in_text = false,
                "p" => self.push("\n"),
                _ => {}
            },
            Event::Text(content) if self.in_text => self.push(&content.xml10_content()),
            Event::CData(content) if self.in_text => self.push(&content.into_inner()),
            Event::GeneralRef(reference) if self.in_text => {
                if let Ok(Some(character)) = reference.resolve_char_ref() {
                    self.push(character.encode_utf8(&mut [0; 4]));
                } else if let Some(entity) = resolve_predefined_entity(&reference.xml10_content()) {
                    self.push(entity);
                }
            }
            _ => {}
        }
    }
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
    Extraction::ready(pages.join("\n\n"), false)
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
    fn a_slow_text_read_fails_instead_of_hanging() {
        let slow = tauri::async_runtime::block_on(run_limited(Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_millis(300));
            Extraction::ready("поздно".to_owned(), false)
        }));
        assert_eq!(slow.status, SourceStatus::Failed);
        assert!(slow.error.unwrap().contains("дольше"));

        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("x.txt");
        std::fs::write(&copy, b"ok text").unwrap();
        let fine = tauri::async_runtime::block_on(extract_file(
            FileKind::Text,
            b"ok text".to_vec(),
            &copy,
        ));
        assert_eq!(fine.text, "ok text");
        // PDF and DOCX are read from the copy (here in-process: the unit
        // tests' binary has no reader mode).
        std::fs::write(&copy, docx("<w:p><w:r><w:t>из копии</w:t></w:r></w:p>")).unwrap();
        let isolated =
            tauri::async_runtime::block_on(extract_file(FileKind::Docx, Vec::new(), &copy));
        assert_eq!(isolated.text, "из копии");
    }

    #[test]
    fn normalize_takes_line_ends_nuls_and_edges_in_one_pass() {
        assert_eq!(
            normalize(" \r\n a\r\nb\rc\u{c}d\0e \n\t".to_owned()),
            "a\nb\nc\nde"
        );
        assert_eq!(normalize("\r\r\n".to_owned()), "");
        // Nothing to replace: the same buffer, trimmed in place.
        let text = String::from("  текст  ");
        let pointer = text.as_ptr();
        let normalized = normalize(text);
        assert_eq!(normalized, "текст");
        assert_eq!(normalized.as_ptr(), pointer);
    }

    /// A DOCX of `paragraphs` paragraphs `Абзац N` (about 40 bytes of XML
    /// each).
    fn long_docx(paragraphs: usize) -> Vec<u8> {
        let body: String = (0..paragraphs)
            .map(|index| format!("<w:p><w:r><w:t>Абзац {index}</w:t></w:r></w:p>"))
            .collect();
        docx(&body)
    }

    #[test]
    fn docx_reading_stops_at_the_text_cap() {
        let bytes = long_docx(2_000);
        let (text, cut) = docx_text(&bytes, MAX_DOCX_XML_BYTES, 100).unwrap();
        assert!(cut);
        // Stopped soon after the cap, not at the end of the document.
        assert!(text.chars().count() <= 120, "{}", text.chars().count());
        assert!(text.starts_with("Абзац 0\nАбзац 1\n"));
        let (whole, cut) = docx_text(&bytes, MAX_DOCX_XML_BYTES, MAX_TEXT_CHARS).unwrap();
        assert!(!cut);
        assert!(whole.contains("Абзац 1999"));

        // Past the cap the source says so.
        let bytes = long_docx(30_000);
        let extraction = extract(FileKind::Docx, &bytes);
        assert_eq!(extraction.status, SourceStatus::Ready);
        assert!(extraction.text_chars as usize <= MAX_TEXT_CHARS);
        assert!(extraction.truncated);
    }

    #[test]
    fn docx_xml_over_its_cap_is_read_up_to_it_and_truncated() {
        let bytes = long_docx(1_000);
        // The XML is cut in the middle of an element: what came is kept.
        let (text, cut) = docx_text(&bytes, 4_000, MAX_TEXT_CHARS).unwrap();
        assert!(cut);
        assert!(text.starts_with("Абзац 0\n"));
        assert!(!text.contains("Абзац 999"));
        // The whole XML within the cap is not cut.
        let (_, cut) = docx_text(&bytes, 10_000_000, MAX_TEXT_CHARS).unwrap();
        assert!(!cut);
        // A broken XML within the cap still fails.
        let broken = docx("<w:p><w:r><w:t>текст</w:x></w:p>");
        assert!(docx_text(&broken, MAX_DOCX_XML_BYTES, MAX_TEXT_CHARS).is_err());
    }

    #[test]
    fn a_panicking_parser_is_failed() {
        let extraction = guarded(|| panic!("a parser bug"));
        assert_eq!(extraction.status, SourceStatus::Failed);
        assert!(extraction.error.unwrap().contains("повреждён"));
    }
}
