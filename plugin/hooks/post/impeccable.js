import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "impeccable", "scripts", process.platform === "win32" ? "impeccable.cmd" : "impeccable");

// Async (not spawnSync): a multi-file edit scans every touched path, and a
// synchronous spawn per path serializes their timeouts, so N files could
// block the tool-result handler for up to timeoutMs * N. Spawned
// concurrently and awaited via Promise.all, the wall-clock cost is bounded
// by the single slowest scan instead.
// How long a timed-out scan gets to honor SIGTERM before SIGKILL, and then
// how long SIGKILL gets to produce a `close` before the slot is freed anyway.
const KILL_GRACE_MS = 2000;

function runHook(payload, timeoutMs, ctx) {
  return new Promise((resolve) => {
    // Reported once: the timeout path can reach here from `close` and from
    // its own give-up timer, and a doubled notification is a doubled report
    // of one failure.
    let reported = false;
    const fail = (reason) => {
      if (reported) return;
      reported = true;
      const message = `Impeccable hook failed to run: ${reason}`;
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
      resolve(null);
    };
    let child;
    try {
      child = spawn(HOOK_SCRIPT, ["hook"], {
        shell: process.platform === "win32",
        cwd: payload.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      fail(err.message);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = null;
    let escalate = null;
    let abandon = null;
    const clearTimers = () => {
      clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      if (abandon) clearTimeout(abandon);
    };
    // On timeout, decide the outcome but do NOT resolve yet. `child.kill()`
    // only sends SIGTERM and returns; it does not wait. Resolving there
    // released this worker slot while the process could still be alive, so a
    // launcher that delays or ignores termination let the pool start the next
    // scan and put more than MAX_CONCURRENT_SCANS engines on the machine at
    // once. The slot is held until `close` says the process is really gone.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = `timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
      escalate = setTimeout(() => {
        child.kill("SIGKILL");
        // SIGKILL is not refusable, so `close` follows. If it somehow does
        // not, free the slot anyway: a wedged promise would stall the whole
        // pool, which is worse than one unreaped process.
        abandon = setTimeout(() => fail(timedOut), KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    }, timeoutMs);
    // Buffer mode decodes each chunk independently, so a multi-byte UTF-8
    // character split across a chunk boundary comes out as replacement
    // characters and JSON.parse on the finding payload throws. setEncoding
    // switches the stream to a StringDecoder, which buffers a trailing
    // partial sequence until the next chunk completes it.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fail(err.message);
    });
    // A launcher that exits (or never opens stdin) before the write lands
    // raises EPIPE on the stdin stream itself, which `child.on("error")`
    // above does not catch -- an unhandled stream "error" event throws.
    child.stdin.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fail(err.message);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      // A timed-out scan reports here rather than at the timer, so the worker
      // slot is only released once the process has actually exited.
      if (timedOut) {
        fail(timedOut);
        return;
      }
      if (settled) return;
      settled = true;
      if (code !== 0) {
        fail(signal || stderr.trim() || `exit code ${code}`);
        return;
      }
      if (!stdout) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout)?.hookSpecificOutput?.additionalContext || null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
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

// A bulk edit can carry an arbitrarily long target list; spawning one engine
// process per path with no cap risks exhausting the OS's process/file
// descriptor limits on a large batch. Cap how many run at once instead of
// bounding only by the target list's own size.
const MAX_CONCURRENT_SCANS = 8;

async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default function impeccableHook(pi) {
  pi.on("tool_result", async (event, ctx) => {
    // ast_edit mutates files like edit and write do; omitting it left a whole
    // class of edits unscanned. The apply_patch edit mode arrives here with
    // toolName "edit" too, never literally "apply_patch": hooks/tool-wrapper.ts
    // emits `toolName: this.tool.name`, and edit/index.ts's EditTool has a
    // fixed `readonly name = "edit"` regardless of mode -- `apply_patch` is
    // only the wire-level name GPT-5's custom-tool grammar uses, resolved back
    // to this same tool by the dispatcher before a hook ever sees the call
    // (its sibling getter is literally named customWireName). The distinct
    // "apply_patch" toolName that isEditLikeToolName/resolveEditModeForTool
    // check in oh-my-pi's tool-execution.ts is real, but that is the
    // transcript-rendering path, fed the model's raw, unresolved tool-call
    // name -- a different value from this hook contract's toolName. The
    // "apply_patch" arm below is therefore dead today; kept as a harmless
    // guard against a future oh-my-pi version that starts surfacing it here.
    if (
      event.toolName !== "edit" &&
      event.toolName !== "write" &&
      event.toolName !== "ast_edit" &&
      event.toolName !== "apply_patch"
    ) return;
    const details = event.details || {};
    let targets;
    if (event.toolName === "ast_edit") {
      // A preview (dry-run) tool_result stages changes for a later `resolve`
      // and applies nothing yet; `details.files` on that result names files
      // *considered*, not files on disk with new content. Scan only once
      // `applied` is true, and then only the files ast_edit actually touched
      // (EditToolDetails-style `files`, not `input.paths`, which are the
      // search scopes — directories and globs like `src/**/*.ts` — the edit
      // ran over, not the files it changed).
      targets = details.applied === true && Array.isArray(details.files)
        ? details.files.filter((entry) => typeof entry === "string" && entry.length > 0)
        : [];
    } else if (event.toolName === "edit" || event.toolName === "apply_patch") {
      // The edit tool's own result details are the authoritative changed-file
      // list for every mode, including apply_patch, whose input is a raw
      // patch envelope rather than the `¶PATH#TAG` hashline headers
      // `input.paths` is derived from — so `input.paths` can be empty here
      // even though real files changed. Prefer details; fall back to input
      // for a result that carries no details (e.g. the call errored before
      // producing any).
      const fromDetails = Array.isArray(details.perFileResults)
        ? details.perFileResults
            // An empty `path` is a present-but-useless entry, and it has to
            // be dropped here: hasUriScheme("") is false, so "" survives the
            // scheme filter downstream and spawns the launcher against an
            // empty target. The `details.path` branch below already required
            // a non-empty string; these two now agree.
            .map((entry) => entry && typeof entry.path === "string" && entry.path.length > 0 ? entry.path : null)
            .filter((entry) => entry !== null)
        : typeof details.path === "string" && details.path.length > 0
          ? [details.path]
          : [];
      if (fromDetails.length > 0) {
        // Real, confirmed per-file targets take priority even on a partial
        // failure (isError with some perFileResults entries still written).
        targets = fromDetails;
      } else if (event.isError) {
        // No confirmed details and the call itself failed: nothing was
        // written, so a request-side path guess would scan a file this
        // edit never touched and could append an unrelated finding to the
        // tool's own error output.
        targets = [];
      } else {
        // `input.paths` is the authoritative multi-target list a multi-file
        // edit carries; the runner drops the single-target
        // `path`/`tool_input.file_path` convenience entirely once an edit
        // touches two or more files, so reading only one of those skipped
        // every multi-file edit.
        const input = event.input || {};
        const singlePath =
          (event.tool_input && typeof event.tool_input.file_path === 'string' && event.tool_input.file_path) ||
          (typeof input.path === 'string' && input.path) ||
          null;
        targets = Array.isArray(input.paths)
          ? input.paths.filter((entry) => typeof entry === "string" && entry.length > 0)
          : singlePath
            ? [singlePath]
            : [];
      }
    } else if (event.isError) {
      // write has no details at all (always undefined), so a failed write
      // leaves no confirmed evidence anything was written; same reasoning
      // as the edit/apply_patch branch above.
      targets = [];
    } else {
      // write
      const input = event.input || {};
      const singlePath =
        (event.tool_input && typeof event.tool_input.file_path === 'string' && event.tool_input.file_path) ||
        (typeof input.path === 'string' && input.path) ||
        null;
      targets = singlePath ? [singlePath] : [];
    }
    if (targets.length === 0) return;
    // Some tool surfaces carry a scheme-prefixed identifier that is not a
    // real filesystem target. Spawning the hook on them is wasted work — the
    // hook's own file-missing skip is the only thing keeping it cheap.
    // Reject at the adapter so the spawn never happens.
    const scannable = targets.filter((filePath) => !hasUriScheme(filePath));
    if (scannable.length === 0) return;
    // Scan targets concurrently (see the note on runHook() for why this is
    // not a sequential loop), up to MAX_CONCURRENT_SCANS at once so a large
    // batch edit cannot launch an unbounded number of engine processes.
    const results = await mapWithConcurrencyLimit(scannable, MAX_CONCURRENT_SCANS, (filePath) => runHook({
      hook_event_name: "PostToolUse",
      tool_name: event.toolName,
      tool_input: { file_path: filePath },
      cwd: ctx.cwd,
    }, 5000, ctx));
    const findings = results.filter(Boolean);
    if (findings.length === 0) return;
    // ToolResultEventResult.content is a replacement content-block array, not
    // a string: the runner takes `result.content ?? tool.content`, so a bare
    // string both discards the edit's own output and hands back a shape the
    // provider cannot render. Append a text block to what the tool produced.
    const blocks = Array.isArray(event.content) ? event.content : [];
    return { content: [...blocks, { type: "text", text: findings.join("\n\n") }] };
  });

  pi.on("session_stop", async (event, ctx) => {
    const text = await runHook({
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
