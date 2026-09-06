import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "impeccable", "scripts", process.platform === "win32" ? "impeccable.cmd" : "impeccable");

function runHook(payload, timeoutMs, ctx) {
  const result = spawnSync(HOOK_SCRIPT, ["hook"], {
    shell: process.platform === "win32",
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: payload.cwd,
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.signal || result.stderr?.trim() || `exit code ${result.status}`;
    const message = `Impeccable hook failed to run: ${reason}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else console.error(message);
    return null;
  }
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext || null;
  } catch {
    return null;
  }
}

// RFC 3986 authority-style scheme ("scheme://..."): essentially no real
// filename is shaped exactly like this, so it alone safely catches xd://,
// http://, file://, and similar with no false positives.
const URI_AUTHORITY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// A short allowlist of specific virtual-document identifiers with no
// authority part at all -- an editor's unsaved-buffer and notebook-cell
// pseudo-paths, never a real filesystem target. Deliberately NOT a generic
// "identifier followed by a colon" pattern: POSIX filenames may legally
// contain a colon anywhere (a real "release:notes.tsx" is syntactically
// indistinguishable from a scheme prefix by shape alone), and a Windows
// drive letter uses a colon too, both absolute ("C:\...") and
// drive-relative ("C:foo", no separator right after the colon) -- matching
// on shape alone rejected real filesystem targets that happened to share
// it. This list only grows for a concretely observed virtual scheme.
const KNOWN_SCHEMELESS_VIRTUAL_PREFIXES = ["untitled:", "vscode-notebook-cell:"];

// A single-letter scheme is indistinguishable from a Windows drive letter by
// shape alone, and the authority regex above requires only ":" + "//" right
// after it -- so "C://Users/dev/App.tsx" (a drive path with a doubled,
// merely redundant separator) matches the same as "xd://" does. Checked
// before the authority regex so a real drive path is exempted regardless of
// which separator form follows the colon (single "\", single "/", or the
// doubled "//" the authority regex would otherwise catch).
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/i;

function hasUriScheme(value) {
  if (WINDOWS_DRIVE_PATH_RE.test(value)) return false;
  if (URI_AUTHORITY_SCHEME_RE.test(value)) return true;
  return KNOWN_SCHEMELESS_VIRTUAL_PREFIXES.some((prefix) => value.startsWith(prefix));
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
    }, 5000, ctx);
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
    }, 30000, ctx);
    // additionalContext alone is dropped. The runner only carries it into a
    // continuation when `continue: true` (or a blocking decision) rides along,
    // so without this the Stop findings are discarded as the session settles.
    if (text) return { continue: true, additionalContext: text };
  });
}
