import { defineCommand } from "citty";
import { makeSkillsInstallCommand } from "./install.ts";

const skillsCommand = defineCommand({
  meta: {
    name: "skills",
    description: "Install agent skills bundled with jade (Cursor, Claude Code, or both)",
  },
  subCommands: {
    install: makeSkillsInstallCommand(),
  },
});

export default skillsCommand;
