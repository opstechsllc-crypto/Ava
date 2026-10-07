import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

function bedrockModel(overrides: Record<string, unknown>) {
  return {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    id: "amazon.nova-micro-v1:0",
    name: "Nova Micro",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as never;
}

async function* streamEvents(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

async function captureCommandInput(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
  validateRequest?: (input: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const response = {
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  };
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send");
  if (validateRequest) {
    send.mockImplementation((command) => {
      const input = (command as unknown as { input?: Record<string, unknown> }).input;
      if (!input) {
        throw new Error("expected ConverseStreamCommand input");
      }
      validateRequest(input);
      return response as never;
    });
  } else {
    send.mockResolvedValue(response as never);
  }
  const result = await streamSimpleBedrock(model, context, options as never).result();
  if (validateRequest && result.stopReason !== "stop") {
    throw new Error(
      `Bedrock request fixture rejected replay: ${result.errorMessage ?? result.stopReason}`,
    );
  }
  const command = send.mock.calls.at(-1)?.[0] as { input?: Record<string, unknown> } | undefined;
  if (!command?.input) {
    throw new Error("expected ConverseStreamCommand input");
  }
  return command.input;
}

function findToolUse(input: Record<string, unknown>) {
  const messages = input.messages as Array<{
    content?: Array<{ toolUse?: { input?: unknown } }>;
  }>;
  return messages.flatMap((message) => message.content ?? []).find((block) => block.toolUse)
    ?.toolUse;
}

function expectObjectToolUseInput(input: Record<string, unknown>): void {
  const toolInput = findToolUse(input)?.input;
  expect(toolInput).toEqual(expect.any(Object));
  expect(Array.isArray(toolInput)).toBe(false);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Bedrock tool-result replay", () => {
  // Tool blocks require a toolConfig on the request; these contexts send one.
  const replayTools = [
    {
      name: "inspect",
      description: "Inspect",
      parameters: { type: "object", properties: {} },
    },
  ];

  it("replays unsupported audio attachments as their canonical text placeholder", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_audio",
          toolName: "listen",
          content: [{ type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" }],
          isError: false,
        },
      ],
      tools: replayTools,
    } as never);
    const messages = input.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_audio",
            content: [{ text: "(see attached audio)" }],
          },
        },
      ],
    });
  });

  it("preserves valid text and image attachments alongside unsupported audio", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_media",
          toolName: "inspect",
          content: [
            { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
            { type: "text", text: "actual tool output" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          isError: false,
        },
      ],
      tools: replayTools,
    } as never);
    const messages = input.messages as Array<Record<string, unknown>>;

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_media",
            content: [
              { text: "actual tool output" },
              { image: { format: "png", source: { bytes: expect.any(Uint8Array) } } },
            ],
          },
        },
      ],
    });
  });

  it("drops payload-less image husks from consecutive tool results", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_husk",
          toolName: "screenshot",
          content: [{ type: "image", mimeType: "image/png", data: "" }],
          isError: false,
        },
        {
          role: "toolResult",
          toolCallId: "call_text",
          toolName: "read",
          content: [{ type: "text", text: "actual tool output" }],
          isError: false,
        },
      ],
      tools: replayTools,
    } as never);
    const messages = input.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        { toolResult: { toolUseId: "call_husk", content: [{ text: "(no output)" }] } },
        { toolResult: { toolUseId: "call_text", content: [{ text: "actual tool output" }] } },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain('"image"');
    expect(JSON.stringify(messages)).not.toContain("see attached image");
  });
});

describe("Bedrock assistant tool-use replay", () => {
  const replayContext = (argumentsValue: unknown) =>
    ({
      messages: [
        {
          role: "assistant",
          provider: "amazon-bedrock",
          api: "bedrock-converse-stream",
          model: "amazon.nova-micro-v1:0",
          content: [
            {
              type: "toolCall",
              id: "call_replay",
              name: "read",
              arguments: argumentsValue,
            },
          ],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_replay",
          toolName: "read",
          content: [{ type: "text", text: "existing result" }],
          isError: false,
          timestamp: 1,
        },
        { role: "user", content: "continue", timestamp: 2 },
      ],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
    }) as never;

  it.each(['{"path":', 42])(
    "normalizes invalid stored arguments %j at the Bedrock request boundary",
    async (malformedArguments) => {
      const context = replayContext(malformedArguments);
      const originalContext = JSON.stringify(context);
      const input = await captureCommandInput(
        bedrockModel({}),
        context,
        {},
        expectObjectToolUseInput,
      );
      expect(findToolUse(input)?.input).toEqual({});
      expect(JSON.stringify(context)).toBe(originalContext);
    },
  );

  it("preserves valid object arguments at the same request boundary", async () => {
    const validArguments = { path: "README.md" };
    const input = await captureCommandInput(
      bedrockModel({}),
      replayContext(validArguments),
      {},
      expectObjectToolUseInput,
    );
    expect(findToolUse(input)?.input).toEqual(validArguments);
  });
});

describe("Bedrock tool-free tool history", () => {
  // Settled-turn finalization calls Converse with tools disabled while the
  // replayed session history still carries completed tool calls and results.
  const settledTurnContext = () =>
    ({
      messages: [
        { role: "user", content: "Post the deploy note to #general.", timestamp: 0 },
        {
          role: "assistant",
          provider: "amazon-bedrock",
          api: "bedrock-converse-stream",
          model: "amazon.nova-micro-v1:0",
          content: [
            {
              type: "toolCall",
              id: "call_send",
              name: "message",
              arguments: { channel: "#general", text: "Deploy done" },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_send",
          toolName: "message",
          content: [{ type: "text", text: "Delivered to #general" }],
          isError: false,
          timestamp: 2,
        },
        { role: "user", content: "Summarize what was done.", timestamp: 3 },
      ],
      tools: [],
    }) as never;

  it.each([{ toolChoice: undefined }, { toolChoice: "none" as const }])(
    "represents completed tool history as text when the request omits toolConfig ($toolChoice)",
    async ({ toolChoice }) => {
      const input = await captureCommandInput(
        bedrockModel({}),
        settledTurnContext(),
        toolChoice === undefined ? {} : { toolChoice },
      );
      expect(input.toolConfig).toBeUndefined();
      const messages = input.messages as Array<{
        role: string;
        content?: Array<Record<string, unknown>>;
      }>;
      const blocks = messages.flatMap((message) => message.content ?? []);
      expect(blocks.some((block) => "toolUse" in block || "toolResult" in block)).toBe(false);
      const assistant = messages.find((message) => message.role === ConversationRole.ASSISTANT);
      expect(assistant?.content).toEqual([
        { text: '[Assistant tool call]: message({"channel":"#general","text":"Deploy done"})' },
      ]);
      const toolEvidence = messages.find((message) =>
        message.content?.some(
          (block) => typeof block.text === "string" && block.text.includes("Delivered to #general"),
        ),
      );
      expect(toolEvidence?.role).toBe(ConversationRole.USER);
      expect(toolEvidence?.content).toEqual([
        { text: "[Tool result: message]:" },
        { text: "Delivered to #general" },
      ]);
    },
  );

  it("keeps tool blocks when the request sends toolConfig", async () => {
    const context = settledTurnContext() as { tools: unknown[] };
    context.tools = [
      {
        name: "message",
        description: "Send a message",
        parameters: { type: "object", properties: {} },
      },
    ];
    const input = await captureCommandInput(bedrockModel({}), context as never);
    expect(input.toolConfig).toBeDefined();
    const serialized = JSON.stringify(input.messages);
    expect(serialized).toContain('"toolUse"');
    expect(serialized).toContain('"toolResult"');
  });
});
