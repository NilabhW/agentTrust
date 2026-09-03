import { JsonWebKey } from "node:crypto";
import { GeminiContent, GenerateContentInput, GenerateContentResult } from "./gemini-client";
import { executeToolCall, ToolContext, TOOL_DECLARATIONS } from "./tools";
import { AgentTranscript, ToolCallRecord, TranscriptTurn } from "./types";

export interface ContentGenerator {
  generateContent(input: GenerateContentInput): Promise<GenerateContentResult>;
}

export interface RunBuyerAgentOptions {
  goal: string;
  mandateId: string;
  agentId: string;
  allowedCategories: string[];
  geminiClient: ContentGenerator;
  toolContext: { gatewayUrl: string; privateKeyJwk: JsonWebKey; fetchImpl?: typeof fetch };
  turnLimit?: number;
  onTurn?: (turn: TranscriptTurn) => void;
}

const DEFAULT_TURN_LIMIT = 8;

function buildSystemInstruction(agentId: string, allowedCategories: string[]) {
  return {
    parts: [
      {
        text:
          `You are ${agentId}, an autonomous purchasing agent acting under a signed spending mandate. ` +
          `You may only shop within these categories: ${allowedCategories.join(", ")}. ` +
          `You have a real spending budget (a per-purchase cap and a total cap) but you do NOT know the exact ` +
          `numbers -- discover them by making purchase attempts and reading the Gateway's rejection reasons, the ` +
          `same way a real agent with limited visibility into its own permissions would. Use browse_catalog to see ` +
          `what's available, and submit_purchase to attempt a purchase -- it is the only way to spend money; there ` +
          `is no other path to payment. If a purchase is hard_fail'd, do not resubmit the identical request -- ` +
          `adjust or stop and explain why. If a purchase results in step_up, a human needs to approve it -- do not ` +
          `keep retrying; report that it's pending and stop. When you've made as much progress on the goal as you ` +
          `reasonably can, respond with a final plain-text summary and do not call any more tools.`,
      },
    ],
  };
}

export async function runBuyerAgent(opts: RunBuyerAgentOptions): Promise<AgentTranscript> {
  const turnLimit = opts.turnLimit ?? DEFAULT_TURN_LIMIT;
  const systemInstruction = buildSystemInstruction(opts.agentId, opts.allowedCategories);
  const tools = [{ functionDeclarations: TOOL_DECLARATIONS }];
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: opts.goal }] }];
  const turns: TranscriptTurn[] = [];
  const toolContext: ToolContext = { ...opts.toolContext, mandateId: opts.mandateId };

  const base = { goal: opts.goal, mandateId: opts.mandateId, agentId: opts.agentId };

  for (let turnCount = 1; turnCount <= turnLimit; turnCount++) {
    const response = await opts.geminiClient.generateContent({ contents, tools, systemInstruction });

    if (response.status === "failed") {
      const turn: TranscriptTurn = { turn: turnCount, modelText: null, toolCalls: [] };
      turns.push(turn);
      opts.onTurn?.(turn);
      return {
        ...base,
        turns,
        stopReason: "turn_limit_reached",
        finalMessage: `Gemini call failed: ${response.raw_error}`,
      };
    }

    if (response.functionCalls.length === 0) {
      const turn: TranscriptTurn = { turn: turnCount, modelText: response.text, toolCalls: [] };
      turns.push(turn);
      opts.onTurn?.(turn);
      return { ...base, turns, stopReason: "goal_complete", finalMessage: response.text };
    }

    contents.push({
      role: "model",
      parts: [
        ...(response.text ? [{ text: response.text }] : []),
        ...response.functionCalls.map((call) => ({ functionCall: call })),
      ],
    });

    const toolCallRecords: ToolCallRecord[] = [];
    const responseParts = [];
    for (const call of response.functionCalls) {
      const result = await executeToolCall(call, toolContext);
      toolCallRecords.push({ name: call.name, args: call.args, result });
      responseParts.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });

    const turn: TranscriptTurn = { turn: turnCount, modelText: response.text, toolCalls: toolCallRecords };
    turns.push(turn);
    opts.onTurn?.(turn);
  }

  return { ...base, turns, stopReason: "turn_limit_reached", finalMessage: null };
}
