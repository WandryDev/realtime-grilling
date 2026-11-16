//! The search of the slow loop (agent-slow-loop design.md, decision 2): an
//! in-memory BM25 index over the texts of the project's sources as they
//! were when the recording started.
//!
//! - **Chunks.** A text is cut on blank lines and Markdown headings into
//!   chunks of [`MIN_CHUNK`]–[`MAX_CHUNK`] characters, each with the path of
//!   the headings it is under. A ClickUp task is a heading, its description
//!   and its section «Комментарии», so it is cut by those sections. A chunk
//!   is `<source id>#<n>`.
//! - **Tokens.** Lower case letters and digits (`ё` as `е`); Cyrillic words
//!   go through Snowball Russian, Latin ones through Snowball English;
//!   numbers stay as they are; words shorter than two letters and a short
//!   list of stop words are dropped.
//! - **Ranking.** BM25 ([`K1`], [`B`]) per query, the lists fused by
//!   Reciprocal Rank Fusion ([`RRF_K`]); the best [`TOP`] chunks, at most
//!   [`PER_SOURCE`] of one source.

use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

use rust_stemmers::{Algorithm, Stemmer};

use crate::storage::{context_findings::FindingSourceKind, sources::SearchableSource};

/// A chunk grows to at least this many characters when its section has
/// them…
pub const MIN_CHUNK: usize = 300;
/// … and never past this many.
pub const MAX_CHUNK: usize = 1_200;
/// Candidates of one call at most.
pub const TOP: usize = 12;
/// Candidates of one source at most.
pub const PER_SOURCE: usize = 3;
pub const K1: f64 = 1.2;
pub const B: f64 = 0.75;
pub const RRF_K: f64 = 60.0;

/// Between the headings of a chunk's path, and between the source and the
/// path in the agent's message.
pub const PATH_SEPARATOR: &str = " › ";

/// Words that say nothing about a document.
const STOP_WORDS: [&str; 64] = [
    "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то", "все", "она", "так",
    "его", "но", "да", "ты", "к", "у", "же", "вы", "за", "бы", "по", "ее", "мне", "от", "меня",
    "еще", "нет", "о", "из", "ну", "ли", "если", "уже", "или", "ни", "до", "вот", "это", "мы",
    "для", "их", "при", "об", "про", "этот", "эта", "эти", "там", "тут", "the", "and", "of", "to",
    "in", "is", "for", "on", "with",
];

static RUSSIAN: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Russian));
static ENGLISH: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::English));
static STOPS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| STOP_WORDS.into_iter().collect());

/// The words of `text`: lower case runs of letters and digits, `ё` as `е`.
fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    let mut chars = text.chars();
    std::iter::from_fn(move || {
        let mut word = String::new();
        for original in chars.by_ref() {
            let mut kept = false;
            for lower in original.to_lowercase() {
                let lower = if lower == 'ё' { 'е' } else { lower };
                if lower.is_alphanumeric() {
                    word.push(lower);
                    kept = true;
                }
            }
            if !kept && !word.is_empty() {
                return Some(word);
            }
        }
        (!word.is_empty()).then_some(word)
    })
}

fn is_cyrillic(c: char) -> bool {
    ('\u{0400}'..='\u{04FF}').contains(&c)
}

/// The term of a word, `None` when it is dropped.
fn term(word: &str) -> Option<String> {
    if word.chars().all(|c| c.is_ascii_digit()) {
        return Some(word.to_owned());
    }
    if word.chars().count() < 2 || STOPS.contains(word) {
        return None;
    }
    if word.chars().any(|c| c.is_ascii_digit()) {
        return Some(word.to_owned());
    }
    if word.chars().all(is_cyrillic) {
        return Some(RUSSIAN.stem(word).into_owned());
    }
    if word.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(ENGLISH.stem(word).into_owned());
    }
    Some(word.to_owned())
}

/// The terms of `text`, in order, repeats kept.
pub fn terms(text: &str) -> Vec<String> {
    words(text).filter_map(|word| term(&word)).collect()
}

/// [`terms`] through a cache of the words already seen: a big text repeats
/// its words.
fn terms_cached(text: &str, cache: &mut HashMap<String, Option<String>>) -> Vec<String> {
    let mut found = Vec::new();
    for word in words(text) {
        let known = match cache.get(&word) {
            Some(known) => known.clone(),
            None => {
                let made = term(&word);
                cache.insert(word, made.clone());
                made
            }
        };
        found.extend(known);
    }
    found
}

/* Chunks */

/// A Markdown heading: its level and title.
fn heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.starts_with(' ') && !rest.is_empty() {
        return None;
    }
    let title = rest.trim().trim_end_matches('#').trim().to_owned();
    Some((level, title))
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// The first `max` characters of `text`.
pub fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// `text` cut to pieces of at most `max` characters: by lines, then by
/// sentences, then at spaces (or anywhere, for a word that long).
fn pieces(text: &str, max: usize) -> Vec<String> {
    if char_len(text) <= max {
        return vec![text.to_owned()];
    }
    let mut parts: Vec<String> = Vec::new();
    for line in text.lines() {
        if char_len(line) <= max {
            parts.push(line.to_owned());
            continue;
        }
        let mut sentence = String::new();
        for c in line.chars() {
            sentence.push(c);
            if matches!(c, '.' | '!' | '?' | ';') {
                parts.push(std::mem::take(&mut sentence));
            }
        }
        if !sentence.is_empty() {
            parts.push(sentence);
        }
    }
    let mut cut: Vec<String> = Vec::new();
    for part in parts {
        let mut rest = part.trim().to_owned();
        while char_len(&rest) > max {
            let head = truncate(&rest, max);
            let at = head
                .rfind(char::is_whitespace)
                .filter(|at| *at > 0)
                .unwrap_or(head.len());
            cut.push(rest[..at].trim().to_owned());
            rest = rest[at..].trim().to_owned();
        }
        if !rest.is_empty() {
            cut.push(rest);
        }
    }
    // Lines and sentences packed back up to `max`.
    let mut packed: Vec<String> = Vec::new();
    for part in cut {
        match packed.last_mut() {
            Some(last) if char_len(last) + 1 + char_len(&part) <= max => {
                last.push('\n');
                last.push_str(&part);
            }
            _ => packed.push(part),
        }
    }
    packed
}

/// The blocks of one section (one heading path), packed into chunks.
fn pack(blocks: &[String]) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for block in blocks {
        for piece in pieces(block, MAX_CHUNK) {
            if !current.is_empty() && char_len(&current) + 2 + char_len(&piece) > MAX_CHUNK {
                chunks.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(&piece);
            if char_len(&current) >= MIN_CHUNK {
                chunks.push(std::mem::take(&mut current));
            }
        }
    }
    if !current.is_empty() {
        // A short tail joins the chunk before it when it fits.
        match chunks.last_mut() {
            Some(last) if char_len(last) + 2 + char_len(&current) <= MAX_CHUNK => {
                last.push_str("\n\n");
                last.push_str(&current);
            }
            _ => chunks.push(current),
        }
    }
    chunks
}

/// The chunks of a text with the heading path of each.
pub fn chunk(text: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    let mut path: Vec<(usize, String)> = Vec::new();
    let mut blocks: Vec<String> = Vec::new();
    let mut block = String::new();
    let flush_block = |block: &mut String, blocks: &mut Vec<String>| {
        let text = block.trim();
        if !text.is_empty() {
            blocks.push(text.to_owned());
        }
        block.clear();
    };
    let flush_section =
        |blocks: &mut Vec<String>, path: &[(usize, String)], found: &mut Vec<(String, String)>| {
            let names: Vec<&str> = path
                .iter()
                .map(|(_, title)| title.as_str())
                .filter(|title| !title.is_empty())
                .collect();
            let joined = names.join(PATH_SEPARATOR);
            for text in pack(blocks) {
                found.push((joined.clone(), text));
            }
            blocks.clear();
        };
    for line in text.lines() {
        if let Some((level, title)) = heading(line) {
            flush_block(&mut block, &mut blocks);
            flush_section(&mut blocks, &path, &mut found);
            path.retain(|(known, _)| *known < level);
            path.push((level, title));
        } else if line.trim().is_empty() {
            flush_block(&mut block, &mut blocks);
        } else {
            if !block.is_empty() {
                block.push('\n');
            }
            block.push_str(line.trim_end());
        }
    }
    flush_block(&mut block, &mut blocks);
    flush_section(&mut blocks, &path, &mut found);
    found
}

/* The index */

/// A source of the index: what a finding keeps of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexSource {
    pub id: String,
    pub name: String,
    pub kind: FindingSourceKind,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Chunk {
    key: String,
    source: usize,
    path: String,
    text: String,
}

/// A chunk found for a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// `<source id>#<n>`.
    pub key: String,
    pub source: IndexSource,
    /// The headings it is under, joined by [`PATH_SEPARATOR`]; may be empty.
    pub path: String,
    /// At most [`MAX_CHUNK`] characters.
    pub text: String,
}

/// The BM25 index of a recording's sources.
#[derive(Debug, Default)]
pub struct Index {
    sources: Vec<IndexSource>,
    chunks: Vec<Chunk>,
    lengths: Vec<u32>,
    average: f64,
    /// By term: the chunks that have it and how often.
    postings: HashMap<String, Vec<(u32, u32)>>,
}

impl Index {
    /// The index of `sources`: their chunks (with the heading path, so a
    /// heading's words find its chunks) and their terms.
    pub fn build(sources: Vec<SearchableSource>) -> Self {
        let mut index = Self::default();
        let mut cache: HashMap<String, Option<String>> = HashMap::new();
        let mut total: u64 = 0;
        for (source_index, source) in sources.into_iter().enumerate() {
            for (n, (path, text)) in chunk(&source.text).into_iter().enumerate() {
                let chunk_index = u32::try_from(index.chunks.len()).unwrap_or(u32::MAX);
                let mut counts: HashMap<String, u32> = HashMap::new();
                let mut length: u32 = 0;
                for term in terms_cached(&path, &mut cache)
                    .into_iter()
                    .chain(terms_cached(&text, &mut cache))
                {
                    *counts.entry(term).or_default() += 1;
                    length += 1;
                }
                for (term, count) in counts {
                    index
                        .postings
                        .entry(term)
                        .or_default()
                        .push((chunk_index, count));
                }
                total += u64::from(length);
                index.lengths.push(length);
                index.chunks.push(Chunk {
                    key: format!("{}#{n}", source.id),
                    source: source_index,
                    path,
                    text,
                });
            }
            index.sources.push(IndexSource {
                id: source.id,
                name: source.name,
                kind: source.kind,
                url: source.url,
            });
        }
        if !index.chunks.is_empty() {
            index.average = total as f64 / index.chunks.len() as f64;
        }
        index
    }

    /// No chunk to search: the project had no ready source with text.
    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    #[cfg(test)]
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// The chunks of one query by BM25, the best first; only those that
    /// share a term with it.
    fn rank(&self, query: &str) -> Vec<usize> {
        let mut seen = HashSet::new();
        let query_terms: Vec<String> = terms(query)
            .into_iter()
            .filter(|term| seen.insert(term.clone()))
            .collect();
        let count = self.chunks.len() as f64;
        let mut scores: HashMap<usize, f64> = HashMap::new();
        for term in &query_terms {
            let Some(postings) = self.postings.get(term) else {
                continue;
            };
            let frequency = postings.len() as f64;
            let idf = (1.0 + (count - frequency + 0.5) / (frequency + 0.5)).ln();
            for &(chunk, tf) in postings {
                let chunk = chunk as usize;
                let tf = f64::from(tf);
                let norm = 1.0 - B + B * f64::from(self.lengths[chunk]) / self.average.max(1.0);
                *scores.entry(chunk).or_default() += idf * tf * (K1 + 1.0) / (tf + K1 * norm);
            }
        }
        let mut ranked: Vec<(usize, f64)> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.into_iter().map(|(chunk, _)| chunk).collect()
    }

    /// The candidates of `queries`: each ranked by BM25, the lists fused by
    /// RRF; the best [`TOP`], at most [`PER_SOURCE`] of a source. Blank
    /// queries or no shared term: none.
    pub fn search(&self, queries: &[String]) -> Vec<Candidate> {
        let mut fused: HashMap<usize, f64> = HashMap::new();
        for query in queries {
            for (rank, chunk) in self.rank(query).into_iter().enumerate() {
                *fused.entry(chunk).or_default() += 1.0 / (RRF_K + (rank + 1) as f64);
            }
        }
        let mut ranked: Vec<(usize, f64)> = fused.into_iter().collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        let mut per_source: HashMap<usize, usize> = HashMap::new();
        let mut found = Vec::new();
        for (chunk_index, _) in ranked {
            let chunk = &self.chunks[chunk_index];
            let taken = per_source.entry(chunk.source).or_default();
            if *taken >= PER_SOURCE {
                continue;
            }
            *taken += 1;
            found.push(Candidate {
                key: chunk.key.clone(),
                source: self.sources[chunk.source].clone(),
                path: chunk.path.clone(),
                text: truncate(&chunk.text, MAX_CHUNK).to_owned(),
            });
            if found.len() == TOP {
                break;
            }
        }
        found
    }
}

#[cfg(test)]
mod tests;
