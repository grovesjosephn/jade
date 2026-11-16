#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import init from "./src/commands/init.ts";
import add from "./src/commands/add.ts";
import remove from "./src/commands/remove.ts";
import workspace from "./src/commands/workspace/index.ts";
import checkout from "./src/commands/checkout.ts";
import status from "./src/commands/status.ts";
import open from "./src/commands/open.ts";
import update from "./src/commands/update.ts";
import skills from "./src/commands/skills/index.ts";
import env from "./src/commands/env/index.ts";
import review from "./src/commands/review.ts";
import exec from "./src/commands/exec.ts";
import doctor from "./src/commands/doctor.ts";
import create from "./src/commands/create.ts";
import publish from "./src/commands/publish.ts";
import importCommand from "./src/commands/import.ts";

const main = defineCommand({
  meta: {
    name: "jade",
    version: "0.2.0",
    description: "Multi-repo hubs of git worktrees: one bare clone per app, a workspace per branch",
  },
  subCommands: {
    init,
    add,
    import: importCommand,
    create,
    publish,
    remove,
    workspace,
    checkout,
    status,
    open,
    update,
    skills,
    env,
    review,
    exec,
    doctor,
  },
});

runMain(main);