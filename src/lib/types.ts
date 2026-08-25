export const ticketStatuses = [
  "new",
  "drafted",
  "needs_review",
  "approved",
  "sent",
  "simulated",
  "failed",
] as const;

export const ticketSources = [
  "manual",
  "demo",
  "webhook",
  "gmail",
  "zendesk",
  "intercom",
  "lead_form",
] as const;

export const ticketIntents = [
  "refund_request",
  "billing_issue",
  "angry_complaint",
  "lead_inquiry",
  "technical_support",
  "general_support",
] as const;

export const ticketSentiments = [
  "positive",
  "neutral",
  "frustrated",
  "angry",
] as const;

export const ticketPriorities = ["low", "normal", "high", "urgent"] as const;

export const auditActions = [
  "ticket_created",
  "seeded",
  "ai_drafted",
  "safety_flagged",
  "draft_edited",
  "submitted_for_review",
  "returned_for_changes",
  "approved",
  "sent",
  "send_simulated",
  "send_failed",
] as const;

export type TicketStatus = (typeof ticketStatuses)[number];
export type TicketSource = (typeof ticketSources)[number];
export type TicketIntent = (typeof ticketIntents)[number];
export type TicketSentiment = (typeof ticketSentiments)[number];
export type TicketPriority = (typeof ticketPriorities)[number];
export type AuditAction = (typeof auditActions)[number];

export type JsonObject = Record<string, unknown>;

export type AuditEventRecord = {
  id: string;
  ticketId: string;
  action: AuditAction;
  actor: string;
  message: string;
  metadata: JsonObject | null;
  createdAt: string;
};

export type TicketRecord = {
  id: string;
  customerName: string;
  customerEmail: string;
  subject: string;
  body: string;
  source: TicketSource;
  status: TicketStatus;
  intent: TicketIntent;
  sentiment: TicketSentiment;
  priority: TicketPriority;
  aiDraft: string | null;
  finalResponse: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  sendProvider: string | null;
  sendResult: string | null;
  metadata: JsonObject | null;
  createdAt: string;
  updatedAt: string;
  auditEvents: AuditEventRecord[];
};

export type DraftResult = {
  intent: TicketIntent;
  sentiment: TicketSentiment;
  priority: TicketPriority;
  draft: string;
  provider: "gemini" | "groq" | "anthropic" | "zai" | "fallback" | "fallback_after_error";
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd: number | null;
  routeReason: string;
  policySourceIds?: string[];
  note?: string;
};

export type SendResult = {
  status: "sent" | "simulated" | "failed";
  provider: "resend" | "simulated";
  result: string;
};
