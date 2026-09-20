//! `StatusLine` — compact, semantically styled session state.
//!
//! DOM shape:
//! ```text
//! #status-line
//!   ├─ #status-left
//!   │    ├─ .status-model
//!   │    ├─ .status-permission
//!   │    ├─ .status-thinking
//!   │    ├─ .status-mode
//!   │    ├─ .status-running
//!   │    ├─ .status-queue
//!   │    └─ .status-transient
//!   └─ #status-right
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::state::{PermissionMode, StatusState};

/// Node ids patched when status changes.
#[derive(Clone, Copy)]
pub struct StatusLineHandles {
    pub model_text: NodeId,
    pub permission_span: NodeId,
    pub permission_text: NodeId,
    pub thinking_text: NodeId,
    pub mode_text: NodeId,
    pub running_text: NodeId,
    pub queue_text: NodeId,
    pub transient_text: NodeId,
    pub right_text: NodeId,
}

/// Build the status line under `parent`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> StatusLineHandles {
    let line = div(m, parent, "");
    m.set_attribute(line, qual("id"), "status-line");

    let left = div(m, line, "");
    m.set_attribute(left, qual("id"), "status-left");
    let (_, model_text) = span_text(m, left, "status-model", "");
    let (permission_span, permission_text) = span_text(m, left, "status-permission", "");
    let (_, thinking_text) = span_text(m, left, "status-thinking", "");
    let (_, mode_text) = span_text(m, left, "status-mode", "");
    let (_, running_text) = span_text(m, left, "status-running", "");
    let (_, queue_text) = span_text(m, left, "status-queue", "");
    let (_, transient_text) = span_text(m, left, "status-transient", "");
    let (right_span, right_text) = span_text(m, line, "", "");
    m.set_attribute(right_span, qual("id"), "status-right");

    StatusLineHandles {
        model_text,
        permission_span,
        permission_text,
        thinking_text,
        mode_text,
        running_text,
        queue_text,
        transient_text,
        right_text,
    }
}

fn set_segment(
    m: &mut DocumentMutator<'_>,
    text_node: NodeId,
    text: impl AsRef<str>,
    populated: &mut bool,
) {
    let text = text.as_ref();
    if text.is_empty() {
        m.set_node_text(text_node, "");
        return;
    }
    let prefix = if *populated { " · " } else { "" };
    m.set_node_text(text_node, &format!("{prefix}{text}"));
    *populated = true;
}

fn permission_label(permission: PermissionMode) -> &'static str {
    match permission {
        PermissionMode::Normal => "perm normal",
        PermissionMode::AcceptEdits => "perm edits",
        PermissionMode::Smart => "perm smart",
        PermissionMode::Plan => "perm plan",
        PermissionMode::Ask => "perm ask",
        PermissionMode::Bypass => "perm bypass",
        PermissionMode::Autonomous => "perm auto",
    }
}

fn permission_class(permission: PermissionMode) -> &'static str {
    match permission {
        PermissionMode::Normal => "status-permission",
        PermissionMode::AcceptEdits | PermissionMode::Smart => "status-permission status-accent",
        PermissionMode::Plan | PermissionMode::Ask => "status-permission status-info",
        PermissionMode::Bypass | PermissionMode::Autonomous => "status-permission status-warn",
    }
}

fn input_mode_label(mode: &str) -> String {
    match mode.strip_prefix("send:").unwrap_or(mode) {
        "follow-up" | "follow_up" | "followup" => "input follow-up".to_string(),
        "steer" => "input steer".to_string(),
        other => other.replace('_', " "),
    }
}

/// Sync the status line from session state. Every state keeps a textual
/// cue; color only reinforces meaning.
pub fn sync(
    m: &mut DocumentMutator<'_>,
    handles: &StatusLineHandles,
    status: &StatusState,
    streaming: bool,
    permission: PermissionMode,
    queued: usize,
) {
    let mut populated = false;
    set_segment(m, handles.model_text, &status.model, &mut populated);
    m.set_attribute(
        handles.permission_span,
        qual("class"),
        permission_class(permission),
    );
    set_segment(
        m,
        handles.permission_text,
        permission_label(permission),
        &mut populated,
    );
    set_segment(
        m,
        handles.thinking_text,
        if status.thinking.is_empty() {
            String::new()
        } else {
            format!("think {}", status.thinking)
        },
        &mut populated,
    );
    set_segment(
        m,
        handles.mode_text,
        input_mode_label(&status.mode),
        &mut populated,
    );
    set_segment(
        m,
        handles.running_text,
        if streaming { "● running" } else { "" },
        &mut populated,
    );
    set_segment(
        m,
        handles.queue_text,
        if queued > 0 {
            format!("{queued} queued")
        } else {
            String::new()
        },
        &mut populated,
    );
    set_segment(m, handles.transient_text, &status.transient, &mut populated);
    if !populated {
        m.set_node_text(handles.model_text, "pi");
    }

    let right = if status.input_tokens > 0 || status.output_tokens > 0 {
        format!("{} in / {} out", status.input_tokens, status.output_tokens)
    } else {
        String::new()
    };
    m.set_node_text(handles.right_text, &right);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_input_modes_for_people() {
        assert_eq!(input_mode_label("send:follow-up"), "input follow-up");
        assert_eq!(input_mode_label("send:steer"), "input steer");
        assert_eq!(input_mode_label("one_at_a_time"), "one at a time");
    }

    #[test]
    fn risky_permissions_keep_a_warning_class() {
        assert!(permission_class(PermissionMode::Bypass).contains("status-warn"));
        assert!(permission_class(PermissionMode::Autonomous).contains("status-warn"));
        assert_eq!(permission_label(PermissionMode::Plan), "perm plan");
    }
}
