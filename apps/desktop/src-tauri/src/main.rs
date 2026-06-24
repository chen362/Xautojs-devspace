#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Default)]
struct CloudLifecycleState {
    snapshot: Mutex<CloudLifecycleSnapshot>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudLifecyclePayload {
    url: String,
    auth_token: String,
    device_id: String,
    desktop_instance_id: Option<String>,
    workspace_catalog: CloudWorkspaceCatalogPayload,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudWorkspaceCatalogPayload {
    catalog_version: String,
    workspaces: Vec<CloudWorkspacePayload>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudWorkspacePayload {
    workspace_ref: String,
    display_name: String,
    root_label: String,
    capabilities: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudLifecycleSnapshot {
    status: String,
    device_id: Option<String>,
    desktop_instance_id: Option<String>,
    url: Option<String>,
    workspace_count: usize,
    started_at: Option<String>,
    stopped_at: Option<String>,
    last_error: Option<String>,
}

impl Default for CloudLifecycleSnapshot {
    fn default() -> Self {
        Self {
            status: "stopped".to_string(),
            device_id: None,
            desktop_instance_id: None,
            url: None,
            workspace_count: 0,
            started_at: None,
            stopped_at: None,
            last_error: None,
        }
    }
}

#[tauri::command]
fn start_cloud_lifecycle(
    state: State<CloudLifecycleState>,
    payload: CloudLifecyclePayload,
) -> Result<CloudLifecycleSnapshot, String> {
    validate_lifecycle_payload(&payload)?;
    let mut snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "cloud lifecycle state is unavailable".to_string())?;
    *snapshot = CloudLifecycleSnapshot {
        status: "running".to_string(),
        device_id: Some(payload.device_id),
        desktop_instance_id: payload.desktop_instance_id,
        url: Some(payload.url),
        workspace_count: payload.workspace_catalog.workspaces.len(),
        started_at: Some(now_marker()),
        stopped_at: None,
        last_error: None,
    };
    Ok(snapshot.clone())
}

#[tauri::command]
fn stop_cloud_lifecycle(state: State<CloudLifecycleState>) -> Result<CloudLifecycleSnapshot, String> {
    let mut snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "cloud lifecycle state is unavailable".to_string())?;
    snapshot.status = "stopped".to_string();
    snapshot.stopped_at = Some(now_marker());
    Ok(snapshot.clone())
}

#[tauri::command]
fn get_cloud_lifecycle(state: State<CloudLifecycleState>) -> Result<CloudLifecycleSnapshot, String> {
    let snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "cloud lifecycle state is unavailable".to_string())?;
    Ok(snapshot.clone())
}

fn validate_lifecycle_payload(payload: &CloudLifecyclePayload) -> Result<(), String> {
    if payload.url.trim().is_empty() {
        return Err("gateway url is required".to_string());
    }
    if payload.auth_token.trim().is_empty() {
        return Err("device token is required".to_string());
    }
    if payload.device_id.trim().is_empty() {
        return Err("device id is required".to_string());
    }
    Ok(())
}

fn now_marker() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix:{}", seconds)
}

fn main() {
    tauri::Builder::default()
        .manage(CloudLifecycleState::default())
        .invoke_handler(tauri::generate_handler![
            start_cloud_lifecycle,
            stop_cloud_lifecycle,
            get_cloud_lifecycle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Xautojs Desktop");
}
