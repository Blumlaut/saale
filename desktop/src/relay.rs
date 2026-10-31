//! The channel to the Saale instance.
//!
//! The agent dials out and holds a server-sent event stream open; the instance
//! sends JSON-RPC requests down it and the agent posts its answers back up. No
//! port is opened, so a machine behind NAT or a firewall pairs like any other.

use std::collections::BTreeSet;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::backends::Desktop;
use crate::mcp;
use crate::tools;

const CHANNEL: &str = "/api/devices/channel";
const PAIR: &str = "/api/devices/pair";

/// First retry delay, and the ceiling it backs off to.
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

pub struct Relay {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl Relay {
    pub fn new(base: &str, token: &str) -> Relay {
        Relay {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    /// Trade a pairing code for a token.
    pub async fn pair(
        base: &str,
        code: &str,
        name: &str,
        groups: &BTreeSet<tools::Group>,
    ) -> Result<Value, String> {
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{}{PAIR}", base.trim_end_matches('/')))
            .json(&json!({
                "code": code,
                "name": name,
                "platform": std::env::consts::OS,
                "session": mcp::session(),
                "capabilities": groups.iter().map(|group| group.name()).collect::<Vec<_>>(),
                "agentVersion": crate::VERSION,
            }))
            .send()
            .await
            .map_err(|err| format!("Cannot reach {base}: {err}"))?;

        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|err| format!("{base} answered with something unreadable: {err}"))?;

        if !status.is_success() {
            let reason = body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("pairing was refused");
            return Err(reason.to_string());
        }

        Ok(body)
    }

    /// Post messages to the instance.
    async fn post(&self, body: Value) -> Result<(), String> {
        let response = self
            .client
            .post(format!("{}{CHANNEL}", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("Cannot reach {}: {err}", self.base))?;

        if response.status().as_u16() == 401 {
            return Err("The instance rejected this machine's token. Pair it again.".to_string());
        }
        if !response.status().is_success() {
            return Err(format!(
                "{} refused the message ({})",
                self.base,
                response.status()
            ));
        }
        Ok(())
    }

    /// Stay connected, answering until the process is stopped.
    pub async fn run(&self, groups: BTreeSet<tools::Group>, desktop: Desktop) -> ! {
        let mut backoff = RETRY_MIN;

        loop {
            println!(
                "Connecting to {} with {} tools...",
                self.base,
                tools::list(&groups, desktop.available()).len()
            );

            match self.session(&groups, &desktop).await {
                Ok(()) => println!("The channel closed. Reconnecting."),
                Err(err) => println!("{err}"),
            }

            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(RETRY_MAX);
        }
    }

    /// One connection's worth of stream.
    async fn session(
        &self,
        groups: &BTreeSet<tools::Group>,
        desktop: &Desktop,
    ) -> Result<(), String> {
        let response = self
            .client
            .get(format!("{}{CHANNEL}", self.base))
            .bearer_auth(&self.token)
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|err| format!("Cannot open the channel: {err}"))?;

        if response.status().as_u16() == 401 {
            return Err("The instance rejected this machine's token. Pair it again.".to_string());
        }
        if !response.status().is_success() {
            return Err(format!("The channel answered {}", response.status()));
        }

        // What this machine offers, so the instance can show it.
        self.post(mcp::hello(groups, desktop.available())).await?;

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| format!("The channel broke: {err}"))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(end) = buffer.find("\n\n") {
                let event: String = buffer.drain(..end + 2).collect();
                self.handle_event(event.trim_end(), groups, desktop).await?;
            }
        }

        Ok(())
    }

    /// One server-sent event: a request to answer, or a keepalive.
    async fn handle_event(
        &self,
        event: &str,
        groups: &BTreeSet<tools::Group>,
        desktop: &Desktop,
    ) -> Result<(), String> {
        let mut kind = "message";
        let mut data = String::new();

        for line in event.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                kind = value.trim();
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim_start());
            }
        }

        match kind {
            "message" => {}
            // The instance is alive; nothing to answer.
            "ready" | "ping" => return Ok(()),
            _ => return Ok(()),
        }

        let message: Value = match serde_json::from_str(&data) {
            Ok(value) => value,
            Err(err) => {
                println!("Dropped a message that was not JSON: {err}");
                return Ok(());
            }
        };

        if let Some(answer) = mcp::handle(groups, desktop, &message).await {
            self.post(json!({ "messages": [answer] })).await?;
        }

        Ok(())
    }
}
