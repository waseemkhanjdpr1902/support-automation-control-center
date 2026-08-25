import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { PolicyGrounding } from "./policies";
import type { DraftResult, TicketIntent, TicketPriority, TicketRecord, TicketSentiment } from "./types";

type TokenUsage = Pick<DraftResult, "inputTokens" | "outputTokens" | "totalTokens">;

function normalizeEnumValue(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

const intentSchema = z.preprocess(
  normalizeEnumValue,
  z.enum([
    "refund_request",
    "billing_issue",
    "angry_complaint",
    "lead_inquiry",
    "technical_support",
    "general_support",
  ]),
);

const aiResponseSchema = z.object({
  intent: intentSchema,
  sentiment: z.preprocess(
    normalizeEnumValue,
    z.enum(["positive", "neutral", "frustrated", "angry"]),
  ),
  priority: z.preprocess(
    normalizeEnumValue,
    z.enum(["low", "normal", "high", "urgent"]),
  ),
  draft: z.string().min(80),
});

function numberFromEnv(name: string) {
  const value = process.env[name];
  if (!value) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function configuredRate(provider: DraftResult["provider"], model: string, direction: "INPUT" | "OUTPUT") {
  const providerPrefix = provider === "anthropic" ? "ANTHROPIC" : "ZAI";
  const configured =
    numberFromEnv(`${providerPrefix}_${direction}_COST_PER_1M`) ??
    numberFromEnv(`AI_${direction}_COST_PER_1M`);

  if (configured !== null) return configured;

  if (provider === "zai" && model.toLowerCase() === "glm-4.7-flash") {
    return 0;
  }

  return null;
}

function estimateCostUsd(provider: DraftResult["provider"], model: string, usage: TokenUsage) {
  if (provider === "fallback" || provider === "fallback_after_error") {
    return 0;
  }

  const inputCostPerMillion = configuredRate(provider, model, "INPUT");
  const outputCostPerMillion = configuredRate(provider, model, "OUTPUT");

  if (inputCostPerMillion === null || outputCostPerMillion === null) {
    return null;
  }

  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    (inputCostPerMillion > 0 || outputCostPerMillion > 0)
  ) {
    return null;
  }

  const inputCost = ((usage.inputTokens ?? 0) * inputCostPerMillion) / 1_000_000;
  const outputCost = ((usage.outputTokens ?? 0) * outputCostPerMillion) / 1_000_000;

  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

function withRunMetadata(
  result: Omit<DraftResult, "latencyMs" | "estimatedCostUsd" | "routeReason">,
  startedAt: number,
  routeReason: string,
  usage: TokenUsage = {},
): DraftResult {
  const totalTokens =
    usage.totalTokens ??
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);

  return {
    ...result,
    ...usage,
    totalTokens,
    latencyMs: Date.now() - startedAt,
    estimatedCostUsd: estimateCostUsd(result.provider, result.model, { ...usage, totalTokens }),
    routeReason,
  };
}

function ticketSearchText(ticket: TicketRecord) {
  const metadataValues = Object.values(ticket.metadata ?? {})
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .join(" ");

  return `${ticket.source} ${ticket.subject} ${ticket.body} ${metadataValues}`.toLowerCase();
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

const angryTerms = [
  "angry",
  "furious",
  "livid",
  "unacceptable",
  "outraged",
  "ridiculous",
  "not happy",
  "terrible",
  "escalate this",
  "legal action",
  "lawyer",
  "chargeback",
  "cancel our account",
  "public review",
];

const frustratedTerms = [
  "charged twice",
  "duplicate charge",
  "duplicate renewal",
  "refund",
  "frustrated",
  "upset",
  "disappointed",
  "chasing",
  "missed customer",
  "still broken",
  "still not working",
  "not working",
  "broken",
  "stuck",
  "waiting",
  "no response",
  "can't access",
  "cannot access",
  "can't log in",
  "cannot log in",
  "unable to log in",
  "overcharged",
];

const leadTerms = [
  "lead_form",
  "automate",
  "automation",
  "workflow",
  "pricing",
  "demo",
  "proposal",
  "quote",
  "pilot",
  "rollout",
  "support inbox",
  "approved by our team",
  "vendor",
  "vendors",
  "compare vendors",
  "comparing",
  "interested",
  "looking for",
  "implementation timing",
  "safe ai workflow",
];

const technicalTerms = [
  "outage",
  "dashboard went down",
  "down twice",
  "bug",
  "error",
  "login",
  "log in",
  "cannot log in",
  "can't log in",
  "unable to log in",
  "access back",
  "api",
  "integration",
  "crash",
  "failed",
];

const technicalFailureTerms = [
  "outage",
  "dashboard went down",
  "down twice",
  "production down",
  "service down",
  "crash",
  "crashed",
  "failed",
  "error",
  "bug",
  "still broken",
  "still not working",
  "not working",
  "blocking",
];

const billingTerms = ["invoice", "billing", "renewal", "payment", "receipt", "subscription"];

const priorityRank: Record<TicketPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

function inferIntent(ticket: TicketRecord, text: string): TicketIntent | null {
  if (includesAny(text, angryTerms)) return "angry_complaint";
  if (includesAny(text, ["refund", "charged twice", "duplicate charge", "duplicate renewal"])) {
    return "refund_request";
  }
  if (ticket.source === "lead_form" || includesAny(text, leadTerms)) return "lead_inquiry";
  if (includesAny(text, technicalTerms)) return "technical_support";
  if (includesAny(text, billingTerms)) return "billing_issue";

  return null;
}

function inferSentiment(ticket: TicketRecord, text: string): TicketSentiment | null {
  if (includesAny(text, angryTerms)) return "angry";
  if (includesAny(text, frustratedTerms) || includesAny(text, technicalFailureTerms)) {
    return "frustrated";
  }
  if (ticket.source === "lead_form" || includesAny(text, leadTerms)) return "positive";

  return null;
}

function inferPriority(intent: TicketIntent, sentiment: TicketSentiment, text: string): TicketPriority | null {
  if (
    sentiment === "angry" ||
    intent === "angry_complaint" ||
    includesAny(text, ["urgent", "asap", "immediately", "production down", "went down twice"])
  ) {
    return "urgent";
  }

  if (
    intent === "refund_request" ||
    intent === "lead_inquiry" ||
    includesAny(text, ["finance closing", "finance close", "before friday", "charged twice", "duplicate charge", "pilot", "pricing"])
  ) {
    return "high";
  }

  if (intent === "technical_support" && includesAny(text, technicalFailureTerms)) {
    return "high";
  }

  return null;
}

function inferFallbackClassification(ticket: TicketRecord) {
  const text = ticketSearchText(ticket);
  const intent = inferIntent(ticket, text) ?? "general_support";
  const sentiment = inferSentiment(ticket, text) ?? "neutral";
  const priority = inferPriority(intent, sentiment, text) ?? "normal";

  return { intent, priority, sentiment, text };
}

function normalizeClassification(
  ticket: TicketRecord,
  classification: Pick<DraftResult, "intent" | "sentiment" | "priority">,
) {
  const text = ticketSearchText(ticket);
  const adjustments: string[] = [];
  let intent = classification.intent;
  let sentiment = classification.sentiment;
  let priority = classification.priority;

  const inferredIntent = inferIntent(ticket, text);
  if (
    inferredIntent &&
    (intent === "general_support" ||
      (inferredIntent === "refund_request" && intent === "billing_issue") ||
      inferredIntent === "angry_complaint")
  ) {
    adjustments.push(`intent ${intent} -> ${inferredIntent}`);
    intent = inferredIntent;
  }

  const inferredSentiment = inferSentiment(ticket, text);
  const shouldUseInferredSentiment =
    inferredSentiment &&
    inferredSentiment !== sentiment &&
    (sentiment === "neutral" ||
      inferredSentiment === "angry" ||
      (inferredSentiment === "frustrated" && sentiment === "positive") ||
      (inferredSentiment === "positive" && intent === "lead_inquiry" && sentiment === "frustrated"));
  if (
    shouldUseInferredSentiment
  ) {
    adjustments.push(`sentiment ${sentiment} -> ${inferredSentiment}`);
    sentiment = inferredSentiment;
  }

  const inferredPriority = inferPriority(intent, sentiment, text);
  if (inferredPriority && priorityRank[inferredPriority] > priorityRank[priority]) {
    adjustments.push(`priority ${priority} -> ${inferredPriority}`);
    priority = inferredPriority;
  }

  return { classification: { intent, sentiment, priority }, adjustments };
}

function routeReasonWithAdjustments(routeReason: string, adjustments: string[]) {
  if (adjustments.length === 0) return routeReason;
  return `${routeReason} Classification sanity check adjusted ${adjustments.join(", ")}.`;
}

function cleanDraftText(draft: string) {
  return draft
    .replace(/\[(?:your name|name|agent name|support rep|representative)\]/gi, "Support Operations Team")
    .replace(/(?:best regards|regards|sincerely),?\s*\nSupport Operations Team\s*$/i, "Best,\nSupport Operations Team")
    .trim();
}

function fallbackDraft(
  ticket: TicketRecord,
  provider: DraftResult["provider"] = "fallback",
  note?: string,
  grounding?: PolicyGrounding,
): Omit<DraftResult, "latencyMs" | "estimatedCostUsd" | "routeReason"> {
  const { intent, priority, sentiment } = inferFallbackClassification(ticket);
  const policySourceIds = grounding?.citations.map((citation) => citation.id);

  if (intent === "lead_inquiry") {
    return {
      intent: "lead_inquiry",
      sentiment,
      priority,
      provider,
      model: "deterministic-fallback",
      policySourceIds,
      note,
      draft:
        `Hi ${ticket.customerName},\n\nThanks for reaching out. Your requirement is exactly the kind of workflow where a human-in-the-loop rollout makes sense: AI can classify, summarize, and draft responses, while your team keeps approval control before anything reaches a customer.\n\nA sensible next step would be a short discovery call to map your current inbox, routing rules, escalation paths, and approval owners. From there, we can connect the workflow to your existing support stack and start with a controlled pilot before expanding automation.\n\nBest,\nSupport Operations Team`,
    };
  }

  if (intent === "angry_complaint") {
    return {
      intent: "angry_complaint",
      sentiment,
      priority,
      provider,
      model: "deterministic-fallback",
      policySourceIds,
      note,
      draft:
        `Hi ${ticket.customerName},\n\nI understand why this is frustrating, and I am sorry your team was disrupted. You should not have to chase us for a clear explanation when the dashboard affects customer follow-ups.\n\nI am escalating this to our operations team now so we can confirm the incident timeline, what changed, and what prevention steps are already in place. I will follow up with a specific update rather than a generic apology.\n\nThank you for calling this out directly.\nSupport Operations Team`,
    };
  }

  if (intent === "refund_request") {
    return {
      intent: "refund_request",
      sentiment,
      priority,
      provider,
      model: "deterministic-fallback",
      policySourceIds,
      note,
      draft:
        `Hi ${ticket.customerName},\n\nThanks for flagging this. I can see why a duplicate renewal charge would be urgent, especially with finance closing the books.\n\nWe will verify the payment records and, if the duplicate charge is confirmed, process the refund for the extra transaction. I have marked this as high priority and will make sure you receive a clear confirmation once the review is complete.\n\nBest,\nSupport Operations Team`,
    };
  }

  return {
    intent,
    sentiment,
    priority,
    provider,
    model: "deterministic-fallback",
    policySourceIds,
    note,
    draft:
      `Hi ${ticket.customerName},\n\nThanks for getting in touch. I have reviewed your message and routed it to the right queue for a careful response.\n\nWe will confirm the relevant account details, check the applicable policy, and follow up with a clear next step. Your message will stay in human review before anything is sent externally.\n\nBest,\nSupport Operations Team`,
  };
}

function normalizeOpenAiUsage(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== "object") {
    return {};
  }

  const value = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };

  return {
    inputTokens: value.prompt_tokens ?? value.input_tokens,
    outputTokens: value.completion_tokens ?? value.output_tokens,
    totalTokens: value.total_tokens,
  };
}

function extractJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  return JSON.parse(candidate) as unknown;
}

function policyPrompt(grounding?: PolicyGrounding) {
  if (!grounding || grounding.citations.length === 0) {
    return "No approved policy context was retrieved. Draft conservatively and keep the response in human review.";
  }

  return [
    `Policy pack version: ${grounding.version}`,
    `Retrieval reason: ${grounding.routeReason}`,
    grounding.context,
  ].join("\n\n");
}

function ticketPrompt(ticket: TicketRecord, grounding?: PolicyGrounding) {
  const requestedTone =
    typeof ticket.metadata?.responseTone === "string"
      ? ticket.metadata.responseTone
      : "professional";
  return [
    `Customer name: ${ticket.customerName}`,
    `Customer email: ${ticket.customerEmail}`,
    `Source: ${ticket.source}`,
    `Subject: ${ticket.subject}`,
    `Message:\n${ticket.body}`,
    `Requested response tone: ${requestedTone}`,
    `Internal metadata:\n${JSON.stringify(ticket.metadata ?? {}, null, 2)}`,
    `Approved policy context:\n${policyPrompt(grounding)}`,
  ].join("\n\n");
}

const draftSystemPrompt =
  "You classify customer support and lead messages for a human approval workflow. Return only valid JSON with keys: intent, sentiment, priority, draft. Use exact enum values. intent must be one of refund_request, billing_issue, angry_complaint, lead_inquiry, technical_support, general_support. sentiment must be one of positive, neutral, frustrated, angry. Use positive for buying, demo, pricing, implementation, or partnership interest; neutral for factual requests without emotional pressure; frustrated for duplicate charges, refunds, broken workflows, waiting, blocked access, or repeated issues; angry for explicit anger, unacceptable incidents, legal/chargeback threats, or severe escalation language. priority must be one of low, normal, high, urgent. Draft professional, concise, and never promise policy exceptions. Ground the draft in the approved policy context. Do not invent policies or cite internal policy IDs to the customer unless the customer explicitly asks for policy details. Never use placeholders such as [Your Name]; if a signoff is needed, sign as Support Operations Team.";

async function generateWithZai(ticket: TicketRecord, grounding?: PolicyGrounding): Promise<DraftResult> {
  const startedAt = Date.now();
  const apiKey = process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY;

  if (!apiKey) {
    return withRunMetadata(
      fallbackDraft(ticket, "fallback", "ZAI_API_KEY is not configured.", grounding),
      startedAt,
      "AI_PROVIDER=zai selected, but ZAI_API_KEY is not configured.",
    );
  }

  const model = process.env.ZAI_MODEL || "glm-4.7-flash";
  const baseUrl = process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4";
  const thinkingType = process.env.ZAI_THINKING || "disabled";

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Accept-Language": "en-US,en",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_tokens: 1200,
        messages: [
          { role: "system", content: draftSystemPrompt },
          { role: "user", content: ticketPrompt(ticket, grounding) },
        ],
        model,
        temperature: 0.2,
        thinking: { type: thinkingType },
      }),
    });

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
      usage?: unknown;
    };

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Z.ai request failed with ${response.status}`);
    }

    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = aiResponseSchema.parse(extractJson(content));
    const { classification, adjustments } = normalizeClassification(ticket, parsed);

    return {
      ...withRunMetadata(
        {
          ...parsed,
          ...classification,
          draft: cleanDraftText(parsed.draft),
          provider: "zai",
          model,
          policySourceIds: grounding?.citations.map((citation) => citation.id),
        },
        startedAt,
        routeReasonWithAdjustments(`AI_PROVIDER=zai routed to ${model}.`, adjustments),
        normalizeOpenAiUsage(payload.usage),
      ),
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : "Z.ai generation failed.";
    return withRunMetadata(
      fallbackDraft(ticket, "fallback_after_error", note, grounding),
      startedAt,
      "Z.ai request failed; deterministic fallback used.",
    );
  }
}

async function generateWithAnthropic(ticket: TicketRecord, grounding?: PolicyGrounding): Promise<DraftResult> {
  const startedAt = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return withRunMetadata(
      fallbackDraft(ticket, "fallback", "ANTHROPIC_API_KEY is not configured.", grounding),
      startedAt,
      "AI_PROVIDER=anthropic selected, but ANTHROPIC_API_KEY is not configured.",
    );
  }

  try {
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model,
      max_tokens: 1200,
      temperature: 0.2,
      system: draftSystemPrompt,
      messages: [
        {
          role: "user",
          content: ticketPrompt(ticket, grounding),
        },
      ],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    const parsed = aiResponseSchema.parse(extractJson(textBlock?.text ?? ""));
    const { classification, adjustments } = normalizeClassification(ticket, parsed);

    return {
      ...withRunMetadata(
        {
          ...parsed,
          ...classification,
          draft: cleanDraftText(parsed.draft),
          provider: "anthropic",
          model,
          policySourceIds: grounding?.citations.map((citation) => citation.id),
        },
        startedAt,
        routeReasonWithAdjustments(`AI_PROVIDER=anthropic routed to ${model}.`, adjustments),
        {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      ),
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : "Claude generation failed.";
    return withRunMetadata(
      fallbackDraft(ticket, "fallback_after_error", note, grounding),
      startedAt,
      "Claude request failed; deterministic fallback used.",
    );
  }
}

export async function generateTicketDraft(
  ticket: TicketRecord,
  grounding?: PolicyGrounding,
): Promise<DraftResult> {
  const provider = process.env.AI_PROVIDER || (process.env.ZAI_API_KEY ? "zai" : "anthropic");

  if (provider === "fallback") {
    return withRunMetadata(
      fallbackDraft(ticket, "fallback", "AI_PROVIDER=fallback selected.", grounding),
      Date.now(),
      "Deterministic evaluation route selected.",
    );
  }

  if (provider === "zai") {
    return generateWithZai(ticket, grounding);
  }

  return generateWithAnthropic(ticket, grounding);
}
