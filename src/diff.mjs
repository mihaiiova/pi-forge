/**
 * diff — shared pure text-diff helpers for the faur CLI and modify seam.
 *
 * `diffLines` is a deterministic line-level diff (LCS-based, no external
 * dependencies). `indent` prefixes every line of a block for indented display.
 * Both are pure functions of their inputs.
 */

/** Prefix every line of `text` with `prefix`. */
export function indent(text, prefix) {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

/**
 * A minimal unified-style line diff between two strings. Lines present only in
 * `oldText` are prefixed `- `, only in `newText` `+ `, and shared lines `  `.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {string}
 */
export function diffLines(oldText, newText) {
  return lineDiff(oldText, newText).join("\n");
}

/** Only the changed lines of `diffLines`, with `context` unchanged lines
 * around each change and "  …" where unchanged lines were left out. */
export function changedLines(oldText, newText, context = 2) {
  return compactDiff(lineDiff(oldText, newText).join("\n"), context);
}

/** Elide unchanged runs of a `diffLines` diff, keeping every changed line and
 * `context` lines around it. */
export function compactDiff(diff, context = 2) {
  const lines = String(diff).split("\n");
  const keep = lines.map((line, i) => lines.slice(Math.max(0, i - context), i + context + 1).some(l => !l.startsWith("  ")));
  const out = [];
  lines.forEach((line, i) => { if (keep[i]) out.push(line); else if (out.at(-1) !== "  …") out.push("  …"); });
  return out.join("\n");
}

function lineDiff(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // Large generated configs must not allocate an unbounded LCS matrix.
  // A whole-file replacement remains an exact, deterministic preview.
  if (n * m > 1000000) return [...a.map(line => `- ${line}`), ...b.map(line => `+ ${line}`)];
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i]}`);
    i++;
  }
  while (j < m) {
    lines.push(`+ ${b[j]}`);
    j++;
  }
  return lines;
}
