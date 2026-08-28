import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerTeamWikiCommands } from "../commands/client/team-wiki.js";
import { registerIssueCommands } from "../commands/client/issue.js";

/**
 * MUL-110 / MUL-118: the terminal had no way to write a wiki page or to hand a
 * card to a person, so two workflows dead-ended at the CLI even though the HTTP
 * surface already allowed both. These assert the entry points exist.
 */
describe("registerTeamWikiCommands", () => {
  it("registers the read and write commands for wiki pages", () => {
    const program = new Command();
    registerTeamWikiCommands(program);

    const wiki = program.commands.find((command) => command.name() === "team-wiki");
    expect(wiki).toBeDefined();
    const names = (wiki?.commands ?? []).map((command) => command.name()).sort();
    expect(names).toEqual(["create", "delete", "edit", "list", "restore", "show", "versions"]);
  });

  it("requires a space on every page command so a page cannot land in the wrong one", () => {
    const program = new Command();
    registerTeamWikiCommands(program);

    const wiki = program.commands.find((command) => command.name() === "team-wiki");
    for (const command of wiki?.commands ?? []) {
      const space = command.options.find((option) => option.long === "--space");
      expect(space, `${command.name()} is missing --space`).toBeDefined();
      expect(space?.required, `${command.name()} --space must be required`).toBe(true);
    }
  });
});

describe("issue update assignee flags", () => {
  it("offers --assignee-user-id, the only review path an agent can open alone", () => {
    const program = new Command();
    registerIssueCommands(program);

    const issue = program.commands.find((command) => command.name() === "issue");
    const update = issue?.commands.find((command) => command.name() === "update");
    expect(update?.options.some((option) => option.long === "--assignee-user-id")).toBe(true);
    expect(update?.options.some((option) => option.long === "--assignee-agent-id")).toBe(true);
  });
});
