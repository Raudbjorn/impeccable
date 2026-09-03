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

// RFC 3986: scheme starts with a letter, then letters/digits/+/-/., then
// ":". Matches just the "scheme:" prefix, not "scheme://": plenty of real
// tool surfaces carry a scheme with no authority part at all (e.g.
// untitled:Untitled-1, vscode-notebook-cell:/path), not only xd://-style
// LSP targets. A Windows drive letter (a single letter, colon, then a path
// separator) matches the same "letter followed by a colon" syntax but is
// always exactly one letter; no real scheme is that shape.
function hasUriScheme(value) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!match) return false;
  if (match[1].length === 1 && /^[\\/]/.test(value.slice(match[0].length))) return false;
  return true;
}

export default function impeccableHook(pi) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath =
      (event.tool_input && typeof event.tool_input.file_path === 'string' && event.tool_input.file_path) ||
      (event.input && typeof event.input.path === 'string' && event.input.path) ||
      null;
    if (!filePath) return;
    // Some tool surfaces carry a scheme-prefixed identifier that is not a
    // real filesystem target. Spawning hook.mjs on them is wasted work —
    // hook-lib.mjs downstream file-missing skip is the only thing keeping
    // it cheap. Reject at the adapter so the spawn never happens.
    if (hasUriScheme(filePath)) return;
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

