import { createHash, randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  agentAccessRank,
  CHANNEL_CHANGE_ITEM_TYPE,
  type Channel,
  type ChannelDraft,
  type ChannelMessage,
  type ConversationMessageSender,
  isChannelDraft,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Semaphore } from "effect";
import { z } from "zod";
import { channelSync } from "./channel-effects";
import type { ChannelService } from "./channel-service";

const identifier = z.string().trim().min(1).max(INPUT_LIMITS.identifier);
const fields = {
  name: z.string().trim().min(1).max(INPUT_LIMITS.agentName),
  title: z.string().max(INPUT_LIMITS.agentTitle).optional(),
  instructions: z.string().max(INPUT_LIMITS.agentDescription).optional(),
  memberAgentIds: z.array(identifier).min(1).max(INPUT_LIMITS.agents),
  leadAgentId: identifier.nullable().optional(),
};
const createSchema = z.strictObject({ requestId: identifier, ...fields });
const updateSchema = z.strictObject({
  channelId: identifier,
  ...fields,
  name: fields.name.optional(),
  memberAgentIds: fields.memberAgentIds.optional(),
});
const listSchema = z.strictObject({
  query: z.string().trim().max(INPUT_LIMITS.agentName).optional(),
  includeArchived: z.boolean().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});

export const CHANNEL_DIRECTORY_TOOL_DEFINITIONS = [
  {
    name: "list_channels",
    description:
      "List local channel IDs, names, leads and members from a person's direct chat. Returns no messages. Search by name or title; use nextOffset for more results. Routine, teammate and external messaging turns cannot use it.",
    shape: listSchema.shape,
  },
  {
    name: "create_channel",
    description:
      "Create a local channel when a person asks in your direct chat. Get existing member IDs from list_agents. Supply a unique requestId and reuse it for retries of this creation. The lead must be a member. Returns the channel ID; starts no work. Duplicate names are refused. Routine, teammate and external messaging turns cannot use it.",
    shape: createSchema.shape,
  },
  {
    name: "update_channel",
    description:
      "Change a channel's name, title, instructions, members or lead when a person asks in your direct chat. Get channelId from list_channels. Omitted fields stay unchanged; memberAgentIds replaces the member list. Removing a member stops its channel tasks. Set leadAgentId to null to clear it. Archived channels cannot change. Routine, teammate and external messaging turns cannot use it.",
    shape: updateSchema.shape,
  },
];

export function isChannelDirectoryTool(tool: string): boolean {
  return CHANNEL_DIRECTORY_TOOL_DEFINITIONS.some((definition) => definition.name === tool);
}

/** Direct-chat channel configuration. All writes still use the channel command queue and receipts. */
export class ChannelDirectoryTools {
  readonly #writes = Semaphore.makeUnsafe(1);

  constructor(readonly channels: ChannelService) {}

  readonly handle = Effect.fn("ChannelDirectoryTools.handle")(function* (
    this: ChannelDirectoryTools,
    tool: string,
    args: unknown,
    agentId: string,
    person: ConversationMessageSender,
    operationId: string,
  ) {
    if (tool === "list_channels") {
      const input = yield* channelSync(() => listSchema.parse(args));
      return yield* channelSync(() => {
        this.#requireCaller(person, agentId);
        const query = input.query?.toLowerCase() ?? "";
        const matches = this.channels.store
          .list(person.id)
          .filter((channel) => input.includeArchived || !channel.archived)
          .filter((channel) => `${channel.name}\n${channel.title}`.toLowerCase().includes(query))
          .sort((left, right) => left.id.localeCompare(right.id));
        const end = input.offset + input.limit;
        return {
          channels: matches.slice(input.offset, end).map((channel) => this.#summary(channel, person)),
          nextOffset: end < matches.length ? end : null,
        };
      });
    }
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const input = yield* channelSync(() =>
          tool === "create_channel" ? createSchema.parse(args) : updateSchema.parse(args),
        );
        const creating = "requestId" in input;
        const channelId = creating
          ? `channel-${createHash("sha256")
              .update(JSON.stringify([person.id, agentId, input.requestId]))
              .digest("hex")}`
          : input.channelId;
        const receipt = creating ? `directory:${channelId}` : operationId;
        const actor = {
          id: agentId,
          name: this.channels.hooks.agents().find((agent) => agent.id === agentId)?.name ?? agentId,
        };
        const note = this.#note(channelId, actor, person, creating);
        const channel = yield* this.channels.command(
          // The placeholder is replaced only inside the command queue, from current stored state.
          {
            type: "save",
            operationId: receipt,
            channelId,
            draft: { name: "", title: "", instructions: "", members: [], leadAgentId: null },
            update: !creating,
          },
          actor,
          (command) => {
            this.#requireCaller(person, agentId);
            const exists = this.channels.store.exists(channelId);
            if (creating && this.channels.committed(agentId, receipt)) {
              if (!exists) throw new Error(sourceText("error.backend.channelNotFound"));
              // A retry must not overwrite later edits.
              return null;
            }
            if (!creating && !exists) throw new Error(sourceText("error.backend.channelNotFound"));
            const current = exists ? this.channels.store.get(channelId) : null;
            if (current?.archived) throw new Error(sourceText("error.backend.channelDirectoryArchived"));
            const draft: ChannelDraft = {
              name: input.name ?? current?.name ?? "",
              title: input.title ?? current?.title ?? "",
              instructions: input.instructions ?? current?.instructions ?? "",
              members: input.memberAgentIds?.map((id) => ({ agentId: id })) ?? current?.members ?? [],
              leadAgentId: input.leadAgentId !== undefined ? input.leadAgentId : (current?.leadAgentId ?? null),
            };
            if (!isChannelDraft(draft)) throw new Error(sourceText("error.backend.channelDirectoryDraftInvalid"));
            const other = this.channels.store
              .list(person.id)
              .find((item) => item.id !== channelId && item.name.trim().toLowerCase() === draft.name.toLowerCase());
            if (other) throw new Error(sourceText("error.backend.channelDirectoryNameTaken"));
            const previous = new Set(current?.members.map((member) => member.agentId));
            for (const member of draft.members) {
              if (previous.has(member.agentId)) continue;
              if (
                !this.channels.hooks.agents().some((agent) => agent.id === member.agentId) ||
                !this.#visible(person, member.agentId) ||
                agentAccessRank(this.#level(person, member.agentId)) < agentAccessRank("chat")
              )
                throw new Error(sourceText("error.backend.channelMemberUnavailable"));
            }
            for (const member of current?.members ?? []) {
              if (
                !draft.members.some((next) => next.agentId === member.agentId) &&
                !this.#visible(person, member.agentId)
              )
                throw new Error(sourceText("error.backend.channelMemberUnavailable"));
            }
            if (
              draft.leadAgentId !== current?.leadAgentId &&
              draft.leadAgentId &&
              !this.#visible(person, draft.leadAgentId)
            )
              throw new Error(sourceText("error.backend.channelMemberUnavailable"));
            if (
              current?.leadAgentId &&
              draft.leadAgentId !== current.leadAgentId &&
              !this.#visible(person, current.leadAgentId)
            )
              throw new Error(sourceText("error.backend.channelMemberUnavailable"));
            return { ...command, type: "save", draft, update: !creating };
          },
          [note],
        );
        return this.#summary(channel, person);
      }),
    );
  });

  #level(person: ConversationMessageSender, agentId: string) {
    return this.channels.hooks.personAgentLevel?.(person.id, agentId) ?? "manage";
  }

  #visible(person: ConversationMessageSender, agentId: string): boolean {
    return !this.channels.hooks.hidden?.(agentId) && this.#level(person, agentId) !== "none";
  }

  #requireCaller(person: ConversationMessageSender, agentId: string): void {
    if (agentAccessRank(this.#level(person, agentId)) < agentAccessRank("chat"))
      throw new Error(sourceText("error.backend.channelDirectoryPersonRequired"));
  }

  #summary(channel: Channel, person: ConversationMessageSender) {
    const members = channel.members.filter((member) => this.#visible(person, member.agentId));
    return {
      id: channel.id,
      name: channel.name,
      title: channel.title,
      archived: channel.archived,
      members,
      leadAgentId: members.some((member) => member.agentId === channel.leadAgentId) ? channel.leadAgentId : null,
    };
  }

  #note(
    channelId: string,
    agent: ConversationMessageSender,
    person: ConversationMessageSender,
    creating: boolean,
  ): ChannelMessage {
    const id = randomUUID();
    return {
      id,
      channelId,
      sequence: 0,
      author: { kind: "agent", ...agent },
      taskId: null,
      superseded: false,
      message: {
        id,
        author: "system",
        source: "system",
        status: "completed",
        createdAt: new Date().toISOString(),
        itemType: CHANNEL_CHANGE_ITEM_TYPE,
        text: sourceText(creating ? "status.agent.channelCreatedFromChat" : "status.agent.channelUpdatedFromChat", {
          agent: agent.name,
          person: person.name,
        }),
      },
    };
  }
}
