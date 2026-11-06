use crate::app::error::{AppError, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use serde::Deserialize;

/// Query params in request order; a repeated key reads as its first value.
#[derive(Deserialize)]
#[serde(transparent)]
pub struct Params(Vec<(String, String)>);

impl Params {
    /// The value of `key`, with an empty one reading as absent.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }

    pub fn number(&self, key: &str, default: f64) -> f64 {
        self.get(key).map_or(default, parse_number)
    }

    /// Rounded into `min..=max`; anything that is not a number reads as `min`.
    pub fn clamped(&self, key: &str, default: f64, min: f64, max: f64) -> i32 {
        let value = self.number(key, default);
        if value.is_nan() {
            return min as i32;
        }
        (value + 0.5).floor().clamp(min, max) as i32
    }

    /// The `tz` param, with an empty or unknown zone reading as UTC instead of erroring the query.
    pub fn time_zone(&self) -> String {
        self.get("tz")
            .filter(|tz| Tz::from_str_insensitive(tz).is_ok())
            .unwrap_or("UTC")
            .to_string()
    }

    /// The `month` or `year` param as one period string, if there is one.
    pub fn period(&self) -> Result<Option<String>> {
        let month = self.get("month");
        let year = self.get("year");

        if month.is_some_and(|m| !is_month(m)) {
            return Err(AppError::BadRequest("Invalid month"));
        }
        if year.is_some_and(|y| !is_year(y)) {
            return Err(AppError::BadRequest("Invalid year"));
        }

        Ok(month.or(year).map(str::to_string))
    }
}

fn is_year(value: &str) -> bool {
    value.len() == 4 && value.bytes().all(|b| b.is_ascii_digit())
}

fn is_month(value: &str) -> bool {
    let Some((year, month)) = value.split_once('-') else {
        return false;
    };
    let in_range = month.len() == 2 && month.parse::<u8>().is_ok_and(|m| (1..=12).contains(&m));
    is_year(year) && in_range && month.bytes().all(|b| b.is_ascii_digit())
}

/// A number as the Bun API read it, where non-numbers become NaN rather than an error.
pub fn parse_number(value: &str) -> f64 {
    let value = value.trim();
    match value {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        // Rust would otherwise accept "inf" and "nan".
        _ if value
            .bytes()
            .any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E') =>
        {
            f64::NAN
        }
        _ => value.parse().unwrap_or(f64::NAN),
    }
}

/// A number as text for an interval: Postgres rejects NaN, which is what a bad `days` should do.
pub fn number_text(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// The `gameId` path param: not a number is a 400, and a number that is not an id fails as the query would.
pub fn game_id(raw: &str) -> Result<i32> {
    let id = parse_number(raw);
    if id.is_nan() {
        return Err(AppError::BadRequest("Invalid gameId"));
    }
    if id.fract() != 0.0 || id < i32::MIN as f64 || id > i32::MAX as f64 {
        return Err(AppError::InternalServerError);
    }
    Ok(id as i32)
}

pub fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
