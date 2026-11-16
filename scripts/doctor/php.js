// scripts/doctor/php.js
//
// Just enough PHP reading for the doctor's rules, without a real parser:
// walk a source tree, blank out comments/strings so brace matching is safe,
// find a function's body by name, split call arguments and resolve the
// callback named in add_action()/register_rest_route().
//
// "Masked" source keeps every character offset (comments and string contents
// become spaces), so an offset in the masked text is the same offset — and
// line — in the real file.

const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "tests", "test", "languages"]);

function walk(dir, re = /\.php$/, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walk(abs, re, acc);
    else if (re.test(name)) acc.push(abs);
  }
  return acc;
}

/**
 * Blanks comments (always) and string contents (when maskStrings) with spaces,
 * keeping newlines so offsets and line numbers survive.
 */
function mask(src, { maskStrings = true } = {}) {
  const out = src.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "#" && n !== "[") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      if (maskStrings) blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index of the bracket that closes the one at `open` (in masked text); -1 if none. */
function matchBracket(masked, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const o = masked[open];
  const c = pairs[o];
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === o) depth++;
    else if (masked[i] === c && --depth === 0) return i;
  }
  return -1;
}

/** Splits the text between a call's parens into top-level arguments (with offsets). */
function splitArgs(src, masked, openParen) {
  const close = matchBracket(masked, openParen);
  if (close === -1) return [];
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  for (let i = openParen + 1; i < close; i++) {
    const ch = masked[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      args.push({ text: src.slice(start, i).trim(), start });
      start = i + 1;
    }
  }
  const last = src.slice(start, close).trim();
  if (last) args.push({ text: last, start });
  return args;
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Loads every PHP file once: { rel, abs, src, masked, codeOnly }. */
function loadTree(dir) {
  return walk(dir).map((abs) => {
    const src = fs.readFileSync(abs, "utf8");
    return {
      abs,
      rel: path.relative(dir, abs).replace(/\\/g, "/"),
      src,
      masked: mask(src), // comments + string contents blanked
      codeOnly: mask(src, { maskStrings: false }), // comments blanked, strings kept
    };
  });
}

/**
 * All function/method definitions in the tree, indexed by name:
 * name -> [{ file, name, start, line, bodyStart, bodyEnd, body }].
 */
function indexFunctions(files) {
  const index = new Map();
  const re = /\bfunction\s+&?\s*([A-Za-z_]\w*)\s*\(/g;
  for (const file of files) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(file.masked))) {
      const paramsOpen = m.index + m[0].length - 1;
      const paramsClose = matchBracket(file.masked, paramsOpen);
      if (paramsClose === -1) continue;
      // Skip the return type; abstract/interface methods end with ';'.
      let k = paramsClose + 1;
      while (k < file.masked.length && file.masked[k] !== "{" && file.masked[k] !== ";") k++;
      if (file.masked[k] !== "{") continue;
      const bodyEnd = matchBracket(file.masked, k);
      if (bodyEnd === -1) continue;
      const def = {
        file,
        name: m[1],
        start: m.index,
        line: lineAt(file.src, m.index),
        bodyStart: k,
        bodyEnd,
        body: file.codeOnly.slice(k, bodyEnd + 1),
      };
      if (!index.has(def.name)) index.set(def.name, []);
      index.get(def.name).push(def);
    }
  }
  return index;
}

/**
 * Resolves a callback argument to { name } or { inline } (closure body).
 *   'my_func' | array( $this, 'm' ) | [ self::class, 'm' ] | 'Cls::m' | function () {…}
 */
function resolveCallback(arg, file) {
  const text = arg.text;
  if (/^(static\s+)?(function|fn)\b/.test(text)) {
    const brace = text.indexOf("{");
    if (brace !== -1) {
      const abs = arg.start + (file.src.slice(arg.start).indexOf(text)) + brace;
      const end = matchBracket(file.masked, abs);
      if (end !== -1) return { inline: file.codeOnly.slice(abs, end + 1) };
    }
    return { inline: text };
  }
  const strings = [...text.matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1]);
  if (!strings.length) return null;
  const last = strings[strings.length - 1];
  return { name: last.includes("::") ? last.split("::").pop() : last };
}

/**
 * A callback's code, plus one level of the methods/functions it calls, so a
 * nonce/capability check delegated to a helper still counts.
 */
function callbackCode(cb, fnIndex) {
  if (!cb) return { code: "", def: null };
  let code = cb.inline || "";
  let def = null;
  if (cb.name) {
    const defs = fnIndex.get(cb.name) || [];
    def = defs[0] || null;
    code = defs.map((d) => d.body).join("\n");
  }
  const called = new Set([...code.matchAll(/(?:->|::)\s*([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  for (const name of [...called].slice(0, 30)) {
    for (const d of fnIndex.get(name) || []) code += "\n" + d.body;
  }
  return { code, def };
}

/** String literal value of a PHP expression if it is one plain literal; else null. */
function literal(text) {
  const m = /^\s*(['"])([^'"$]*)\1\s*$/.exec(text);
  return m ? m[2] : null;
}

module.exports = { walk, mask, matchBracket, splitArgs, lineAt, loadTree, indexFunctions, resolveCallback, callbackCode, literal };
