//! The app binary's hidden reader mode, `--extract-text <path> <ext>`
//! (projects-people-brief design.md, decision 2): the process the app runs
//! to read a PDF or DOCX with a memory limit and a timeout. It prints one
//! line of JSON last and exits.

use std::{io::Write as _, path::Path, process::Command};

use serde_json::Value;

const APP: &str = env!("CARGO_BIN_EXE_realtime-grilling");

/// Runs the reader and returns its exit code and the last line it printed.
fn read(path: &Path, extension: &str) -> (Option<i32>, Value) {
    let output = Command::new(APP)
        .arg("--extract-text")
        .arg(path)
        .arg(extension)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    let reply = serde_json::from_str(last).unwrap_or(Value::Null);
    (output.status.code(), reply)
}

fn docx(body: &str) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("word/document.xml", options).unwrap();
    write!(
        zip,
        r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
    )
    .unwrap();
    zip.finish().unwrap();
    out.into_inner()
}

/// A one-page PDF that shows `text` in Helvetica.
fn pdf(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
         /Resources << /Font << /F1 5 0 R >> >> >>"
            .to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    ];
    let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
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

#[test]
fn the_app_binary_reads_a_docx_and_a_pdf_in_its_reader_mode() {
    let dir = tempfile::tempdir().unwrap();
    let document = dir.path().join("ТЗ клиента.docx");
    std::fs::write(
        &document,
        docx("<w:p><w:r><w:t>Очередь звонков</w:t></w:r></w:p><w:p><w:r><w:t>Медэлемент</w:t></w:r></w:p>"),
    )
    .unwrap();
    let (code, reply) = read(&document, "docx");
    assert_eq!(code, Some(0));
    assert_eq!(reply["status"], "ready", "{reply}");
    assert_eq!(reply["text"], "Очередь звонков\nМедэлемент");
    assert_eq!(reply["truncated"], false);
    assert_eq!(reply["error"], Value::Null);

    let document = dir.path().join("Договор.pdf");
    std::fs::write(
        &document,
        pdf("Project Telemedia: call queue for operators"),
    )
    .unwrap();
    let (code, reply) = read(&document, "pdf");
    assert_eq!(code, Some(0));
    assert_eq!(reply["status"], "ready", "{reply}");
    assert!(
        reply["text"].as_str().unwrap().contains("Telemedia"),
        "{reply}"
    );
}

#[test]
fn a_broken_or_missing_file_is_a_failed_reply_and_bad_arguments_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let broken = dir.path().join("битый.pdf");
    std::fs::write(&broken, b"definitely not a document").unwrap();
    let (code, reply) = read(&broken, "pdf");
    assert_eq!(code, Some(0));
    assert_eq!(reply["status"], "failed", "{reply}");
    assert!(reply["error"].as_str().is_some());

    let (code, reply) = read(&dir.path().join("нет.docx"), "docx");
    assert_eq!(code, Some(0));
    assert_eq!(reply["status"], "failed", "{reply}");

    let (code, reply) = read(&broken, "xlsx");
    assert_eq!(code, Some(2));
    assert_eq!(reply, Value::Null);
}
