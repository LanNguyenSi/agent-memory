#!/usr/bin/env node
import { Command } from "commander";
import { createRunCommand } from "./commands/run.js";
import { createConfigCommand } from "./commands/config.js";

const program = new Command();

program
  .name("ice-reflection-engine")
  .description("Analyze AI agent daily memory logs and distill them into MEMORY.md")
  .version("0.1.0");

program.addCommand(createRunCommand());
program.addCommand(createConfigCommand());

program.parseAsync(process.argv);
