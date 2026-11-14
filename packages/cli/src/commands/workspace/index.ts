import { defineCommand } from "citty";
import { addCommand } from "./add.ts";
import { listCommand } from "./list.ts";
import { removeCommand } from "./remove.ts";
import { updateCommand } from "./update.ts";

const workspaceCommand = defineCommand({
  meta: {
    name: "workspace",
    description: "Manage workspaces",
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
    update: updateCommand,
  },
});

export default workspaceCommand;
