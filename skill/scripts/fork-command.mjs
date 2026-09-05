// Windows launcher bridge: argv forwarding without cmd SHIFT / %* ambiguity.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [command, ...args] = process.argv.slice(2);
const verb = ({ hooks: 'hook-admin', signals: 'context-signals' })[command] || command;
if (!/^[a-z-]+$/.test(verb || '') || verb === 'fork-command') process.exit(2);
const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./${verb}.mjs`, import.meta.url)), ...args], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
