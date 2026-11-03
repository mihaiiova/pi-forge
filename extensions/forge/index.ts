/** /faur designs a new agent outside a Forge project and revises the current one inside it. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { registerMaintenance } from '../../skills/forge/maintenance-extension.mjs';
import { registerAgent } from '../../skills/forge/agent-extension.mjs';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  // Trusted generated projects also load their runtime and the project half of /faur.
  let project: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  pi.on('session_start', (_event, ctx) => {
    project = undefined;
    if (!ctx.isProjectTrusted() || !existsSync(join(ctx.cwd, '.pi/system.yaml'))) return;
    if (process.env.PI_SUBAGENT_CHILD === '1') registerAgent(pi, Type, ctx.cwd);
    else project = registerMaintenance(pi, Type, ctx.cwd);
  });
  pi.registerCommand('faur', {
    description: 'Design or revise a Pi agent: [request] | check | status | sync | env [set NAME] | permissions [add|remove|review]',
    handler: async (args, ctx) => {
      if (project) return project(args, ctx);
      const request = (args ?? '').trim();
      if (/^(check|status|sync|env|permissions?)(\s|$)/.test(request)) {
        const message = 'This folder is not a Forge project (no trusted .pi/system.yaml). Describe an outcome with /faur to design one, or start an existing project with pi in its folder (or its ./run).';
        if (ctx.hasUI) ctx.ui.notify(message, 'warning'); else process.stderr.write(`Forge (warning): ${message}\n`);
        return;
      }
      await ctx.waitForIdle();
      const skill = readFileSync(new URL('../../skills/forge/SKILL.md', import.meta.url), 'utf8');
      pi.sendUserMessage(`${skill}\n\nForge skill location: ${new URL('../../skills/forge/', import.meta.url).pathname}\n\nUser request: ${request || '(none: continue from this conversation)'}`);
    },
  });
}
