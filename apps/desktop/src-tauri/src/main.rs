#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::env;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Default)]
struct CloudLifecycleState {
    snapshot: Mutex<CloudLifecycleSnapshot>,
    child: Mutex<Option<Child>>,
}

impl Drop for CloudLifecycleState {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            stop_child(&mut child);
        }
    }
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
    process_id: Option<u32>,
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
            process_id: None,
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

    let mut child_guard = state
        .child
        .lock()
        .map_err(|_| "cloud lifecycle process state is unavailable".to_string())?;
    stop_child(&mut child_guard);

    let child = match spawn_lifecycle_runner(&payload) {
        Ok(child) => child,
        Err(error) => {
            set_error_snapshot(&state, &payload, error.clone())?;
            return Err(error);
        }
    };
    let process_id = child.id();
    *child_guard = Some(child);
    drop(child_guard);

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
        process_id: Some(process_id),
        started_at: Some(now_marker()),
        stopped_at: None,
        last_error: None,
    };
    Ok(snapshot.clone())
}

#[tauri::command]
fn stop_cloud_lifecycle(state: State<CloudLifecycleState>) -> Result<CloudLifecycleSnapshot, String> {
    let mut child_guard = state
        .child
        .lock()
        .map_err(|_| "cloud lifecycle process state is unavailable".to_string())?;
    stop_child(&mut child_guard);
    drop(child_guard);

    let mut snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "cloud lifecycle state is unavailable".to_string())?;
    snapshot.status = "stopped".to_string();
    snapshot.process_id = None;
    snapshot.stopped_at = Some(now_marker());
    Ok(snapshot.clone())
}

#[tauri::command]
fn get_cloud_lifecycle(state: State<CloudLifecycleState>) -> Result<CloudLifecycleSnapshot, String> {
    let mut child_guard = state
        .child
        .lock()
        .map_err(|_| "cloud lifecycle process state is unavailable".to_string())?;
    let mut snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "cloud lifecycle state is unavailable".to_string())?;
    refresh_child_exit(&mut child_guard, &mut snapshot);
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

fn spawn_lifecycle_runner(payload: &CloudLifecyclePayload) -> Result<Child, String> {
    let runner = lifecycle_runner_command();
    let payload_json = serde_json::to_vec(payload)
        .map_err(|error| format!("failed to serialize cloud lifecycle payload: {}", error))?;
    let mut command = Command::new(&runner.command);
    command
        .args(&runner.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start desktop cloud agent runner `{}`: {}", runner.display(), error))?;

    match child.stdin.take() {
        Some(mut stdin) => {
            if let Err(error) = stdin.write_all(&payload_json) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to send cloud lifecycle payload to desktop agent runner: {}", error));
            }
        }
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("desktop cloud agent runner stdin is unavailable".to_string());
        }
    }

    Ok(child)
}

struct LifecycleRunnerCommand {
    command: String,
    args: Vec<String>,
}

impl LifecycleRunnerCommand {
    fn display(&self) -> String {
        std::iter::once(self.command.clone())
            .chain(self.args.clone())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn lifecycle_runner_command() -> LifecycleRunnerCommand {
    let command = env::var("DEVSPACE_DESKTOP_AGENT_COMMAND")
        .unwrap_or_else(|_| "devspace-desktop-agent".to_string());
    let args = env::var("DEVSPACE_DESKTOP_AGENT_ARGS")
        .ok()
        .map(|value| split_runner_args(&value))
        .filter(|args| !args.is_empty())
        .unwrap_or_else(|| vec!["--stdin".to_string()]);
    LifecycleRunnerCommand { command, args }
}

fn split_runner_args(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn stop_child(child: &mut Option<Child>) {
    if let Some(mut running) = child.take() {
        let _ = running.kill();
        let _ = running.wait();
    }
}

fn refresh_child_exit(child: &mut Option<Child>, snapshot: &mut CloudLifecycleSnapshot) {
    let exit_message = match child.as_mut() {
        Some(running) => match running.try_wait() {
            Ok(Some(status)) => Some(format!("desktop cloud agent runner exited unexpectedly: {}", status)),
            Ok(None) => None,
            Err(error) => Some(format!("failed to inspect desktop cloud agent runner: {}", error)),
        },
        None => None,
    };

    if let Some(message) = exit_message {
        *child = None;
        snapshot.status = "error".to_string();
        snapshot.process_id = None;
        snapshot.stopped_at = Some(now_marker());
        snapshot.last_error = Some(message);
    }
}

fn set_error_snapshot(
    state: &State<CloudLifecycleState>,
    payload: &CloudLifecyclePayload,
    error: String,
) -> Result<(), String> {
    let mut snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "cloud lifecycle state is unavailable".to_string())?;
    *snapshot = CloudLifecycleSnapshot {
        status: "error".to_string(),
        device_id: Some(payload.device_id.clone()),
        desktop_instance_id: payload.desktop_instance_id.clone(),
        url: Some(payload.url.clone()),
        workspace_count: payload.workspace_catalog.workspaces.len(),
        process_id: None,
        started_at: None,
        stopped_at: Some(now_marker()),
        last_error: Some(error),
    };
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
