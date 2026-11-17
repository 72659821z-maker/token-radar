// Token Radar: a program/v1 entry for make.fun's token-radar-01 bounty.
//
// Node 22+, the standard library only. The program reads the sealed DefiLlama snapshot, scores every
// pre-token candidate with lib/model.ts, writes /output/board.json, writes the dashboard's data beside
// the page, copies this repository's dashboard/ and screenshots/ into /output, and writes
// /output/dossier.json with the vendored make.fun dossier library. Running it twice writes the same
// bytes: the model is deterministic, and the dossier is a pure function of the copied files.
//
// Paths. In the grader's container the input is /input/snapshot.json and the output is /output. On a
// Windows development machine those POSIX paths would resolve against the current drive, so the
// fallback is C:/input/snapshot.json and C:/output; it is the only place a drive letter appears.
// Override either with --input <file|dir>, --output <dir>, SNAPSHOT_PATH or OUTPUT_DIR.
//
//   node main.ts
//   node main.ts --input ./snapshot.json --output ./out
//   SNAPSHOT_PATH=./snapshot.json OUTPUT_DIR=./out node main.ts

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const WINDOWS = process.platform === 'win32';

/** The gate's caps: the text cap shapes the dossier bytes; the rest only refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const NAME_OK = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const defaultInput = process.env.SNAPSHOT_PATH ?? (WINDOWS ? 'C:/input/snapshot.json' : '/input/snapshot.json');
const inputArg = arg('input', defaultInput);
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or set SNAPSHOT_PATH\n`);
  process.exit(2);
}

const defaultOutput = process.env.OUTPUT_DIR ?? process.env.MAKEFUN_OUTPUT_DIR ?? (WINDOWS ? 'C:/output' : '/output');
const out = arg('output', defaultOutput);

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/**
 * Copy the regular files of `from` into `to`, recursively, skipping dot names. A file name the dossier
 * refuses stops the run: the gate would refuse the page anyway, and a quiet copy would hide why.
 */
function copyTree(from: string, to: string, base = from): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      copied.push(...copyTree(path, join(to, name), base));
      continue;
    }
    if (!st.isFile()) continue;
    if (!NAME_OK.test(name)) {
      process.stderr.write(`token radar: ${relative(here, path)}: a dashboard or screenshot name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
    copyFileSync(path, join(to, name));
    copied.push(relative(base, path).replaceAll('\\', '/'));
  }
  return copied;
}

const dashboardFiles = copyTree(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyTree(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > SCREENSHOT_CAPS.max) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}: hand in 3 or 4, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  const size = statSync(join(here, 'screenshots', name)).size;
  if (size > SCREENSHOT_CAPS.max_bytes) {
    process.stderr.write(`token radar: screenshots/${name} is ${size} bytes, over the 524288-byte cap\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} outside the watchlist, ${radar.live_size} live-token peers)\n` +
    `token radar: range $${board[board.length - 1]!.implied_value_usd.toLocaleString('en-US')} to $${board[0]!.implied_value_usd.toLocaleString('en-US')}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashboardFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
