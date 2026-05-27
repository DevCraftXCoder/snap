'use strict';

/**
 * snap-helper.cjs — Filesystem engine for the /snap Claude Code skill.
 * Handles cache lifecycle, alias persistence, index edits, and correlation-scope resolution.
 *
 * Usage: node C:/Za/.claude/scripts/snap-helper.cjs <subcommand> [flags]
 *
 * Flags: --name <n>  --force  --repo <alias>  --topic <alias>
 *        --dry  --hash <h>  --summary <text>  --analysis <json-path>  --confirm
 *
 * Output: single JSON object to stdout. Human-readable status to stderr.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT      = 'C:\\Za';
const SNAP_ROOT      = path.join(REPO_ROOT, '.snap');
const CONFIG_PATH    = path.join(SNAP_ROOT, 'config.json');
const CACHE_DIR      = path.join(SNAP_ROOT, 'cache');
const ALIASES_DIR    = path.join(SNAP_ROOT, 'aliases');
const ARCHIVE_DIR    = path.join(SNAP_ROOT, 'archive');
const LOCK_DIR       = path.join(SNAP_ROOT, '.lock');

const SCREENSHOTS_DIR = path.join(
  process.env.USERPROFILE || 'C:\\Users\\J',
  'Pictures', 'Screenshots'
);

const PROJECT_ALIASES_MD = path.join(REPO_ROOT, '.claude', 'rules', 'project-aliases.md');

const LOCKED_CONFIG = {
  cacheDir: '.snap/cache',
  aliasDir: '.snap/aliases',
  maxCacheAgeHours: 24,
  maxUnnamedSnaps: 50,
  maxImageSizeMB: 1,
  dedupeByHash: true,
  archiveUnusedAliasesAfterDays: 90,
  deleteRawAfterAnalysis: true,
  keepThumbnail: true
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function log(msg) {
  process.stderr.write('[snap-helper] ' + msg + '\n');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return LOCKED_CONFIG;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return LOCKED_CONFIG;
  }
}

/** Parse CLI flags into an options object */
function parseArgs(argv) {
  const opts = {
    name: null,
    force: false,
    repo: [],
    topic: [],
    dry: false,
    confirm: false,
    hash: null,
    summary: null,
    analysisPath: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force')   { opts.force   = true; }
    else if (a === '--dry')     { opts.dry     = true; }
    else if (a === '--confirm') { opts.confirm = true; }
    else if (a === '--name'   && argv[i+1]) { opts.name         = argv[++i]; }
    else if (a === '--hash'   && argv[i+1]) { opts.hash         = argv[++i]; }
    else if (a === '--summary'&& argv[i+1]) { opts.summary      = argv[++i]; }
    else if (a === '--analysis'&& argv[i+1]){ opts.analysisPath  = argv[++i]; }
    else if (a === '--repo'   && argv[i+1]) { opts.repo.push(argv[++i]); }
    else if (a === '--topic'  && argv[i+1]) { opts.topic.push(argv[++i]); }
  }
  return opts;
}

/** Validate alias name: no /, \, .., whitespace, leading symbol. */
function validateName(name) {
  if (!name) return 'name is required';
  if (/[/\\]/.test(name))      return 'invalid-name: contains path separators';
  if (/\.\./.test(name))       return 'invalid-name: contains ".."';
  if (/\s/.test(name))         return 'invalid-name: contains whitespace';
  if (/^[^a-zA-Z0-9_]/.test(name)) return 'invalid-name: must start with letter, digit, or underscore';
  return null;
}

/** Recursively compute directory size in bytes and file count. */
function dirStats(dir) {
  let bytes = 0;
  let count = 0;
  if (!fs.existsSync(dir)) return { bytes, count };
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = dirStats(full);
      bytes += sub.bytes;
      count += sub.count;
    } else {
      try {
        bytes += fs.statSync(full).size;
        count++;
      } catch (_) {}
    }
  }
  return { bytes, count };
}

/**
 * Advisory file lock using mkdir (atomic on all platforms).
 * Times out after 5s and proceeds anyway.
 */
function acquireLock(timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      // Spin-wait 50ms
      const until = Date.now() + 50;
      while (Date.now() < until) { /* busy wait — tiny loop only in lock contention */ }
    }
  }
  log('Lock timeout — proceeding anyway');
  return false;
}

function releaseLock() {
  try { fs.rmdirSync(LOCK_DIR); } catch (_) {}
}

/**
 * Parse PNG width/height from IHDR chunk.
 * IHDR starts at byte 8 (PNG signature). After signature:
 *   4 bytes length, 4 bytes "IHDR", then 4 width, 4 height (big-endian)
 */
function parsePNGDimensions(buf) {
  // PNG signature: 8 bytes, then IHDR chunk: 4-byte len + "IHDR" + 4 width + 4 height
  if (buf.length < 24) return null;
  // Signature check: \x89PNG\r\n\x1a\n
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  // IHDR: length at byte 8 (4 bytes), type at 12 ("IHDR"), data at 16
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w > 0 && h > 0) return { w, h };
  return null;
}

/**
 * Parse JPEG width/height by scanning for SOF0 marker (0xFF 0xC0).
 * SOF marker: FF Cn (n=0..3,5..7,9..11,13..15), then 2-byte length,
 * 1 byte precision, 2-byte height, 2-byte width.
 */
function parseJPEGDimensions(buf) {
  // SOF markers: 0xC0..0xC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF
  const sofMarkers = new Set([
    0xC0, 0xC1, 0xC2, 0xC3,
    0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB,
    0xCD, 0xCE, 0xCF
  ]);
  let i = 2; // skip SOI marker (FF D8)
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (sofMarkers.has(marker)) {
      // length (2) + precision (1) + height (2) + width (2) — offset from marker
      if (i + 9 < buf.length) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        if (w > 0 && h > 0) return { w, h };
      }
    }
    // Skip this segment: length is at i+2 (2 bytes, includes the 2-byte length field itself)
    if (i + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return null;
}

/** Read file header and extract dimensions. */
function getImageDimensions(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(512);
    fs.readSync(fd, header, 0, 512, 0);
    fs.closeSync(fd);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') return parsePNGDimensions(header);
    if (ext === '.jpg' || ext === '.jpeg') {
      // Need more bytes for JPEG — read up to 64KB to find SOF
      const fullBuf = fs.readFileSync(filePath);
      return parseJPEGDimensions(fullBuf);
    }
  } catch (_) {}
  return null;
}

/**
 * Compute SHA-256 of a file, return first 16 hex chars.
 */
function fileHash16(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Try to recompress a PNG using zlib (Node-native, no external deps).
 * Reads the raw PNG, deflates IDAT chunks at max compression, reassembles.
 * If result is larger or fails, returns original bytes.
 */
function recompressPNG(srcPath) {
  const original = fs.readFileSync(srcPath);
  const ext = path.extname(srcPath).toLowerCase();
  if (ext !== '.png') return original;

  try {
    // Parse PNG chunks, recompress IDAT data
    const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!original.slice(0, 8).equals(SIG)) return original;

    const chunks = [];
    let pos = 8;
    const idatBufs = [];

    while (pos < original.length) {
      const len    = original.readUInt32BE(pos);
      const type   = original.slice(pos + 4, pos + 8).toString('ascii');
      const data   = original.slice(pos + 8, pos + 8 + len);
      const crc    = original.slice(pos + 8 + len, pos + 12 + len);
      pos += 12 + len;

      if (type === 'IDAT') {
        idatBufs.push(data);
      } else {
        chunks.push({ type, data, crc });
      }
    }

    if (idatBufs.length === 0) return original;

    // Concatenate all IDAT, decompress, recompress at max level
    const raw   = Buffer.concat(idatBufs);
    const decompressed = zlib.inflateSync(raw);
    const recompressed = zlib.deflateSync(decompressed, { level: 9 });

    // Compute CRC32 for a chunk
    function crc32(type, data) {
      const buf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      // Node's zlib doesn't expose crc32 — use the standard poly manually
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let k = 0; k < 8; k++) {
          crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
      }
      crc ^= 0xFFFFFFFF;
      const out = Buffer.alloc(4);
      out.writeUInt32BE(crc >>> 0, 0);
      return out;
    }

    // Build output: signature + all non-IDAT chunks + single IDAT + IEND
    const parts = [SIG];
    for (const ch of chunks) {
      if (ch.type === 'IEND') continue; // will append at end
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(ch.data.length, 0);
      parts.push(lenBuf, Buffer.from(ch.type, 'ascii'), ch.data, ch.crc);
    }

    // New IDAT
    {
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(recompressed.length, 0);
      const crcBuf = crc32('IDAT', recompressed);
      parts.push(lenBuf, Buffer.from('IDAT', 'ascii'), recompressed, crcBuf);
    }

    // IEND
    {
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(0, 0);
      const crcBuf = crc32('IEND', Buffer.alloc(0));
      parts.push(lenBuf, Buffer.from('IEND', 'ascii'), crcBuf);
    }

    const result = Buffer.concat(parts);
    return result.length < original.length ? result : original;
  } catch (_) {
    return original;
  }
}

/**
 * Find all hash files in cache (by looking for .meta.json files).
 * Returns array of { hash, created, metaPath }
 */
function listCacheEntries() {
  const entries = [];
  if (!fs.existsSync(CACHE_DIR)) return entries;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith('.meta.json')) continue;
    const hash = f.replace('.meta.json', '');
    const metaPath = path.join(CACHE_DIR, f);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      entries.push({ hash, created: meta.created || 0, metaPath, meta });
    } catch (_) {}
  }
  return entries;
}

/**
 * Compute bytes freed by deleting a set of hashes from cache.
 * Deletes .summary.txt, .meta.json, and any raw image file.
 */
function evictCacheHashes(hashes) {
  let freed = 0;
  for (const hash of hashes) {
    for (const ext of ['.summary.txt', '.meta.json', '.png', '.jpg', '.jpeg']) {
      const p = path.join(CACHE_DIR, hash + ext);
      if (fs.existsSync(p)) {
        try {
          freed += fs.statSync(p).size;
          fs.unlinkSync(p);
        } catch (_) {}
      }
    }
  }
  return freed;
}

/**
 * Atomically update the project-aliases.md index.
 * Inserts the ## ! Visual Snapshots section before ## Rules if missing.
 * Adds or updates the row for the given alias name.
 */
function updateAliasesIndex(aliasName, analysisAbsPath, createdDate) {
  const lockAcquired = acquireLock(5000);
  try {
    if (!fs.existsSync(PROJECT_ALIASES_MD)) {
      log('project-aliases.md not found — skipping index update');
      return false;
    }

    let content = fs.readFileSync(PROJECT_ALIASES_MD, 'utf8');
    const SECTION_HEADER = '## ! Visual Snapshots';
    const SECTION_INTRO = [
      '',
      '## ! Visual Snapshots',
      '',
      '`!` = visual snapshot reference. Each entry points to a cached UI analysis. Re-analyze vs current code with `/snap !name`.',
      '',
      '| Alias | Analysis path | Created |',
      '|-------|---------------|---------|',
    ].join('\n');

    const newRow = `| !${aliasName} | ${analysisAbsPath} | ${createdDate} |`;

    if (!content.includes(SECTION_HEADER)) {
      // Insert section before ## Rules
      const rulesIdx = content.indexOf('\n## Rules');
      if (rulesIdx === -1) {
        // Append at end
        content = content + '\n' + SECTION_INTRO + '\n' + newRow + '\n';
      } else {
        content =
          content.slice(0, rulesIdx) +
          '\n' + SECTION_INTRO + '\n' + newRow + '\n' +
          content.slice(rulesIdx);
      }
    } else {
      // Section exists — find the table and update/insert the row
      const sectionStart = content.indexOf(SECTION_HEADER);
      // Find the table (lines starting with |)
      const afterHeader = content.indexOf('\n| ', sectionStart);
      if (afterHeader === -1) {
        // Table not found — append row after the header block
        const nextSection = content.indexOf('\n## ', sectionStart + 1);
        const insertAt = nextSection === -1 ? content.length : nextSection;
        const existingRow = '| !' + aliasName + ' |';
        if (content.includes(existingRow)) {
          // Update existing row
          content = content.replace(
            new RegExp(`\\| !${escapeRegex(aliasName)} \\|[^\\n]*`, 'g'),
            newRow
          );
        } else {
          content = content.slice(0, insertAt) + '\n' + newRow + content.slice(insertAt);
        }
      } else {
        // Find the end of the table (first non-| line after header)
        const existingRow = '| !' + aliasName + ' |';
        if (content.includes(existingRow)) {
          // Update in place
          content = content.replace(
            new RegExp(`\\| !${escapeRegex(aliasName)} \\|[^\\n]*`, 'g'),
            newRow
          );
        } else {
          // Append to table: find last | line in section
          let tableEnd = afterHeader;
          let searchFrom = afterHeader;
          while (true) {
            const nextPipe = content.indexOf('\n| ', searchFrom + 1);
            if (nextPipe === -1) break;
            // Make sure we're still in the same section
            const nextSection = content.indexOf('\n## ', searchFrom + 1);
            if (nextSection !== -1 && nextPipe > nextSection) break;
            tableEnd = nextPipe;
            searchFrom = nextPipe + 1;
          }
          // Insert after the last table row
          const lineEnd = content.indexOf('\n', tableEnd + 1);
          const insertAt = lineEnd === -1 ? content.length : lineEnd;
          content = content.slice(0, insertAt) + '\n' + newRow + content.slice(insertAt);
        }
      }
    }

    fs.writeFileSync(PROJECT_ALIASES_MD, content, 'utf8');
    return true;
  } finally {
    if (lockAcquired) releaseLock();
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Update index rows when archiving: mark alias row as archived
 * by appending " (archived)" to the path column, or remove the
 * row from the active section.
 * Spec says "remove from active table, or mark archived" — we mark.
 */
function markArchivedInIndex(names) {
  const lockAcquired = acquireLock(5000);
  try {
    if (!fs.existsSync(PROJECT_ALIASES_MD)) return;
    let content = fs.readFileSync(PROJECT_ALIASES_MD, 'utf8');
    for (const name of names) {
      content = content.replace(
        new RegExp(`(\\| !${escapeRegex(name)} \\| [^|]*)\\|`, 'g'),
        (match, prefix) => prefix.replace(/(archive|aliases)/g, m => m) + ' (archived)|'
      );
    }
    fs.writeFileSync(PROJECT_ALIASES_MD, content, 'utf8');
  } finally {
    if (lockAcquired) releaseLock();
  }
}

/** Read project-aliases.md and extract @alias → local path mappings */
function parseProjectAliases() {
  const repoAliases = {}; // '@Name' → path
  const topicAliases = {}; // '#Name' → [filePaths]

  if (!fs.existsSync(PROJECT_ALIASES_MD)) return { repoAliases, topicAliases };

  const content = fs.readFileSync(PROJECT_ALIASES_MD, 'utf8');
  const lines = content.split('\n');

  // Parse table rows — look for | @Alias | path | description |
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;

    // Repo alias row: first cell is @Name
    if (cells[0].startsWith('@')) {
      const alias = cells[0]; // '@FrxncoisLanding'
      // Try to find a local path in any cell: starts with C:\ or C:/
      for (const cell of cells) {
        const match = cell.match(/([A-Z]:[/\\][^\s,|]+)/);
        if (match) {
          repoAliases[alias] = match[1].replace(/\//g, '\\');
          break;
        }
        // Also look for sub-paths like 'packages/finos/...'
        const subMatch = cell.match(/^([a-zA-Z0-9_\-. ]+\/[a-zA-Z0-9_\-. /]+)\/?$/);
        if (subMatch) {
          repoAliases[alias] = path.join(REPO_ROOT, subMatch[1]);
          break;
        }
      }
    }

    // Topic alias row: first cell is #Name
    if (cells[0].startsWith('#')) {
      const alias = cells[0]; // '#SystemsTab'
      const paths = [];
      for (const cell of cells) {
        // Paths in the description column like 'components/admin/SystemsTab.tsx'
        const pathMatches = cell.match(/[a-zA-Z0-9_\-]+(?:\/[a-zA-Z0-9_\-. ]+)+\.[a-zA-Z]+/g);
        if (pathMatches) {
          for (const p of pathMatches) {
            paths.push(path.join(REPO_ROOT, p.trim()));
          }
        }
      }
      if (paths.length > 0) topicAliases[alias] = paths;
    }
  }

  return { repoAliases, topicAliases };
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

function cmdInit() {
  let created = false;

  for (const dir of [SNAP_ROOT, CACHE_DIR, ALIASES_DIR, ARCHIVE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
      log('Created: ' + dir);
    }
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(LOCKED_CONFIG, null, 2) + '\n', 'utf8');
    created = true;
    log('Wrote config.json');
  }

  return { ok: true, created, configPath: CONFIG_PATH };
}

function cmdPick(opts) {
  cmdInit();
  const cfg = loadConfig();

  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    return { ok: false, reason: 'no-folder' };
  }

  const files = fs.readdirSync(SCREENSHOTS_DIR)
    .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
    .map(f => {
      const full = path.join(SCREENSHOTS_DIR, f);
      try {
        return { file: full, mtime: fs.statSync(full).mtimeMs };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const newest = files[0];
  const ageMs  = Date.now() - newest.mtime;
  const ageMinutes = ageMs / 60000;

  if (!opts.force && ageMinutes > 10) {
    return { ok: false, reason: 'stale', newestAgeMinutes: Math.round(ageMinutes * 10) / 10 };
  }

  // Compute hash
  log('Hashing: ' + newest.file);
  const hash = fileHash16(newest.file);
  const ext  = path.extname(newest.file).toLowerCase();

  // Dedupe check — look in cache\ and aliases\
  if (cfg.dedupeByHash) {
    // Check cache
    const cachedRaw = path.join(CACHE_DIR, hash + ext);
    const cachedMeta = path.join(CACHE_DIR, hash + '.meta.json');
    if (fs.existsSync(cachedRaw) || fs.existsSync(cachedMeta)) {
      const existingPath = fs.existsSync(cachedRaw) ? cachedRaw : cachedMeta;
      log('Dedupe: found in cache');
      return {
        ok: true,
        imagePath: fs.existsSync(cachedRaw) ? cachedRaw : null,
        hash,
        ageMinutes: Math.round(ageMinutes * 10) / 10,
        deduped: true,
        existing: { scope: 'cache', path: existingPath },
        sourceFile: newest.file,
        resolution: getImageDimensions(newest.file)
      };
    }

    // Check aliases
    if (fs.existsSync(ALIASES_DIR)) {
      for (const name of fs.readdirSync(ALIASES_DIR)) {
        const metaPath = path.join(ALIASES_DIR, name, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            if (meta.analysisHash === hash) {
              log('Dedupe: found in alias ' + name);
              return {
                ok: true,
                imagePath: path.join(ALIASES_DIR, name, 'image.png'),
                hash,
                ageMinutes: Math.round(ageMinutes * 10) / 10,
                deduped: true,
                existing: { scope: 'alias:' + name, path: path.join(ALIASES_DIR, name) },
                sourceFile: newest.file,
                resolution: getImageDimensions(newest.file)
              };
            }
          } catch (_) {}
        }
      }
    }
  }

  // Copy raw file to cache
  const destPath = path.join(CACHE_DIR, hash + ext);
  fs.copyFileSync(newest.file, destPath);
  log('Copied to cache: ' + destPath);

  const resolution = getImageDimensions(destPath);

  return {
    ok: true,
    imagePath: destPath,
    hash,
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    deduped: false,
    sourceFile: newest.file,
    resolution
  };
}

function cmdAnalyzePrep(opts) {
  cmdInit();
  if (!opts.hash) return { ok: false, reason: '--hash is required' };

  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const p = path.join(CACHE_DIR, opts.hash + ext);
    if (fs.existsSync(p)) {
      return { ok: true, imagePath: p, hash: opts.hash };
    }
  }
  return { ok: false, reason: 'hash-not-found', hash: opts.hash };
}

function cmdPersistUnnamed(opts) {
  cmdInit();
  const cfg = loadConfig();
  if (!opts.hash)    return { ok: false, reason: '--hash is required' };
  if (!opts.summary) return { ok: false, reason: '--summary is required' };

  const summaryPath = path.join(CACHE_DIR, opts.hash + '.summary.txt');
  const metaPath    = path.join(CACHE_DIR, opts.hash + '.meta.json');

  // Find the raw image (any ext)
  let rawPath = null;
  let ext = null;
  for (const e of ['.png', '.jpg', '.jpeg']) {
    const p = path.join(CACHE_DIR, opts.hash + e);
    if (fs.existsSync(p)) { rawPath = p; ext = e; break; }
  }

  // Write summary
  fs.writeFileSync(summaryPath, opts.summary, 'utf8');

  // Write / update meta
  let existingMeta = {};
  if (fs.existsSync(metaPath)) {
    try { existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
  }

  const resolution = rawPath ? getImageDimensions(rawPath) : null;
  const sizeBytes  = rawPath ? fs.statSync(rawPath).size : 0;

  const meta = Object.assign({}, existingMeta, {
    hash:       opts.hash,
    created:    existingMeta.created || new Date().toISOString(),
    resolution,
    sizeBytes
  });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // Delete raw image if configured
  if (cfg.deleteRawAfterAnalysis && rawPath && fs.existsSync(rawPath)) {
    fs.unlinkSync(rawPath);
    log('Deleted raw: ' + rawPath);
  }

  // Enforce maxUnnamedSnaps (50)
  const allEntries = listCacheEntries()
    .sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

  const evicted = [];
  while (allEntries.length > cfg.maxUnnamedSnaps) {
    const oldest = allEntries.shift();
    if (oldest.hash === opts.hash) continue; // don't evict what we just wrote
    evictCacheHashes([oldest.hash]);
    evicted.push(oldest.hash);
    log('Evicted oldest: ' + oldest.hash);
  }

  return { ok: true, summaryPath, evicted };
}

function cmdPersistAlias(opts) {
  cmdInit();
  const cfg = loadConfig();

  if (!opts.name)         return { ok: false, reason: '--name is required' };
  if (!opts.hash)         return { ok: false, reason: '--hash is required' };
  if (!opts.analysisPath) return { ok: false, reason: '--analysis <json-path> is required' };

  const nameErr = validateName(opts.name);
  if (nameErr) return { ok: false, reason: nameErr };

  if (!fs.existsSync(opts.analysisPath)) {
    return { ok: false, reason: 'analysis file not found: ' + opts.analysisPath };
  }

  const aliasDir = path.join(ALIASES_DIR, opts.name);
  const isOverwrite = fs.existsSync(aliasDir);
  if (!isOverwrite) {
    fs.mkdirSync(aliasDir, { recursive: true });
  }

  // Find the cached raw image
  let rawPath = null;
  let rawExt  = '.png';
  for (const e of ['.png', '.jpg', '.jpeg']) {
    const p = path.join(CACHE_DIR, opts.hash + e);
    if (fs.existsSync(p)) { rawPath = p; rawExt = e; break; }
  }

  // Also check if raw was already deleted — use any existing alias image
  const existingImage = path.join(aliasDir, 'image.png');

  const imageDest = path.join(aliasDir, 'image.png');
  let oversized = false;
  const maxBytes = cfg.maxImageSizeMB * 1024 * 1024;

  if (rawPath) {
    const rawSize = fs.statSync(rawPath).size;
    if (rawExt === '.png') {
      const compressed = recompressPNG(rawPath);
      if (compressed.length <= maxBytes) {
        fs.writeFileSync(imageDest, compressed);
      } else {
        // Use the smaller of original vs compressed
        const smaller = compressed.length < rawSize ? compressed : fs.readFileSync(rawPath);
        fs.writeFileSync(imageDest, smaller);
        oversized = smaller.length > maxBytes;
      }
    } else {
      // JPEG — just copy
      fs.copyFileSync(rawPath, imageDest);
      oversized = rawSize > maxBytes;
    }
    log('Wrote alias image: ' + imageDest + (oversized ? ' [oversized]' : ''));
    // Delete raw from cache now that it's safely copied to the alias dir.
    // This keeps the named flow self-contained (no need to call persist-unnamed first).
    try { fs.unlinkSync(rawPath); log('Deleted raw cache image: ' + rawPath); } catch (_) {}
  } else if (isOverwrite && fs.existsSync(existingImage)) {
    // Reuse existing image (raw was already deleted after unnamed analysis)
    log('Reusing existing image (raw was deleted after analysis)');
  } else {
    log('Warning: no raw image found for hash ' + opts.hash + ' — image.png will be absent');
  }

  // Write thumb.png (copy of image.png)
  const thumbDest = path.join(aliasDir, 'thumb.png');
  if (fs.existsSync(imageDest)) {
    fs.copyFileSync(imageDest, thumbDest);
    log('Wrote thumb.png');
  }

  // Load existing meta to preserve created date on overwrite
  const metaDest = path.join(aliasDir, 'meta.json');
  let existingMeta = {};
  if (isOverwrite && fs.existsSync(metaDest)) {
    try { existingMeta = JSON.parse(fs.readFileSync(metaDest, 'utf8')); } catch (_) {}
  }

  // Get source file from cache meta
  let sourceFile = null;
  const cacheMeta = path.join(CACHE_DIR, opts.hash + '.meta.json');
  if (fs.existsSync(cacheMeta)) {
    try { sourceFile = JSON.parse(fs.readFileSync(cacheMeta, 'utf8')).sourceFile; } catch (_) {}
  }

  const resolution = fs.existsSync(imageDest) ? getImageDimensions(imageDest) : null;
  const now = new Date().toISOString();
  const createdDate = existingMeta.created || now;

  const meta = {
    alias:         opts.name,
    created:       createdDate,
    lastUsed:      now,
    sourceFile,
    resolution,
    analysisHash:  opts.hash,
    pinned:        existingMeta.pinned || false,
    oversized:     oversized || undefined
  };
  if (!oversized) delete meta.oversized;

  fs.writeFileSync(metaDest, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // Copy analysis JSON
  const analysisDest = path.join(aliasDir, 'analysis.json');
  fs.copyFileSync(opts.analysisPath, analysisDest);
  log('Wrote analysis.json');

  // Update project-aliases.md index
  const createdDateShort = createdDate.slice(0, 10);
  const indexUpdated = updateAliasesIndex(opts.name, analysisDest, createdDateShort);

  const result = {
    ok: true,
    aliasDir,
    imagePath: fs.existsSync(imageDest) ? imageDest : null,
    analysisPath: analysisDest,
    indexUpdated
  };
  if (oversized) result.oversized = true;
  return result;
}

function cmdRecall(opts) {
  cmdInit();
  if (!opts.name) return { ok: false, reason: '--name is required' };

  const nameErr = validateName(opts.name);
  if (nameErr) return { ok: false, reason: nameErr };

  // Check aliases first
  const aliasDir = path.join(ALIASES_DIR, opts.name);
  if (fs.existsSync(aliasDir)) {
    const metaPath   = path.join(aliasDir, 'meta.json');
    const imagePath  = path.join(aliasDir, 'image.png');
    const analysisPath = path.join(aliasDir, 'analysis.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
      meta.lastUsed = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
    return {
      ok: true,
      aliasDir,
      imagePath:    fs.existsSync(imagePath)    ? imagePath    : null,
      analysisPath: fs.existsSync(analysisPath) ? analysisPath : null,
      meta
    };
  }

  // Check archive
  const archiveDir = path.join(ARCHIVE_DIR, opts.name);
  if (fs.existsSync(archiveDir)) {
    const metaPath    = path.join(archiveDir, 'meta.json');
    const imagePath   = path.join(archiveDir, 'image.png');
    const analysisPath = path.join(archiveDir, 'analysis.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
      meta.lastUsed = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
    return {
      ok: true,
      aliasDir: archiveDir,
      imagePath:    fs.existsSync(imagePath)    ? imagePath    : null,
      analysisPath: fs.existsSync(analysisPath) ? analysisPath : null,
      meta,
      archived: true
    };
  }

  // Not found — suggest nearby names
  const suggestions = [];
  for (const dir of [ALIASES_DIR, ARCHIVE_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      // Simple edit-distance: startsWith or endsWith or substring
      if (
        name.toLowerCase().includes(opts.name.toLowerCase()) ||
        opts.name.toLowerCase().includes(name.toLowerCase())
      ) {
        suggestions.push(name);
      }
    }
  }

  return { ok: false, reason: 'not-found', suggestions };
}

function cmdList() {
  cmdInit();
  const aliases = [];

  for (const [baseDir, archived] of [[ALIASES_DIR, false], [ARCHIVE_DIR, true]]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const name of fs.readdirSync(baseDir)) {
      const dir = path.join(baseDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, 'meta.json');
      let meta = {};
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
      }
      const sizeBytes = dirStats(dir).bytes;
      aliases.push({
        name,
        lastUsed: meta.lastUsed || meta.created || null,
        sizeBytes,
        pinned:   meta.pinned || false,
        archived
      });
    }
  }

  aliases.sort((a, b) => {
    const ta = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const tb = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return tb - ta;
  });

  return { ok: true, aliases };
}

function cmdClean() {
  cmdInit();
  const cfg = loadConfig();
  const maxAgeMs = cfg.maxCacheAgeHours * 3600 * 1000;
  const now = Date.now();

  const entries = listCacheEntries()
    .sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

  const toDelete = [];

  // Delete by age
  for (const e of entries) {
    const age = now - new Date(e.created).getTime();
    if (age > maxAgeMs) {
      toDelete.push(e.hash);
    }
  }

  // Enforce maxUnnamedSnaps (oldest-first for remaining)
  const remaining = entries.filter(e => !toDelete.includes(e.hash));
  while (remaining.length > cfg.maxUnnamedSnaps) {
    const oldest = remaining.shift();
    toDelete.push(oldest.hash);
  }

  const freed = evictCacheHashes(toDelete);
  log('Cleaned ' + toDelete.length + ' entries, freed ' + freed + ' bytes');

  return { ok: true, deleted: toDelete, freedBytes: freed };
}

function cmdCacheStatus() {
  cmdInit();
  const cacheStats   = dirStats(CACHE_DIR);
  const aliasStats   = dirStats(ALIASES_DIR);
  const archiveStats = dirStats(ARCHIVE_DIR);
  const totalBytes   = cacheStats.bytes + aliasStats.bytes + archiveStats.bytes;

  return {
    ok: true,
    sections: {
      cache:   { bytes: cacheStats.bytes,   count: cacheStats.count },
      aliases: { bytes: aliasStats.bytes,   count: aliasStats.count },
      archive: { bytes: archiveStats.bytes, count: archiveStats.count }
    },
    totalBytes
  };
}

function cmdPin(opts) {
  cmdInit();
  if (!opts.name) return { ok: false, reason: '--name is required' };

  const nameErr = validateName(opts.name);
  if (nameErr) return { ok: false, reason: nameErr };

  const metaPath = path.join(ALIASES_DIR, opts.name, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    return { ok: false, reason: 'alias not found: ' + opts.name };
  }

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
  meta.pinned = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  log('Pinned: ' + opts.name);

  return { ok: true, name: opts.name, pinned: true };
}

function cmdArchiveOld(opts) {
  cmdInit();
  const cfg = loadConfig();
  const thresholdMs = cfg.archiveUnusedAliasesAfterDays * 24 * 3600 * 1000;
  const now = Date.now();

  const archived     = [];
  const skippedPinned = [];

  if (!fs.existsSync(ALIASES_DIR)) {
    return { ok: true, archived, skippedPinned };
  }

  const names = fs.readdirSync(ALIASES_DIR).filter(n =>
    fs.statSync(path.join(ALIASES_DIR, n)).isDirectory()
  );

  for (const name of names) {
    const metaPath = path.join(ALIASES_DIR, name, 'meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
    }

    if (meta.pinned) {
      skippedPinned.push(name);
      continue;
    }

    const lastUsed = meta.lastUsed || meta.created;
    if (!lastUsed) {
      // No usage info — consider it old
    } else {
      const age = now - new Date(lastUsed).getTime();
      if (age <= thresholdMs) continue;
    }

    if (opts.dry) {
      archived.push(name);
      continue;
    }

    // Move to archive
    const srcDir  = path.join(ALIASES_DIR, name);
    const destDir = path.join(ARCHIVE_DIR, name);
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

    // If archive already exists with same name, overwrite
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.renameSync(srcDir, destDir);
    archived.push(name);
    log('Archived: ' + name);
  }

  if (!opts.dry && archived.length > 0) {
    markArchivedInIndex(archived);
  }

  return { ok: true, archived, skippedPinned };
}

function cmdCorrelateScope(opts) {
  cmdInit();

  const DEFAULT_ROOTS = [
    path.join(REPO_ROOT, 'francois-landing', 'components'),
    path.join(REPO_ROOT, 'francois-landing', 'app'),
    path.join(REPO_ROOT, 'packages', 'finos', 'apps', 'web'),
    path.join(REPO_ROOT, 'EV Betta', 'ev-betta-ui')
  ];

  const GLOB_PATTERNS = ['**/*.tsx', '**/*.module.css', '**/globals.css'];

  if (opts.repo.length === 0 && opts.topic.length === 0) {
    return {
      ok: true,
      searchRoots: DEFAULT_ROOTS,
      globPatterns: GLOB_PATTERNS,
      topicHints: []
    };
  }

  const { repoAliases, topicAliases } = parseProjectAliases();

  const searchRoots = [];
  for (const repoAlias of opts.repo) {
    // Normalize: add @ if missing
    const key = repoAlias.startsWith('@') ? repoAlias : '@' + repoAlias;
    if (repoAliases[key]) {
      searchRoots.push(repoAliases[key]);
    } else {
      log('Unknown repo alias: ' + key);
      return { ok: false, reason: 'unknown-repo', alias: key };
    }
  }

  if (searchRoots.length === 0) {
    searchRoots.push(...DEFAULT_ROOTS);
  }

  const topicHints = [];
  for (const topicAlias of opts.topic) {
    const key = topicAlias.startsWith('#') ? topicAlias : '#' + topicAlias;
    const paths = topicAliases[key];
    if (paths) {
      topicHints.push(...paths);
    } else {
      log('Unknown topic alias: ' + key + ' — continuing without it');
    }
  }

  return {
    ok: true,
    searchRoots,
    globPatterns: GLOB_PATTERNS,
    topicHints
  };
}

function cmdPrune(opts) {
  cmdInit();
  const cfg = loadConfig();

  // Compute what clean would do
  const maxAgeMs = cfg.maxCacheAgeHours * 3600 * 1000;
  const now = Date.now();

  const entries = listCacheEntries()
    .sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

  const wouldDelete = [];
  let freedBytes = 0;

  for (const e of entries) {
    const age = now - new Date(e.created).getTime();
    if (age > maxAgeMs) {
      wouldDelete.push({ hash: e.hash, reason: 'expired (>' + cfg.maxCacheAgeHours + 'h)' });
    }
  }

  const remaining = entries.filter(e => !wouldDelete.find(d => d.hash === e.hash));
  while (remaining.length > cfg.maxUnnamedSnaps) {
    const oldest = remaining.shift();
    wouldDelete.push({ hash: oldest.hash, reason: 'over maxUnnamedSnaps limit' });
  }

  // Compute freed bytes from cache deletions
  for (const d of wouldDelete) {
    for (const ext of ['.summary.txt', '.meta.json', '.png', '.jpg', '.jpeg']) {
      const p = path.join(CACHE_DIR, d.hash + ext);
      if (fs.existsSync(p)) {
        try { freedBytes += fs.statSync(p).size; } catch (_) {}
      }
    }
  }

  // Compute what archive-old would do
  const thresholdMs = cfg.archiveUnusedAliasesAfterDays * 24 * 3600 * 1000;
  const wouldArchive = [];

  if (fs.existsSync(ALIASES_DIR)) {
    for (const name of fs.readdirSync(ALIASES_DIR)) {
      if (!fs.statSync(path.join(ALIASES_DIR, name)).isDirectory()) continue;
      const metaPath = path.join(ALIASES_DIR, name, 'meta.json');
      let meta = {};
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
      }
      if (meta.pinned) continue;
      const lastUsed = meta.lastUsed || meta.created;
      if (lastUsed) {
        const age = now - new Date(lastUsed).getTime();
        if (age <= thresholdMs) continue;
      }
      wouldArchive.push({
        name,
        reason: 'unused >' + cfg.archiveUnusedAliasesAfterDays + ' days'
      });
    }
  }

  const dryRun = !opts.confirm;

  if (!dryRun) {
    // Execute both operations
    const cleanResult    = cmdClean();
    const archiveResult  = cmdArchiveOld({ dry: false });
    return {
      ok: true,
      dryRun: false,
      deleted: cleanResult.deleted,
      archived: archiveResult.archived,
      freedBytes: cleanResult.freedBytes
    };
  }

  return {
    ok: true,
    dryRun: true,
    wouldDelete,
    wouldArchive,
    wouldFreeBytes: freedBytes
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const argv    = process.argv.slice(2);
const subcmd  = argv[0];
const opts    = parseArgs(argv.slice(1));

switch (subcmd) {
  case 'init':
    out(cmdInit());
    break;
  case 'pick':
    out(cmdPick(opts));
    break;
  case 'analyze-prep':
    out(cmdAnalyzePrep(opts));
    break;
  case 'persist-unnamed':
    out(cmdPersistUnnamed(opts));
    break;
  case 'persist-alias':
    out(cmdPersistAlias(opts));
    break;
  case 'recall':
    out(cmdRecall(opts));
    break;
  case 'list':
    out(cmdList());
    break;
  case 'clean':
    out(cmdClean());
    break;
  case 'cache-status':
    out(cmdCacheStatus());
    break;
  case 'pin':
    out(cmdPin(opts));
    break;
  case 'archive-old':
    out(cmdArchiveOld(opts));
    break;
  case 'correlate-scope':
    out(cmdCorrelateScope(opts));
    break;
  case 'prune':
    out(cmdPrune(opts));
    break;
  default:
    out({
      ok: false,
      reason: 'unknown subcommand: ' + subcmd,
      available: [
        'init', 'pick', 'analyze-prep', 'persist-unnamed', 'persist-alias',
        'recall', 'list', 'clean', 'cache-status', 'pin',
        'archive-old', 'correlate-scope', 'prune'
      ]
    });
    process.exit(1);
}
