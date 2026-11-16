//! JSON text columns (brief, profile, card fields, summary, evidence).

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde_json::Value;

/// A JSON value stored as text. rusqlite's own `serde_json` support stores
/// numbers and strings unquoted, which a `json_valid` check rejects.
#[derive(Debug, Clone, PartialEq)]
pub struct Json(pub Value);

impl ToSql for Json {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.0.to_string()))
    }
}

impl FromSql for Json {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let text = value.as_str()?;
        serde_json::from_str(text)
            .map(Json)
            .map_err(|error| FromSqlError::Other(Box::new(error)))
    }
}

/// Reads a nullable JSON column.
pub fn optional(value: Option<Json>) -> Option<Value> {
    value.map(|Json(value)| value)
}

/// Applies an RFC 7386 JSON merge patch to `target`: an object patch merges
/// key by key (`null` removes the key), anything else replaces the target.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(changes) = patch else {
        target.clone_from(patch);
        return;
    };
    if !target.is_object() {
        *target = Value::Object(serde_json::Map::new());
    }
    let Value::Object(fields) = target else {
        return;
    };
    for (key, change) in changes {
        if change.is_null() {
            fields.remove(key);
        } else {
            merge_patch(fields.entry(key.clone()).or_insert(Value::Null), change);
        }
    }
}

/// A patch field of a nullable column: absent → `None` (unchanged),
/// `null` → `Some(None)` (cleared), a value → `Some(Some(value))`.
///
/// Use with `#[serde(default, deserialize_with = "json::double_option")]`.
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn merged(target: Value, patch: Value) -> Value {
        let mut target = target;
        merge_patch(&mut target, &patch);
        target
    }

    /// The examples of RFC 7386, appendix A.
    #[test]
    fn follows_the_rfc_7386_examples() {
        let cases = [
            (json!({"a":"b"}), json!({"a":"c"}), json!({"a":"c"})),
            (json!({"a":"b"}), json!({"b":"c"}), json!({"a":"b","b":"c"})),
            (json!({"a":"b"}), json!({"a":null}), json!({})),
            (
                json!({"a":"b","b":"c"}),
                json!({"a":null}),
                json!({"b":"c"}),
            ),
            (json!({"a":["b"]}), json!({"a":"c"}), json!({"a":"c"})),
            (json!({"a":"c"}), json!({"a":["b"]}), json!({"a":["b"]})),
            (
                json!({"a":{"b":"c"}}),
                json!({"a":{"b":"d","c":null}}),
                json!({"a":{"b":"d"}}),
            ),
            (json!({"a":[{"b":"c"}]}), json!({"a":[1]}), json!({"a":[1]})),
            (json!(["a", "b"]), json!(["c", "d"]), json!(["c", "d"])),
            (json!({"a":"b"}), json!(["c"]), json!(["c"])),
            (json!({"a":"foo"}), json!(null), json!(null)),
            (json!({"a":"foo"}), json!("bar"), json!("bar")),
            (json!({"e":null}), json!({"a":1}), json!({"e":null,"a":1})),
            (json!([1, 2]), json!({"a":"b","c":null}), json!({"a":"b"})),
            (
                json!({}),
                json!({"a":{"bb":{"ccc":null}}}),
                json!({"a":{"bb":{}}}),
            ),
        ];
        for (target, patch, expected) in cases {
            assert_eq!(
                merged(target.clone(), patch.clone()),
                expected,
                "{target} + {patch}"
            );
        }
    }

    #[derive(Debug, serde::Deserialize)]
    struct Patch {
        #[serde(default, deserialize_with = "double_option")]
        field: Option<Option<i64>>,
    }

    #[test]
    fn double_option_tells_null_from_absent() {
        let parse = |text: &str| serde_json::from_str::<Patch>(text).unwrap().field;
        assert_eq!(parse("{}"), None);
        assert_eq!(parse(r#"{"field":null}"#), Some(None));
        assert_eq!(parse(r#"{"field":5}"#), Some(Some(5)));
    }
}
