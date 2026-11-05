use serde_json::json;

use super::*;
use crate::{
    projects::brief_inputs,
    storage::{
        calls::{CallCreate, CallStatus},
        open_in_memory,
        people::PersonCreate,
        projects::{BriefState, ProjectCreate},
        proposals::{NewProposal, ProposalKind, insert, list},
        summaries::CallEvidence,
    },
};

/// 5 November 2026, 12:00 UTC: the same date in every time zone but the
/// farthest ones.
const CALL_AT: i64 = 1_793_880_000_000;

struct Fixture {
    connection: Connection,
    project: String,
    person: String,
    call: String,
}

fn fixture() -> Fixture {
    let connection = open_in_memory().unwrap();
    let project = projects::create(
        &connection,
        ProjectCreate {
            name: "Обменник".to_owned(),
            notes: Some("Клиент любит конкретику.".to_owned()),
            ..ProjectCreate::default()
        },
    )
    .unwrap()
    .0
    .id;
    let person = people::create(
        &connection,
        PersonCreate {
            project_id: project.clone(),
            name: "Игорь".to_owned(),
            role: Some("CTO".to_owned()),
            profile: Some(json!({
                "tech": 3,
                "howToAsk": "через деньги",
                "portrait": { "Темперамент": "спокойный" },
                "initials": "И"
            })),
        },
    )
    .unwrap()
    .0
    .id;
    let call = calls::create(
        &connection,
        CallCreate {
            project_id: Some(project.clone()),
            status: Some(CallStatus::Finished),
            started_at: Some(CALL_AT),
            ended_at: Some(CALL_AT + 60_000),
            participant_ids: Some(vec![person.clone()]),
            ..CallCreate::default()
        },
    )
    .unwrap()
    .0
    .id;
    Fixture {
        connection,
        project,
        person,
        call,
    }
}

impl Fixture {
    fn propose(&self, target: ProposalTarget, field: &str, after: &str) -> Proposal {
        let new = NewProposal {
            target,
            person_id: (target == ProposalTarget::Person).then(|| self.person.clone()),
            field: field.to_owned(),
            before: None,
            after: after.to_owned(),
            kind: ProposalKind::Said,
            evidence: vec![CallEvidence {
                recording_id: "r".to_owned(),
                segment_id: "s".to_owned(),
                start_ms: 1_000,
                quote: "пишу на Rust каждый день".to_owned(),
            }],
        };
        insert(&self.connection, &self.call, &new).unwrap()
    }

    /// As `Storage::write`: everything or nothing.
    fn write<T>(
        &self,
        work: impl FnOnce(&Connection) -> CommandResult<(T, Vec<DataChanged>)>,
    ) -> CommandResult<(T, Vec<DataChanged>)> {
        let transaction = self.connection.unchecked_transaction().unwrap();
        let output = work(&transaction)?;
        transaction.commit().unwrap();
        Ok(output)
    }

    fn accept(&self, id: &str, edited: Option<&str>) -> CommandResult<Proposal> {
        let input = ProposalDecide {
            decision: ProposalDecision::Accepted,
            edited: edited.map(str::to_owned),
        };
        self.write(|db| decide(db, id, &input)).map(|(p, _)| p)
    }

    fn reject(&self, id: &str) -> Proposal {
        let input = ProposalDecide {
            decision: ProposalDecision::Rejected,
            edited: None,
        };
        self.write(|db| decide(db, id, &input)).unwrap().0
    }

    fn undo(&self, id: &str) -> CommandResult<Proposal> {
        self.write(|db| undo(db, id)).map(|(p, _)| p)
    }

    fn person(&self) -> people::Person {
        people::get(&self.connection, &self.person).unwrap()
    }

    fn notes(&self) -> String {
        projects::get(&self.connection, &self.project)
            .unwrap()
            .notes
    }

    fn brief_state(&self) -> BriefState {
        projects::get(&self.connection, &self.project)
            .unwrap()
            .brief_state
    }

    /// A brief the agent built from the current inputs: `fresh`.
    fn fresh_brief(&self) {
        let fingerprint = brief_inputs::fingerprint(&self.connection, &self.project).unwrap();
        projects::save_brief(
            &self.connection,
            &self.project,
            &json!({ "product": "Обменник" }),
            &fingerprint,
            false,
        )
        .unwrap();
        assert_eq!(self.brief_state(), BriefState::Fresh);
    }
}

fn invalid<T: std::fmt::Debug>(result: CommandResult<T>) -> String {
    match result {
        Err(CommandError::Invalid { message }) => message,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

fn line(text: &str) -> String {
    notes_line(&local_date(CALL_AT), text)
}

/// `knowledge-proposals`, "Принять по профилю".
#[test]
fn accepting_a_profile_proposal_changes_the_field() {
    let fx = fixture();
    fx.fresh_brief();
    let proposal = fx.propose(ProposalTarget::Person, "tech", "4");

    let input = ProposalDecide {
        decision: ProposalDecision::Accepted,
        edited: None,
    };
    let (accepted, events) = fx.write(|db| decide(db, &proposal.id, &input)).unwrap();
    assert_eq!(accepted.decision, ProposalDecision::Accepted);
    assert!(accepted.decided_at.is_some());
    assert_eq!(
        accepted.applied,
        Some(ProposalApplied {
            written: json!(4),
            previous: Some(json!(3)),
        })
    );
    let person = fx.person();
    assert_eq!(person.profile["tech"], json!(4));
    // The rest of the profile stays.
    assert_eq!(person.profile["howToAsk"], json!("через деньги"));
    assert_eq!(person.profile["initials"], json!("И"));
    let kinds: Vec<(Entity, &str)> = events
        .iter()
        .map(|event| (event.entity, event.id.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            (Entity::Person, fx.person.as_str()),
            (Entity::Project, fx.project.as_str()),
            (Entity::Call, fx.call.as_str()),
        ]
    );
    // People are in the brief's fingerprint.
    assert_eq!(fx.brief_state(), BriefState::Outdated);
}

#[test]
fn every_profile_field_is_written_where_it_lives() {
    let fx = fixture();
    let role = fx.propose(ProposalTarget::Person, "role", "Владелец бизнеса");
    let portrait = fx.propose(
        ProposalTarget::Person,
        "portrait:Темперамент",
        "вспыльчивый",
    );
    let new_label = fx.propose(ProposalTarget::Person, "portrait:Характер", "упрямый");
    let how = fx.propose(ProposalTarget::Person, "howToAsk", "коротко");
    let project = fx.propose(ProposalTarget::Person, "project", "2");
    let notes = fx.propose(ProposalTarget::Person, "notes", "черновик");

    for id in [&role.id, &portrait.id, &new_label.id, &how.id, &project.id] {
        fx.accept(id, None).unwrap();
    }
    // "Изменить и принять": the manager's text, trimmed.
    let edited = fx.accept(&notes.id, Some("  Любит схемы  ")).unwrap();
    assert_eq!(edited.edited.as_deref(), Some("Любит схемы"));

    let person = fx.person();
    assert_eq!(person.role, "Владелец бизнеса");
    assert_eq!(
        person.profile["portrait"]["Темперамент"],
        json!("вспыльчивый")
    );
    assert_eq!(person.profile["portrait"]["Характер"], json!("упрямый"));
    assert_eq!(person.profile["howToAsk"], json!("коротко"));
    assert_eq!(person.profile["project"], json!(2));
    assert_eq!(person.profile["notes"], json!("Любит схемы"));
    let applied = list(&fx.connection, &fx.call).unwrap();
    assert_eq!(
        applied[0].applied.as_ref().unwrap().previous,
        Some(json!("CTO"))
    );
    assert_eq!(applied[2].applied.as_ref().unwrap().previous, None);
}

#[test]
fn a_level_is_a_number_from_one_to_five() {
    let fx = fixture();
    for after in ["0", "6", "четыре", "4 из 5"] {
        let proposal = fx.propose(ProposalTarget::Person, "tech", after);
        let message = invalid(fx.accept(&proposal.id, None));
        assert!(message.contains("от 1 до 5"), "{message}");
        let stored = get(&fx.connection, &proposal.id).unwrap();
        assert_eq!(stored.decision, ProposalDecision::Pending);
    }
    let unknown = fx.propose(ProposalTarget::Person, "mood", "весёлый");
    invalid(fx.accept(&unknown.id, None));
    let blank = fx.propose(ProposalTarget::Person, "portrait: ", "x");
    invalid(fx.accept(&blank.id, None));
    assert_eq!(fx.person().profile["tech"], json!(3));
}

/// `knowledge-proposals`, "Принять по брифу".
#[test]
fn accepting_a_brief_proposal_adds_a_line_to_the_notes() {
    let fx = fixture();
    fx.fresh_brief();
    let term = fx.propose(
        ProposalTarget::Brief,
        "glossary",
        "USD МІКС — смешанная касса\nв долларах",
    );
    let stack = fx.propose(ProposalTarget::Brief, "stack", "Laravel");

    let accepted = fx.accept(&term.id, None).unwrap();
    let first = line("USD МІКС — смешанная касса в долларах");
    let date = local_date(CALL_AT);
    assert!(date.ends_with(".11.2026") && date.len() == 10, "{date}");
    assert_eq!(
        first,
        format!("- {date}: USD МІКС — смешанная касса в долларах")
    );
    assert_eq!(
        fx.notes(),
        format!("Клиент любит конкретику.\n\n{NOTES_SECTION}\n{first}")
    );
    assert_eq!(
        accepted.applied,
        Some(ProposalApplied {
            written: Value::String(first.clone()),
            previous: None,
        })
    );
    // The notes are in the brief's fingerprint: "мог устареть".
    assert_eq!(fx.brief_state(), BriefState::Outdated);

    fx.accept(&stack.id, None).unwrap();
    assert_eq!(
        fx.notes(),
        format!(
            "Клиент любит конкретику.\n\n{NOTES_SECTION}\n{first}\n{}",
            line("Laravel")
        )
    );
}

#[test]
fn the_line_goes_to_the_end_of_an_existing_section() {
    let notes = format!("# Заметки\n{NOTES_SECTION}\n- старое\n\n## Другое\nтекст");
    assert_eq!(
        with_line(&notes, "- новое"),
        format!("# Заметки\n{NOTES_SECTION}\n- старое\n- новое\n\n## Другое\nтекст")
    );
    assert_eq!(
        with_line("", "- новое"),
        format!("{NOTES_SECTION}\n- новое")
    );
    assert_eq!(
        with_line(&format!("{NOTES_SECTION}\n"), "- новое"),
        format!("{NOTES_SECTION}\n- новое")
    );

    // Undo removes exactly that line; a section left empty goes too.
    let added = with_line("Текст", "- новое");
    assert_eq!(without_line(&added, "- новое").as_deref(), Some("Текст"));
    let two = format!("{NOTES_SECTION}\n- старое\n- новое\n\n## Другое\nтекст");
    assert_eq!(
        without_line(&two, "- новое").unwrap(),
        format!("{NOTES_SECTION}\n- старое\n\n## Другое\nтекст")
    );
    assert_eq!(
        without_line(
            &format!("А\n\n{NOTES_SECTION}\n- новое\n\n## Другое"),
            "- новое"
        )
        .unwrap(),
        "А\n\n## Другое"
    );
    assert_eq!(without_line("Текст", "- новое"), None);
}

/// `knowledge-proposals`: "Заметки длиннее лимита MUST NOT сохраняться".
#[test]
fn notes_over_the_limit_are_refused_and_nothing_changes() {
    let fx = fixture();
    let full = "я".repeat(MAX_NOTES_CHARS - 10);
    projects::update(
        &fx.connection,
        &fx.project,
        ProjectUpdate {
            notes: Some(full.clone()),
            ..ProjectUpdate::default()
        },
    )
    .unwrap();
    let proposal = fx.propose(ProposalTarget::Brief, "product", "Обмен валют за наличные");

    let message = invalid(fx.accept(&proposal.id, None));
    assert!(message.contains("50 000"), "{message}");
    assert_eq!(fx.notes(), full);
    let stored = get(&fx.connection, &proposal.id).unwrap();
    assert_eq!(stored.decision, ProposalDecision::Pending);
    assert_eq!(stored.applied, None);
}

/// `knowledge-proposals`, "Отменить принятое".
#[test]
fn undo_puts_the_previous_value_back() {
    let fx = fixture();
    let tech = fx.propose(ProposalTarget::Person, "tech", "4");
    let label = fx.propose(ProposalTarget::Person, "portrait:Характер", "упрямый");
    let brief = fx.propose(ProposalTarget::Brief, "glossary", "USD МІКС");
    let before = fx.person();
    let notes = fx.notes();
    for proposal in [&tech, &label, &brief] {
        fx.accept(&proposal.id, None).unwrap();
    }

    for proposal in [&tech, &label, &brief] {
        let pending = fx.undo(&proposal.id).unwrap();
        assert_eq!(pending.decision, ProposalDecision::Pending);
        assert_eq!(
            (pending.edited, pending.applied, pending.decided_at),
            (None, None, None)
        );
    }
    let after = fx.person();
    assert_eq!(after.profile, before.profile);
    assert_eq!(after.role, before.role);
    assert_eq!(fx.notes(), notes);

    // Accepted again after the undo.
    fx.accept(&tech.id, Some("5")).unwrap();
    assert_eq!(fx.person().profile["tech"], json!(5));
}

#[test]
fn undo_after_a_manual_change_is_refused() {
    let fx = fixture();
    let tech = fx.propose(ProposalTarget::Person, "tech", "4");
    let brief = fx.propose(ProposalTarget::Brief, "glossary", "USD МІКС");
    fx.accept(&tech.id, None).unwrap();
    fx.accept(&brief.id, None).unwrap();

    // The manager edits both after accepting.
    let mut profile = fx.person().profile;
    profile["tech"] = json!(2);
    people::update(
        &fx.connection,
        &fx.person,
        PersonUpdate {
            profile: Some(profile.clone()),
            ..PersonUpdate::default()
        },
    )
    .unwrap();
    let edited_notes = fx.notes().replace("USD МІКС", "USD MIX");
    projects::update(
        &fx.connection,
        &fx.project,
        ProjectUpdate {
            notes: Some(edited_notes.clone()),
            ..ProjectUpdate::default()
        },
    )
    .unwrap();

    for proposal in [&tech, &brief] {
        assert_eq!(invalid(fx.undo(&proposal.id)), CHANGED_SINCE);
        let stored = get(&fx.connection, &proposal.id).unwrap();
        assert_eq!(stored.decision, ProposalDecision::Accepted);
    }
    assert_eq!(fx.person().profile, profile);
    assert_eq!(fx.notes(), edited_notes);
}

/// `knowledge-proposals`, "Отклонённое предложение MUST NOT ничего менять".
#[test]
fn rejecting_changes_nothing() {
    let fx = fixture();
    fx.fresh_brief();
    let tech = fx.propose(ProposalTarget::Person, "tech", "4");
    let brief = fx.propose(ProposalTarget::Brief, "glossary", "USD МІКС");
    let person = fx.person();
    let notes = fx.notes();

    for proposal in [&tech, &brief] {
        let input = ProposalDecide {
            decision: ProposalDecision::Rejected,
            edited: Some("что-то".to_owned()),
        };
        let (rejected, events) = fx.write(|db| decide(db, &proposal.id, &input)).unwrap();
        assert_eq!(rejected.decision, ProposalDecision::Rejected);
        assert_eq!((rejected.edited, rejected.applied), (None, None));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].entity, Entity::Call);
    }
    assert_eq!(fx.person(), person);
    assert_eq!(fx.notes(), notes);
    assert_eq!(fx.brief_state(), BriefState::Fresh);

    // «Вернуть»: pending again, still nothing changed.
    assert_eq!(
        fx.undo(&tech.id).unwrap().decision,
        ProposalDecision::Pending
    );
    assert_eq!(fx.person(), person);
}

#[test]
fn decisions_follow_the_order_of_the_review() {
    let fx = fixture();
    let proposal = fx.propose(ProposalTarget::Person, "tech", "4");
    invalid(fx.undo(&proposal.id));
    let input = ProposalDecide {
        decision: ProposalDecision::Pending,
        edited: None,
    };
    invalid(fx.write(|db| decide(db, &proposal.id, &input)));
    invalid(fx.accept(&proposal.id, Some("  ")));

    fx.reject(&proposal.id);
    invalid(fx.accept(&proposal.id, None));
    assert_eq!(fx.person().profile["tech"], json!(3));

    let error = fx.accept("nope", None).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}
