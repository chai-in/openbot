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

## Verification

Install the pinned dependencies with `bun install --frozen-lockfile` and run
`bun run test:agent-channel-manage`. The check drives the real services and tool router on a
temporary profile with a scripted provider. Its report is written to
`.openbot-build/agent-channel-manage-e2e/report.json`. It uses no live account, real chat or running
desktop profile. The existing CI selection runs this check.

Run `bun run typecheck:node` for backend changes and Biome on the changed files.
This work does not replace an installed OpenBot application or publish a desktop release.
