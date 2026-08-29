export const type = "qoder_local";
export const label = "Qoder (local)";

export const models = [
  { id: "Qwen3.8-Max", label: "Qwen3.8-Max" },
  { id: "Qwen3.8-Flash", label: "Qwen3.8-Flash" },
  { id: "Qwen3.7-Max", label: "Qwen3.7-Max" },
  { id: "Qwen3.7-Plus", label: "Qwen3.7-Plus" },
];

export const agentConfigurationDoc = `# qoder_local agent configuration

Adapter: qoder_local

Use when:
- You want Paperclip to run the Qoder CLI (qoder) locally on the host machine
- You want Qoder sessions resumed across heartbeats with -r
- The host runs the Qoder desktop app signed in, so the CLI inherits auth

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- The Qoder CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt. Sibling files in the same directory are made readable via --add-dir.
- promptTemplate (string, optional): run prompt template
- model (string, optional): Qoder model name as listed by \`qoder --list-models\` (e.g. Qwen3.8-Max). Omit to use the CLI default.
- permissionMode (string, optional): one of default | accept_edits | bypass_permissions | dont_ask | auto. Defaults to bypass_permissions for unattended runs — this is dangerous; production deployments should narrow it.
- command (string, optional): defaults to "qoder"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`qoder -p\` with \`--output-format stream-json\` for non-interactive headless execution; the prompt is passed as an argument.
- The adapter blanks QODER_AGENT_SDK_ENTRYPOINT in the child env so a server process started from inside a Qoder session does not trip the CLI's SDK-args guard.
- Sessions resume with \`-r <session_id>\` when the stored session cwd matches the current cwd; the session id is captured from the stream-json init/result events.
- Desired Paperclip skills are delivered via \`--add-dir\` pointing at a per-run tmpdir carrying \`.agents/skills\` symlinks, so the agent workspace is never polluted.
- Authentication comes from the Qoder desktop app session on the host; there is no API-key env pair.
`;
