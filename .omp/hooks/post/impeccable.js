import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "impeccable", "scripts", "hook.mjs");

function runHook(payload) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: payload.cwd,
  });
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext || null;
  } catch {
    return null;
  }
}

export default function impeccableHook(pi) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath = event.input && typeof event.input.path === "string" ? event.input.path : null;
    if (!filePath) return;
    const text = runHook({
      hook_event_name: "PostToolUse",
      tool_name: event.toolName,
      tool_input: { file_path: filePath },
      cwd: ctx.cwd,
    });
    if (!text) return;
    // ToolResultEventResult.content is a replacement content-block array, not
    // a string: the runner takes `result.content ?? tool.content`, so a bare
    // string both discards the edit's own output and hands back a shape the
    // provider cannot render. Append a text block to what the tool produced.
    const blocks = Array.isArray(event.content) ? event.content : [];
    return { content: [...blocks, { type: "text", text }] };
  });

  pi.on("session_stop", async (event, ctx) => {
    const text = runHook({
      hook_event_name: "Stop",
      stop_hook_active: event.stop_hook_active === true,
      cwd: ctx.cwd,
    });
    // additionalContext alone is dropped. The runner only carries it into a
    // continuation when `continue: true` (or a blocking decision) rides along,
    // so without this the Stop findings are discarded as the session settles.
    if (text) return { continue: true, additionalContext: text };
  });
}
