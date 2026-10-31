//! The tool groups a machine can offer.
//!
//! A group is a switch in the agent's own window. Switching one off removes its
//! tools from `tools/list`, so the model has nothing to call and nothing to find
//! in a codemode script. The instance never decides this; it only reflects what
//! the agent reports.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Screen,
    Mouse,
    Keyboard,
    Files,
    Terminal,
}

impl Group {
    /// Every group the agent knows, in the order the window lists them.
    pub const ALL: [Group; 5] = [
        Group::Screen,
        Group::Mouse,
        Group::Keyboard,
        Group::Files,
        Group::Terminal,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Group::Screen => "screen",
            Group::Mouse => "mouse",
            Group::Keyboard => "keyboard",
            Group::Files => "files",
            Group::Terminal => "terminal",
        }
    }

    pub fn parse(value: &str) -> Option<Group> {
        Group::ALL
            .into_iter()
            .find(|group| group.name().eq_ignore_ascii_case(value.trim()))
    }

    /// The groups a fresh install starts with: what it can actually do, and
    /// nothing that runs a command.
    pub fn default_enabled() -> Vec<Group> {
        vec![Group::Screen, Group::Files]
    }
}

/// Parse a comma separated list, reporting what was not a group.
pub fn parse_list(value: &str) -> Result<Vec<Group>, String> {
    let mut groups = Vec::new();
    for part in value.split(',') {
        if part.trim().is_empty() {
            continue;
        }
        match Group::parse(part) {
            Some(group) if !groups.contains(&group) => groups.push(group),
            Some(_) => {}
            None => return Err(format!("\"{}\" is not a tool group", part.trim())),
        }
    }
    Ok(groups)
}
