/**
 * Approval dialogs over a deterministic preview. A dialog whose title is a
 * long preview pushes its choices off the screen (a 17,000-character preview
 * did), so the title shows the start, the choices stay visible, and the whole
 * preview opens in Pi's scrollable editor on request.
 */
const PREVIEW_LINES = 12;
export const SHOW_PREVIEW = 'Show the full preview';

/** Ask `question` with `preview`; returns the chosen option (undefined on Esc). */
export async function choosePreview(ctx, question, preview, options) {
  const lines = preview.split('\n');
  const fits = lines.length <= PREVIEW_LINES;
  const title = fits ? `${question}\n\n${preview}` : `${question}\n\n${lines.slice(0, PREVIEW_LINES).join('\n')}\n  … ${lines.length - PREVIEW_LINES} more lines: choose "${SHOW_PREVIEW}" to read every change.`;
  for (;;) {
    const choice = await ctx.ui.select(title, fits ? options : [...options, SHOW_PREVIEW]);
    if (choice !== SHOW_PREVIEW) return choice;
    await ctx.ui.editor(`${question} Full preview: close it to return to the choice.`, preview);
  }
}

/** Yes or no on a preview. Cancel comes first, so a stray Enter changes nothing. */
export async function confirmPreview(ctx, question, preview, yes = 'Apply') {
  return (await choosePreview(ctx, question, preview, ['Cancel', yes])) === yes;
}
