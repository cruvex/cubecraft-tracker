use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use std::time::Instant;
use tracing::{info, warn};
use uuid::Uuid;

const RAILWAY_REQUEST_ID_HEADER: &str = "x-railway-request-id";

pub async fn mw_req_log(req: Request<Body>, next: Next) -> Response {
    let method = req.method().to_string();
    let uri = req.uri().to_string();
    let request_id = req
        .headers()
        .get(RAILWAY_REQUEST_ID_HEADER)
        .and_then(|id| id.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let started = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16();
    let duration_ms = started.elapsed().as_millis() as u64;

    if res.status() == StatusCode::INTERNAL_SERVER_ERROR {
        warn!(request_id, method, uri, status, duration_ms, "handled request");
    } else {
        info!(request_id, method, uri, status, duration_ms, "handled request");
    }

    res
}
