//! Search over the calls (post-call design.md, decision 11;
//! `call-history`, "Поиск по звонкам"): a scan in Rust, no index, no
//! network.
//!
//! Text is compared as `fast_loop::evidence::normalize` gives it: lower
//! case, «ё» as «е», punctuation as spaces. The sources of a call are its
//! title, the segments of the shown pass of every recording, and the saved
//! summary's TL;DR, points and card facts. One match per source text (its
//! first occurrence), with up to [`SNIPPET_CHARS`] characters of the
//! original text on each side.

use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use super::{
    call_records::CallMoment,
    calls, recordings,
    summaries::{self, CallEvidence},
    transcript::{self, TranscriptChannel},
};
use crate::{agent::fast_loop::evidence::normalize, error::CommandResult};

/// At most this many matches come back.
pub const MAX_MATCHES: usize = 200;
/// Characters of the original text before and after a match.
pub const SNIPPET_CHARS: usize = 60;

/// Where a match is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchSource {
    /// The call's title.
    Title,
    /// A phrase of the transcript: «Вы» or «Клиент» (`channel`) at `at`.
    Segment,
    /// The summary's TL;DR.
    Tldr,
    /// A point of a topic of the summary.
    Point,
    /// A fact of a card of the summary.
    Fact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallSearchMatch {
    pub call_id: String,
    pub project_id: Option<String>,
    pub source: SearchSource,
    /// The original text before the match (up to 60 characters), the
    /// matched text and the text after it.
    pub before: String,
    pub text: String,
    pub after: String,
    /// Whose phrase, for a `segment`.
    pub channel: Option<TranscriptChannel>,
    /// The phrase to open: the segment itself, or the first quote of a
    /// point or a fact; `null` for the title, the TL;DR and a fact without
    /// a quote.
    pub moment: Option<CallMoment>,
    /// Wall-clock time of `moment`, milliseconds since the Unix epoch.
    pub at: Option<i64>,
}

/// Matches of the calls of a project (`null`: calls without one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMatches {
    pub project_id: Option<String>,
    /// Calls with at least one match.
    pub calls: u32,
    pub matches: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallSearch {
    /// Newest call first; within a call the title, the transcript in time
    /// order, then the summary. At most [`MAX_MATCHES`].
    pub matches: Vec<CallSearchMatch>,
    /// Every match of the searched calls, also those past the limit.
    pub total: u32,
    /// Per project, over every call whatever `projectId` was given (the
    /// counts of the history's sidebar); projects without a match are not
    /// listed.
    pub projects: Vec<ProjectMatches>,
}

/// A text in normal form, with the index of the original character each
/// of its characters comes from.
struct Normalized {
    chars: Vec<char>,
    origin: Vec<usize>,
}

/// As [`normalize`], keeping where each character came from.
fn normalized(text: &[char]) -> Normalized {
    let mut chars = Vec::with_capacity(text.len());
    let mut origin = Vec::with_capacity(text.len());
    let mut space = false;
    for (index, c) in text.iter().enumerate() {
        for lower in c.to_lowercase() {
            let mapped = match lower {
                'ё' => 'е',
                c if c.is_alphanumeric() => c,
                _ => ' ',
            };
            if mapped == ' ' {
                space = !chars.is_empty();
                continue;
            }
            if space {
                chars.push(' ');
                origin.push(index);
                space = false;
            }
            chars.push(mapped);
            origin.push(index);
        }
    }
    Normalized { chars, origin }
}

/// The first match of `query` (normal form, not empty) in `text`: the
/// snippet around it.
fn find(text: &str, query: &[char]) -> Option<(String, String, String)> {
    let original: Vec<char> = text.chars().collect();
    let normal = normalized(&original);
    let at = normal
        .chars
        .windows(query.len())
        .position(|window| window == query)?;
    let start = normal.origin[at];
    let end = normal.origin[at + query.len() - 1] + 1;
    let collect = |from: usize, to: usize| original[from..to].iter().collect::<String>();
    Some((
        collect(start.saturating_sub(SNIPPET_CHARS), start),
        collect(start, end),
        collect(end, (end + SNIPPET_CHARS).min(original.len())),
    ))
}

/// A source text of a call.
struct Source<'a> {
    source: SearchSource,
    text: &'a str,
    channel: Option<TranscriptChannel>,
    moment: Option<CallMoment>,
}

fn quote_moment(evidence: &[CallEvidence]) -> Option<CallMoment> {
    evidence.first().map(|quote| CallMoment {
        recording_id: quote.recording_id.clone(),
        segment_id: quote.segment_id.clone(),
        start_ms: quote.start_ms,
    })
}

/// The matches of one call, in the order of [`CallSearch::matches`].
fn search_call(
    connection: &Connection,
    call: &calls::Call,
    query: &[char],
) -> CommandResult<Vec<CallSearchMatch>> {
    let started: HashMap<String, i64> = recordings::for_call(connection, &call.id)?
        .into_iter()
        .map(|recording| (recording.id, recording.started_at))
        .collect();
    let segments = transcript::for_call(connection, &call.id)?;
    let content = summaries::get(connection, &call.id)?;
    let mut sources = vec![Source {
        source: SearchSource::Title,
        text: &call.title,
        channel: None,
        moment: None,
    }];
    sources.extend(segments.iter().map(|segment| Source {
        source: SearchSource::Segment,
        text: &segment.text,
        channel: Some(segment.channel),
        moment: Some(CallMoment {
            recording_id: segment.recording_id.clone(),
            segment_id: segment.id.clone(),
            start_ms: segment.start_ms,
        }),
    }));
    if let Some(summary) = &content
        && let Some(saved) = &summary.content
    {
        sources.push(Source {
            source: SearchSource::Tldr,
            text: &summary.tldr,
            channel: None,
            moment: None,
        });
        for point in saved.topics.iter().flat_map(|topic| &topic.points) {
            sources.push(Source {
                source: SearchSource::Point,
                text: &point.text,
                channel: None,
                moment: quote_moment(&point.evidence),
            });
        }
        let facts = saved
            .cards
            .iter()
            .flat_map(|card| &card.fields)
            .flat_map(|field| &field.facts);
        for fact in facts {
            sources.push(Source {
                source: SearchSource::Fact,
                text: &fact.text,
                channel: None,
                moment: quote_moment(&fact.evidence),
            });
        }
    }
    Ok(sources
        .into_iter()
        .filter_map(|source| {
            let (before, text, after) = find(source.text, query)?;
            let at = source.moment.as_ref().and_then(|moment| {
                started
                    .get(&moment.recording_id)
                    .map(|started| started + moment.start_ms)
            });
            Some(CallSearchMatch {
                call_id: call.id.clone(),
                project_id: call.project_id.clone(),
                source: source.source,
                before,
                text,
                after,
                channel: source.channel,
                moment: source.moment,
                at,
            })
        })
        .collect())
}

/// Searches every call, or the calls of `project_id`. A query without
/// letters or digits finds nothing.
pub fn search(
    connection: &Connection,
    query: &str,
    project_id: Option<&str>,
) -> CommandResult<CallSearch> {
    let query: Vec<char> = normalize(query).chars().collect();
    if query.is_empty() {
        return Ok(CallSearch::default());
    }
    let mut result = CallSearch::default();
    let mut projects: BTreeMap<Option<String>, ProjectMatches> = BTreeMap::new();
    for call in calls::list(connection, None)? {
        let found = search_call(connection, &call, &query)?;
        if found.is_empty() {
            continue;
        }
        let count = u32::try_from(found.len()).unwrap_or(u32::MAX);
        let counts = projects
            .entry(call.project_id.clone())
            .or_insert_with(|| ProjectMatches {
                project_id: call.project_id.clone(),
                calls: 0,
                matches: 0,
            });
        counts.calls += 1;
        counts.matches = counts.matches.saturating_add(count);
        if project_id.is_some_and(|wanted| call.project_id.as_deref() != Some(wanted)) {
            continue;
        }
        result.total = result.total.saturating_add(count);
        let room = MAX_MATCHES - result.matches.len();
        result.matches.extend(found.into_iter().take(room));
    }
    result.projects = projects.into_values().collect();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{
        call_records::testing::*,
        open_in_memory,
        transcript::TranscriptChannel::{Me, Others},
    };

    const DAY: i64 = 86_400_000;
    const CALL_AT: i64 = 1_793_880_000_000;

    #[test]
    fn the_normal_form_keeps_where_each_character_came_from() {
        for text in [
            "  Ёлка, ПЛАНФИКС!  ",
            "USD МІКС — касса (2 шт.)",
            "İstanbul ǅ",
            "",
            "...",
        ] {
            let chars: Vec<char> = text.chars().collect();
            let normal = normalized(&chars);
            assert_eq!(normal.chars.iter().collect::<String>(), normalize(text));
            assert_eq!(normal.chars.len(), normal.origin.len());
        }
        assert_eq!(
            find("Мы ведём Планфикс, а не CRM", &['е', 'д', 'е', 'м']),
            Some((
                "Мы в".to_owned(),
                "едём".to_owned(),
                " Планфикс, а не CRM".to_owned()
            ))
        );
    }

    /// `call-details`, "Поиск в расшифровке", and `call-history`: without
    /// case and «ё», across words and punctuation.
    #[test]
    fn search_ignores_case_and_yo() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Обменник");
        let call = call(&connection, Some(&acme), "Касса", CALL_AT);
        let recording = recording(&connection, &call, CALL_AT);
        live(
            &connection,
            &recording,
            Others,
            5_000,
            "Мы всё ведём в Планфиксе, да.",
        );
        live(&connection, &recording, Me, 1_000, "А где ведёте задачи?");

        for query in [
            "планфикс",
            "ПЛАНФИКС",
            "ведем в планфиксе",
            "  ведём, в   планфиксе!",
        ] {
            let found = search(&connection, query, None).unwrap();
            assert_eq!(found.matches.len(), 1, "{query}");
            let hit = &found.matches[0];
            assert_eq!(hit.source, SearchSource::Segment);
            assert_eq!(hit.channel, Some(Others));
            assert_eq!(hit.at, Some(CALL_AT + 5_000));
        }
        let hit = &search(&connection, "планфикс", None).unwrap().matches[0];
        assert_eq!(
            (hit.before.as_str(), hit.text.as_str(), hit.after.as_str()),
            ("Мы всё ведём в ", "Планфикс", "е, да.")
        );
        assert!(
            search(&connection, " ,. ", None)
                .unwrap()
                .matches
                .is_empty()
        );
        assert!(
            search(&connection, "битрикс", None)
                .unwrap()
                .matches
                .is_empty()
        );
    }

    /// `call-history`, "Найти термин": the transcript of the shown pass,
    /// the title and the summary, with the moment to open.
    #[test]
    fn a_term_is_found_in_the_transcript_and_the_summary() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Обменник");
        let globex = project(&connection, "Глобекс");
        let older = call(&connection, Some(&acme), "Бронь курса", CALL_AT - DAY);
        let newer = call(&connection, Some(&acme), "Касса", CALL_AT);
        let elsewhere = call(&connection, Some(&globex), "Другое", CALL_AT);
        let loose = call(&connection, None, "Без проекта", CALL_AT);

        let first = recording(&connection, &newer, CALL_AT);
        live(&connection, &first, Others, 3_000, "живая бронь");
        let shown = refined(
            &connection,
            &first,
            vec![input(Others, 3_200, "Клиент делает бронь по телефону")],
        );
        summary(
            &connection,
            &newer,
            "Бронь держим час.",
            "Бронь по телефону",
            "Без брони",
            &shown[0],
        );
        let other = recording(&connection, &elsewhere, CALL_AT);
        live(&connection, &other, Others, 1_000, "бронь");
        let free = recording(&connection, &loose, CALL_AT);
        live(&connection, &free, Me, 1_000, "А бронь?");

        let found = search(&connection, "бронь", Some(&acme)).unwrap();
        let sources: Vec<(&str, SearchSource)> = found
            .matches
            .iter()
            .map(|hit| (hit.call_id.as_str(), hit.source))
            .collect();
        assert_eq!(
            sources,
            [
                (newer.as_str(), SearchSource::Segment),
                (newer.as_str(), SearchSource::Tldr),
                (newer.as_str(), SearchSource::Point),
                (older.as_str(), SearchSource::Title),
            ],
            "the refined pass only; «брони» is not «бронь»"
        );
        let segment = &found.matches[0];
        assert_eq!(
            segment.moment,
            Some(CallMoment {
                recording_id: first.clone(),
                segment_id: shown[0].id.clone(),
                start_ms: 3_200,
            })
        );
        let point = &found.matches[2];
        assert_eq!(point.moment, segment.moment);
        assert_eq!(point.at, Some(CALL_AT + 3_200));
        assert_eq!(found.matches[1].moment, None);
        assert_eq!(found.total, 4);

        let mut projects = found.projects.clone();
        projects.sort_by_key(|counts| counts.matches);
        assert_eq!(
            projects,
            [
                ProjectMatches {
                    project_id: None,
                    calls: 1,
                    matches: 1,
                },
                ProjectMatches {
                    project_id: Some(globex.clone()),
                    calls: 1,
                    matches: 1,
                },
                ProjectMatches {
                    project_id: Some(acme.clone()),
                    calls: 2,
                    matches: 4,
                },
            ]
        );
        assert_eq!(search(&connection, "бронь", None).unwrap().matches.len(), 6);
    }

    #[test]
    fn at_most_two_hundred_matches_come_back() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Обменник");
        let call = call(&connection, Some(&acme), "Касса", CALL_AT);
        let recording = recording(&connection, &call, CALL_AT);
        for n in 0..250 {
            live(
                &connection,
                &recording,
                Others,
                n * 100,
                &format!("фраза {n} про кассу"),
            );
        }
        let long = "слово ".repeat(40);
        live(
            &connection,
            &recording,
            Me,
            30_000,
            &format!("{long}касса{long}"),
        );

        let found = search(&connection, "касс", None).unwrap();
        assert_eq!(found.matches.len(), MAX_MATCHES);
        assert_eq!(found.total, 252, "the title, 250 phrases and the long one");
        assert_eq!(found.projects[0].matches, 252);

        let long_hit = search(&connection, "слово касса", None).unwrap().matches;
        assert_eq!(long_hit.len(), 1);
        assert_eq!(long_hit[0].before.chars().count(), SNIPPET_CHARS);
        assert_eq!(long_hit[0].after.chars().count(), SNIPPET_CHARS);
    }
}
