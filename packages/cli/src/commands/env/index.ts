import { defineCommand } from "citty";
import { syncCommand } from "./sync.ts";

const envCommand = defineCommand({
  meta: {
    name: "env",
    description: "Manage environment files",
  },
  subCommands: {
    sync: syncCommand,
  },
});

export default envCommand;
