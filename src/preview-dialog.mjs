/**
 * Approval dialogs that fit any terminal. Pi draws a dialog's title in full,
 * so a long preview pushed the choices off the screen and nobody could apply
 * a change. The dialog now holds only a short summary of what the change
 * writes and grants; every changed line goes to a file the person can open
 * (and to Pi's scrollable editor on request). The file is removed once they
 * decide, so a stale preview is never left behind.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const PREVIEW_FILE = '.faur/proposal.md';
export const SHOW_PREVIEW = 'Read the full preview here';
const SUMMARY_LINES = 10;

/** Ask `question`; returns the chosen option (undefined on Esc). */
export async function choosePreview(ctx, { root, question, summary, preview, options }) {
  const file = join(root, PREVIEW_FILE);
  mkdirSync(join(root, '.faur'), { recursive: true });
  writeFileSync(file, `# ${question}\n\n${summary.join('\n')}\n\n## Every changed line\n\n${preview}\n`);
  const shown = summary.length <= SUMMARY_LINES ? summary : [...summary.slice(0, SUMMARY_LINES - 1), `… ${summary.length - SUMMARY_LINES + 1} more in the preview.`];
  const title = [question, '', ...shown, '', `Every changed line: ${PREVIEW_FILE}`].join('\n');
  try {
    for (;;) {
      const choice = await ctx.ui.select(title, [...options, SHOW_PREVIEW]);
      if (choice !== SHOW_PREVIEW) return choice;
      await ctx.ui.editor(`${question} Close it to return to the choice.`, preview);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/** Yes or no. Cancel comes first, so a stray Enter changes nothing. */
export async function confirmPreview(ctx, { yes = 'Apply', ...ask }) {
  return (await choosePreview(ctx, { ...ask, options: ['Cancel', yes] })) === yes;
}
