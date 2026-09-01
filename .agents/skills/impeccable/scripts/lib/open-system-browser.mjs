import { spawn } from 'node:child_process';

export function browserOpenCommand(url) {
  return { command: 'xdg-open', args: [url] };
}

export function openSystemBrowser(url, { spawnImpl = spawn } = {}) {
  const { command, args } = browserOpenCommand(url);
  try {
    const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
