# Owlie marketing: skill-first comparison

This is a reference fixture, not the live Owlie project. The source was the
available Faur 0.35.0 marketing design. It has one `marketing` workflow
(four fields), three document declarations (19 top-level fields), one
third-party skill and seven scoped GitHub commands. The workflow generates a
`marketing` skill; the document instructions appear in the lead prompt.

This fixture removes those four declarations, adds the developer-owned
`.pi/skills/marketing/SKILL.md`, and keeps the third-party skill, the lead's
prompt, OpenSEO configuration and all seven commands. The skill carries the
report, history, memory and evidence instructions. Command approval remains in
`.pi/commands.json` through pi-commands, not in the skill prompt. The skill
retains `/skill:marketing` for interactive and `pi --approve -p` invocation.

A clean generation from the original design using the pre-change generator
planned eight files including the workflow skill. The current generator plans
seven; with the separately authored skill there are still eight total. This
removes configuration decisions and a generated file, not an overall project
file. Neither this fixture nor its checks alter the working Owlie project.
Skill instructions are advisory: task output shape is not enforced. Unlike the
old document instructions in the lead prompt on every turn, the marketing
skill's procedures load when the skill is invoked or read. Other turns do not
implicitly receive those procedures.
