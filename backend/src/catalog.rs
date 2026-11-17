use crate::error::{AppError, Result};
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
const PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b':')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');
pub fn encode(value: &str) -> String {
    utf8_percent_encode(value, PATH).to_string()
}
pub const RAW: &str = include_str!("../catalog.json");
#[derive(Clone, Deserialize)]
pub struct Endpoint {
    pub id: String,
    pub label: String,
    pub method: String,
    pub path: String,
}
pub fn catalog() -> HashMap<String, Endpoint> {
    serde_json::from_str::<Vec<Endpoint>>(RAW)
        .expect("valid bundled catalog")
        .into_iter()
        .map(|e| (e.id.clone(), e))
        .collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminRequest {
    pub id: String,
    #[serde(default = "object")]
    pub params: Value,
    #[serde(default = "object")]
    pub query: Value,
    #[serde(default = "object")]
    pub body: Value,
    #[serde(default)]
    pub confirm: bool,
}
fn object() -> Value {
    json!({})
}
pub fn build(entry: &Endpoint, input: &AdminRequest) -> Result<(Method, String, Option<Value>)> {
    let params = input
        .params
        .as_object()
        .ok_or_else(|| AppError::new(400, "路径参数必须是 JSON 对象"))?;
    let query = input
        .query
        .as_object()
        .ok_or_else(|| AppError::new(400, "查询参数必须是 JSON 对象"))?;
    if !input.body.is_object() {
        return Err(AppError::new(400, "正文必须是 JSON 对象"));
    }
    let mut path = entry.path.clone();
    while let Some(start) = path.find('{') {
        let end = path[start..]
            .find('}')
            .map(|n| n + start)
            .ok_or_else(|| AppError::new(500, "API 目录路径无效"))?;
        let key = &path[start + 1..end];
        let value = params
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new(400, format!("缺少路径参数：{key}")))?;
        if value.is_empty()
            || value.len() > 1024
            || value == "."
            || value == ".."
            || value
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | '%'))
        {
            return Err(AppError::new(400, format!("无效路径参数：{key}")));
        }
        path.replace_range(start..=end, &encode(value));
    }
    let mut search = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in query {
        if ["token", "password", "secret", "authorization"]
            .iter()
            .any(|s| key.to_lowercase().contains(s))
        {
            return Err(AppError::new(400, "查询参数不能包含凭据"));
        }
        if value.is_null() || value == "" {
            continue;
        }
        let value = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => return Err(AppError::new(400, "查询参数必须为标量")),
        };
        search.append_pair(key, &value);
    }
    let search = search.finish();
    if !search.is_empty() {
        path.push('?');
        path.push_str(&search);
    }
    let method = Method::from_bytes(entry.method.as_bytes())
        .map_err(|_| AppError::new(500, "无效 API 方法"))?;
    if method != Method::GET && !input.confirm {
        return Err(AppError::new(400, "写操作需要明确确认"));
    }
    let body = (method != Method::GET).then(|| input.body.clone());
    Ok((method, path, body))
}
