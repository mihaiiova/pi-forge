/** /faur designs a new agent outside a Faur project and revises the current one inside it. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { registerMaintenance } from '../../src/maintenance-extension.mjs';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  // Inside a trusted generated project, /faur maintains it; Faur adds nothing
  // to the agents' own run (subagent processes load nothing from here).
  let project: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  pi.on('session_start', (event, ctx) => {
    project = undefined;
    if (!ctx.isProjectTrusted() || !existsSync(join(ctx.cwd, '.pi/system.yaml'))) return;
    if (process.env.PI_SUBAGENT_CHILD === '1') return;
    const maintenance = registerMaintenance(pi, Type, ctx.cwd, { Text });
    project = maintenance;
    // Restores /faur mode after /reload and reports agents missing tools.
    maintenance.start(event, ctx);
  });
  let endDesignTurn: (() => void) | undefined;
  pi.on('agent_end', () => { endDesignTurn?.(); endDesignTurn = undefined; });
  pi.registerCommand('faur', {
    description: 'Design or revise a Pi agent: [request] | check | status | sync | env [set NAME] | permissions [add|remove]',
    handler: async (args, ctx) => {
      if (project) return project(args, ctx);
      const request = (args ?? '').trim();
      if (/^(check|status|sync|env|permissions?)(\s|$)/.test(request)) {
        const message = 'This folder is not a Faur project (no trusted .pi/system.yaml). Describe an outcome with /faur to design one, or start an existing project with pi in its folder.';
        if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else process.stderr.write(`Faur (warning): ${message}\n`);
        return;
      }
      await ctx.waitForIdle();
      const designTurn = new Promise<void>(resolve => { endDesignTurn = resolve; });
      const skill = readFileSync(new URL('../../skills/faur/SKILL.md', import.meta.url), 'utf8');
      pi.sendUserMessage(`${skill}\n\nMode: DESIGN (no Faur project here; faur_plan does not exist and is not needed). Research, discover and build with your ordinary tools and the faur CLI.\nFaur CLI: node ${new URL('../../src/faur.mjs', import.meta.url).pathname}\n\nUser request: ${request || '(none: continue from this conversation)'}`);
      // Print mode exits when the command returns, so wait for the design
      // turn to end. (waitForIdle can resolve before that turn is busy.)
      if (!ctx.hasUI) await designTurn;
    },
  });
}
