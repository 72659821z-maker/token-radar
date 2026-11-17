// Local replica of the seven rows token-radar-01's sealed gate checks. The kit does not ship the
// server-side scorer (scorer/score.ts and reference/gate.json stay on make.fun's server), so this script
// re-implements the rules that are published in RULES.txt and validates a finished /output before it is
// handed over. It is a development aid, not a substitute for the server's check.
//
//   node tools/gate-check.mjs [--output C:/output] [--snapshot C:/input/snapshot.json]
//
// Exit 0 when all seven rows pass, 1 otherwise.

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const OUT = arg('output', process.platform === 'win32' ? 'C:/output' : '/output');
const SNAP = arg('snapshot', process.platform === 'win32' ? 'C:/input/snapshot.json' : '/input/snapshot.json');
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const rowsOut = [];
function pass(row, detail) { rowsOut.push({ row, ok: true, detail }); }
function fail(row, detail) { rowsOut.push({ row, ok: false, detail }); }

const snapshot = JSON.parse(readFileSync(SNAP, 'utf8'));
const protocolSlugs = new Set(snapshot.protocols.map((p) => p.slug));
const watchlist = snapshot.watchlist;

function walk(root, base = root, out = []) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const st = lstatSync(path);
    if (st.isDirectory()) {
      if (name.startsWith('.')) throw new Error(`dot-directory ${relative(base, path)}`);
      walk(path, base, out);
    } else if (st.isFile()) {
      out.push({ path: relative(base, path).replaceAll('\\', '/'), name, size: st.size, full: path });
    } else {
      throw new Error(`not a regular file: ${relative(base, path)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- dashboard_files
try {
  const dir = join(OUT, 'dashboard');
  const files = walk(dir);
  const names = new Set(files.map((f) => f.name));
  const hasHtml = files.some((f) => f.path === 'index.html');
  const css = files.filter((f) => f.name.endsWith('.css')).length;
  const js = files.filter((f) => f.name.endsWith('.js')).length;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (!hasHtml) throw new Error('no dashboard/index.html');
  if (css < 1) throw new Error('no .css file under dashboard/');
  if (js < 1) throw new Error('no .js file under dashboard/');
  if (files.length > 400) throw new Error(`${files.length} files, over 400`);
  if (bytes > 4 * 1024 * 1024) throw new Error(`${bytes} bytes, over 4 MiB`);
  for (const f of files) if (!NAME.test(f.name)) throw new Error(`bad name ${f.path}`);

  const address = /https?:\/\//i;
  const offence = (f, why) => new Error(`${f.path}: ${why}`);
  for (const f of files) {
    const text = readFileSync(f.full, 'utf8');
    if (f.name.endsWith('.html')) {
      const attr = /\s([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      for (const m of text.matchAll(attr)) {
        const value = m[2] ?? m[3] ?? m[4] ?? '';
        if (address.test(value)) throw offence(f, `attribute ${m[1]} names a network address`);
      }
      for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        if (address.test(m[1])) throw offence(f, 'a <style> body names a network address');
      }
    } else if (f.name.endsWith('.css')) {
      if (address.test(text)) throw offence(f, 'the CSS names a network address');
    } else if (f.name.endsWith('.js') || f.name.endsWith('.mjs')) {
      const specifiers = [
        /(?:^|[^\w$])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];
      for (const re of specifiers) {
        for (const m of text.matchAll(re)) if (address.test(m[1])) throw offence(f, `import specifier ${m[1]} is a network address`);
      }
    }
  }
  const sourceBytes = files.filter((f) => /\.(?:html|css|js|json|mjs|svg|md|txt)$/.test(f.name)).reduce((n, f) => n + f.size, 0);
  pass('dashboard_files', `${files.length} files, ${bytes} bytes; index.html + ${css} css + ${js} js; no network address in attributes, CSS or import specifiers; ${sourceBytes} source bytes`);
} catch (err) {
  fail('dashboard_files', err.message);
}

// ---------------------------------------------------------------- board_file
let board = null;
try {
  const raw = readFileSync(join(OUT, 'board.json'));
  if (raw.length > 8 * 1024 * 1024) throw new Error(`${raw.length} bytes, over 8 MiB`);
  const doc = JSON.parse(raw.toString('utf8'));
  const rows = Array.isArray(doc) ? doc : doc.rows;
  if (!Array.isArray(rows)) throw new Error('board.json has no rows array');
  if (rows.length < 100 || rows.length > 4000) throw new Error(`${rows.length} rows, outside 100..4000`);
  let badSlug = 0;
  for (const [i, r] of rows.entries()) {
    if (typeof r.slug !== 'string' || !protocolSlugs.has(r.slug)) { badSlug++; if (badSlug < 4) throw new Error(`row ${i + 1} slug ${JSON.stringify(r.slug)} is not in the snapshot`); }
    if (typeof r.name !== 'string' || r.name.length === 0) throw new Error(`row ${i + 1} has no name`);
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) throw new Error(`row ${i + 1} has rank ${r.rank}`);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) throw new Error(`row ${i + 1} has implied value ${r.implied_value_usd}`);
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) throw new Error(`row ${i + 1} has ${Array.isArray(r.farm_steps) ? r.farm_steps.length : 'no'} farm steps`);
    for (const s of r.farm_steps) {
      if (typeof s !== 'string') throw new Error(`row ${i + 1} has a non-string farm step`);
      const n = s.trim().length;
      if (n < 20 || n > 600) throw new Error(`row ${i + 1} has a farm step of ${n} characters`);
    }
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length >= 2 && values.size === 1) throw new Error('every row has the same implied value');
  board = rows;
  pass('board_file', `${rows.length} rows, ${raw.length} bytes; every slug in the snapshot, unique ranks, farm steps 3..12 of 20..600 characters`);
} catch (err) {
  fail('board_file', err.message);
}

// ---------------------------------------------------------------- sorted_by_value
try {
  if (!board) throw new Error('board.json is not readable');
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) throw new Error(`rank ${i + 1} is ${ranks[i]}`);
  for (let i = 1; i < board.length; i++) if (board[i].implied_value_usd > board[i - 1].implied_value_usd) throw new Error(`row ${i + 1} outranks row ${i} on implied value`);
  const values = [...new Set(board.map((r) => r.implied_value_usd))];
  if (values.length === 1) throw new Error('all implied values are equal');
  pass('sorted_by_value', `ranks 1..${board.length} once each; implied value non-increasing; ${values.length} distinct values`);
} catch (err) {
  fail('sorted_by_value', err.message);
}

// ---------------------------------------------------------------- coverage
try {
  if (!board) throw new Error('board.json is not readable');
  const slugs = new Set(board.map((r) => r.slug));
  const missing = watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) throw new Error(`missing ${missing.length}: ${missing.slice(0, 6).join(', ')}`);
  pass('coverage', `${watchlist.length}/${watchlist.length} watchlist slugs present; ${board.length - watchlist.length} rows outside the watchlist`);
} catch (err) {
  fail('coverage', err.message);
}

// ---------------------------------------------------------------- farm_steps
try {
  if (!board) throw new Error('board.json is not readable');
  let total = 0;
  for (const r of board) {
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) throw new Error(`${r.slug}: ${r.farm_steps && r.farm_steps.length} steps`);
    for (const s of r.farm_steps) {
      const n = String(s).trim().length;
      if (n < 20 || n > 600) throw new Error(`${r.slug}: a step of ${n} characters`);
      total++;
    }
  }
  pass('farm_steps', `${total} steps across ${board.length} rows; every row 3..12 steps, every step 20..600 characters trimmed`);
} catch (err) {
  fail('farm_steps', err.message);
}

// ---------------------------------------------------------------- screenshots
function pngInfo(bytes) {
  if (bytes.length < 33) return null;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const tail = bytes.subarray(bytes.length - 12);
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  for (let i = 0; i < 12; i++) if (tail[i] !== iend[i]) return null;
  return { width, height };
}
try {
  const dir = join(OUT, 'screenshots');
  const files = readdirSync(dir).filter((n) => !n.startsWith('.'))
    .map((n) => ({ name: n, size: statSync(join(dir, n)).size, full: join(dir, n) }))
    .filter((f) => statSync(f.full).isFile())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (files.length < 3 || files.length > 4) throw new Error(`${files.length} images, outside 3..4`);
  const details = [];
  for (const f of files) {
    if (!NAME.test(f.name)) throw new Error(`bad name ${f.name}`);
    if (f.size > 524288) throw new Error(`${f.name} is ${f.size} bytes, over 512 KiB`);
    const info = pngInfo(readFileSync(f.full));
    if (!info) throw new Error(`${f.name} is not a whole PNG`);
    const long = Math.max(info.width, info.height);
    const short = Math.min(info.width, info.height);
    if (long > 1440) throw new Error(`${f.name} long side ${long} > 1440`);
    if (short < 800) throw new Error(`${f.name} short side ${short} < 800`);
    details.push(`${f.name} ${info.width}x${info.height} ${Math.round(f.size / 1024)}KB`);
  }
  pass('screenshots', details.join('; '));
} catch (err) {
  fail('screenshots', err.message);
}

// ---------------------------------------------------------------- dossier_matches
try {
  const path = join(OUT, 'dossier.json');
  const written = readFileSync(path);
  if (written.length > 1.5 * 1024 * 1024) throw new Error(`${written.length} bytes, over 1.5 MiB`);
  const rebuilt = buildDossier(OUT, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  const same = written.length === rebuilt.length && Buffer.compare(written, rebuilt) === 0;
  if (!same) throw new Error(`dossier.json is ${written.length} bytes, buildDossier writes ${rebuilt.length}; bytes differ`);
  const doc = JSON.parse(written.toString('utf8'));
  pass('dossier_matches', `${written.length} bytes byte-for-byte; ${doc.images.length} images, text ${Buffer.byteLength(doc.text, 'utf8')} bytes`);
} catch (err) {
  fail('dossier_matches', err.message);
}

// ---------------------------------------------------------------- report
process.stdout.write(`Token Radar output gate — local replica of the seven scorer rows\n`);
process.stdout.write(`output: ${OUT}\nsnapshot: ${SNAP}\n\n`);
for (const r of rowsOut) {
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.row.padEnd(18)} ${r.detail}\n`);
}
const failures = rowsOut.filter((r) => !r.ok).length;
process.stdout.write(`\n${failures === 0 ? `RESULT all ${rowsOut.length} rows pass` : `RESULT ${rowsOut.length - failures}/${rowsOut.length} pass, ${failures} fail`}\n`);
process.exit(failures === 0 ? 0 : 1);
