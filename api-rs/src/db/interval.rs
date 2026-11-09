use std::error::Error;
use tokio_postgres::types::private::BytesMut;
use tokio_postgres::types::{IsNull, ToSql, Type, to_sql_checked};

/// A number of days bound as a real interval. Casting text to one in the query
/// would parse it again for every row a window is checked against.
#[derive(Debug)]
pub struct Days(pub f64);

impl ToSql for Days {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        let whole = self.0.trunc();

        // NaN is what a bad `days` param reads as, and it should fail the request.
        if !self.0.is_finite() || whole.abs() > f64::from(i32::MAX) {
            return Err(format!("{} is not a number of days", self.0).into());
        }

        let micros = (self.0.fract() * 86_400_000_000.0).round() as i64;

        out.extend_from_slice(&micros.to_be_bytes());
        out.extend_from_slice(&(whole as i32).to_be_bytes());
        out.extend_from_slice(&0i32.to_be_bytes());

        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        *ty == Type::INTERVAL
    }

    to_sql_checked!();
}
