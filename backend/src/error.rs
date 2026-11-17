use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub message: String,
    pub code: String,
}
impl AppError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.into(),
            code: "M_UNKNOWN".into(),
        }
    }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        // Never include upstream request objects or config values in logs.
        eprintln!("Storage/runtime error: {error}");
        Self::new(500, "服务内部错误，请检查数据卷与部署配置")
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":self.message,"errcode":self.code})),
        )
            .into_response()
    }
}
pub type Result<T> = std::result::Result<T, AppError>;
