import { Category } from "../mandate/types";

export interface CatalogItem {
  id: string;
  name: string;
  category: Category;
  price_inr: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface TranscriptTurn {
  turn: number;
  modelText: string | null;
  toolCalls: ToolCallRecord[];
}

export type StopReason = "goal_complete" | "turn_limit_reached";

export interface AgentTranscript {
  goal: string;
  mandateId: string;
  agentId: string;
  turns: TranscriptTurn[];
  stopReason: StopReason;
  finalMessage: string | null;
}
