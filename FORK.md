# Fork changes

This independent fork extends [OpenBot](https://github.com/nightly-labs/openbot).
The source remains under [PolyForm Noncommercial 1.0.0](LICENSE), with the upstream
copyright and required notices. Public source does not remove its noncommercial restriction.
The upstream contribution approval process applies to submissions upstream, not to development
in this fork.

## Channel setup from a direct chat

An agent can use three discoverable tools when a person asks in its own chat:

- `list_channels`: search names and titles, with bounded pages and an option to include archived channels.
- `create_channel`: set a name, title, instructions, existing members, and an optional lead.
- `update_channel`: change those settings by channel ID. Omitted fields stay unchanged.

For example, ask an agent to create a release channel with two existing teammates, then change
the lead. It resolves the agent IDs, checks existing channels, and returns the channel ID.
Creating a channel starts no work. Open it from the channel list to send the first request.
There is no new deep-link format or cross-channel posting tool.

Creation requires a `requestId`. Repeating it for the same person and calling agent returns the
same channel while its creation receipt exists. Names are compared without case or surrounding
spaces, including archived channels, to prevent accidental duplicates through these tools.
Permanent deletion erases channel history and receipts; it also ends this retry guarantee.
The existing UI's channel naming rules are unchanged.

The host must identify the person behind the current direct-chat delivery. Old messages with no
stored identity, routine runs, teammate messages, side tasks, channel tasks and external messaging
turns cannot use these tools. A person must still have chat access to the calling agent and to
each new member. Hidden or inaccessible members cannot be added or removed, and their IDs and
lead status are omitted from tool results. As in the existing Team API, authenticated server
members can see channel names and titles. Lists contain no transcript or instructions.

Changes use the existing channel command queue and store an activity note in the same commit.
Removing a member keeps the service's existing task pause behavior. Archived channels
cannot be edited. No database migration or released IPC or Team API change is required.

## Command discovery, channel handoffs and routine inspection

This fork also includes these upstream fixes, with their original commit authors preserved:

- [#4315](https://github.com/nightly-labs/openbot/pull/4315),
  `97e290ef9082f30e6c753d48d4b351df3cd096af`: isolate executable and PATH output from
  login-shell profile output, including control sequences with no trailing newline.
- [#3871](https://github.com/nightly-labs/openbot/pull/3871),
  `a22bba5fae846e19b8015d21859797d887114259`: return readable handoff and agent-ID
  refusals so an agent can correct its request. Invalid recipients do not receive messages.
- [#4542](https://github.com/nightly-labs/openbot/pull/4542),
  `a02584b72426c37d748efcba07ee18c8fa8a32bd`: allow a routine run to list routines.
  Its prompt still prohibits creating, updating, deleting and testing routines during the run.
  That prohibition is model guidance, not a new server authorization boundary.

These changes add no runtime dependencies or database migration.
The main-branch CI deployment and pull-request preview jobs are restricted to the upstream
repository. These integration events in the fork cannot run those deployments.

## Verification

Install the pinned dependencies with `bun install --frozen-lockfile` and run
`bun run test:agent-channel-manage`. The check drives the real services and tool router on a
temporary profile with a scripted provider. Its report is written to
`.openbot-build/agent-channel-manage-e2e/report.json`. It uses no live account, real chat or running
desktop profile. The existing CI selection runs this check.

The combined channel check also tests handoffs after direct-chat membership changes, hidden
recipients, assignment and transfer refusals, and readable agent-ID errors. Run
`bun run test:channel-handoff-validation` for valid handoffs and all-or-nothing recipient checks,
and `bun run test:routine-report-failure` for routine listing and the retained prompt prohibition.

Run `bun scripts/mcp-noisy-shell-e2e.ts` for command discovery. On macOS it checks a fake shell
and the real `/bin/zsh`, with clean and noisy temporary profiles in separate processes. It does
not change the user's shell profiles. Each case resolves the command and PATH and launches the
fixture executable. Other platforms run the fake-shell case.

Run `bun run typecheck:node` for backend changes and Biome on the changed files.
This work does not replace an installed OpenBot application or publish a desktop release.
