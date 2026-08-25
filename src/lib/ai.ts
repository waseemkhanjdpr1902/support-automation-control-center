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
  const providerPrefix =
    provider === "anthropic"
      ? "ANTHROPIC"
      : provider === "gemini"
        ? "GEMINI"
        : provider === "groq"
          ? "GROQ"
          : "ZAI";
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
    .replace(/^Subject:\s*[^\n]+\n+/i, "")
    .replace(
      /I(?:'|’)ve attached the account closure form to this email\./gi,
      "We will verify the applicable closure process and arrange for the account closure form to be provided.",
    )
    .replace(/Kind Best,/gi, "Regards,")
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

  if (ticket.source === "manual") {
    return {
      intent,
      sentiment,
      priority,
      provider,
      model: "safe-fallback",
      policySourceIds,
      note,
      draft:
        `Dear ${ticket.customerName === "Customer" ? "Customer" : ticket.customerName},\n\nThank you for your email regarding “${ticket.subject}”. We have noted the details shared and are reviewing the request with the relevant team. We will verify the applicable information before confirming the appropriate next steps.\n\nRegards,\nSupport Operations Team`,
    };
  }

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

function ticketPrompt(ticket: TicketRecord, grounding?: PolicyGrounding, redraft = false) {
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
    redraft
      ? `Redraft instruction: Produce a materially improved version. Do not repeat the prior wording. Address every distinct issue and requested action in the customer email. Prior draft for improvement only:\n${ticket.finalResponse ?? ticket.aiDraft ?? "No prior draft"}`
      : "Draft instruction: Address every distinct issue and requested action in the customer email.",
  ].join("\n\n");
}

const draftSystemPrompt =
  "You are a senior fintech customer-support email coach. Classify the customer's actual purpose and draft a context-specific response for human review. Return only valid JSON with keys: intent, sentiment, priority, draft. Use exact enum values. intent must be one of refund_request, billing_issue, angry_complaint, lead_inquiry, technical_support, general_support. sentiment must be one of positive, neutral, frustrated, angry. Do not label a routine business request as frustrated merely because it mentions a mistake, and do not label it as a lead unless the sender is asking to buy, evaluate, price, demo, or implement a product. priority must be one of low, normal, high, urgent. Follow the requested tone. Preserve important facts, names, dates, percentages, account references, products, and requested actions from the customer message. For complaints, acknowledge the experience and then explicitly list or clearly cover each operational issue and each remedy requested. Never write a vague acknowledgement that could apply to any email. Do not invent account findings, transaction status, deadlines, approvals, policies, commitments, attachments, escalations, refunds, or completed actions. Never say a document is attached, enclosed, shared, sent, escalated, initiated, or processed unless the input explicitly confirms that action. Where verification is needed, say exactly what will be checked and which requested item needs action, without claiming it has already happened. Return only the email body, without a Subject line. Keep the response polished, respectful, and ready to paste into email. Ground it in approved policy context without revealing internal policy IDs. Never use placeholders such as [Your Name]; sign as Support Operations Team.";

async function generateWithOpenAiCompatible(
  ticket: TicketRecord,
  grounding: PolicyGrounding | undefined,
  options: { provider: "groq"; apiKey: string; model: string; baseUrl: string; redraft?: boolean },
): Promise<DraftResult> {
  const startedAt = Date.now();
  const models = [...new Set([options.model, "openai/gpt-oss-20b"])];
  let lastError = "Groq generation failed.";

  for (const model of models) {
    try {
      const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.15,
          max_tokens: 1200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: draftSystemPrompt },
            { role: "user", content: ticketPrompt(ticket, grounding, options.redraft) },
          ],
        }),
      });
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
        usage?: unknown;
      };
      if (!response.ok) throw new Error(payload.error?.message ?? `Groq request failed with ${response.status}`);
      const parsed = aiResponseSchema.parse(extractJson(payload.choices?.[0]?.message?.content ?? ""));
      const { classification, adjustments } = normalizeClassification(ticket, parsed);
      return withRunMetadata(
        {
          ...parsed,
          ...classification,
          draft: cleanDraftText(parsed.draft),
          provider: options.provider,
          model,
          policySourceIds: grounding?.citations.map((citation) => citation.id),
        },
        startedAt,
        routeReasonWithAdjustments(`AI_PROVIDER=groq routed to ${model}.`, adjustments),
        normalizeOpenAiUsage(payload.usage),
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Groq generation failed.";
    }
  }

  return withRunMetadata(
    fallbackDraft(ticket, "fallback_after_error", lastError, grounding),
    startedAt,
    "All Groq model attempts failed; deterministic fallback used.",
  );
}

async function generateWithGemini(ticket: TicketRecord, grounding?: PolicyGrounding, redraft = false): Promise<DraftResult> {
  const startedAt = Date.now();
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      return generateWithOpenAiCompatible(ticket, grounding, {
        provider: "groq",
        apiKey: groqKey,
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        baseUrl: "https://api.groq.com/openai/v1",
        redraft,
      });
    }
    return withRunMetadata(
      fallbackDraft(ticket, "fallback", "GEMINI_API_KEY and GROQ_API_KEY are not configured.", grounding),
      startedAt,
      "Live AI is not configured; deterministic fallback used.",
    );
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: draftSystemPrompt }] },
          contents: [{ role: "user", parts: [{ text: ticketPrompt(ticket, grounding, redraft) }] }],
          generationConfig: { temperature: 0.15, maxOutputTokens: 1200, responseMimeType: "application/json" },
        }),
      },
    );
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(payload.error?.message ?? `Gemini request failed with ${response.status}`);
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const parsed = aiResponseSchema.parse(extractJson(text));
    const { classification, adjustments } = normalizeClassification(ticket, parsed);
    return withRunMetadata(
      {
        ...parsed,
        ...classification,
        draft: cleanDraftText(parsed.draft),
        provider: "gemini",
        model,
        policySourceIds: grounding?.citations.map((citation) => citation.id),
      },
      startedAt,
      routeReasonWithAdjustments(`AI_PROVIDER=gemini routed to ${model}.`, adjustments),
      {
        inputTokens: payload.usageMetadata?.promptTokenCount,
        outputTokens: payload.usageMetadata?.candidatesTokenCount,
        totalTokens: payload.usageMetadata?.totalTokenCount,
      },
    );
  } catch (error) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      return generateWithOpenAiCompatible(ticket, grounding, {
        provider: "groq",
        apiKey: groqKey,
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        baseUrl: "https://api.groq.com/openai/v1",
        redraft,
      });
    }
    const note = error instanceof Error ? error.message : "Gemini generation failed.";
    return withRunMetadata(
      fallbackDraft(ticket, "fallback_after_error", note, grounding),
      startedAt,
      "Gemini request failed; deterministic fallback used.",
    );
  }
}

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
  options: { redraft?: boolean } = {},
): Promise<DraftResult> {
  const provider =
    process.env.AI_PROVIDER ||
    (process.env.GEMINI_API_KEY ? "gemini" : process.env.GROQ_API_KEY ? "groq" : process.env.ZAI_API_KEY ? "zai" : "anthropic");

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

  if (provider === "gemini") return generateWithGemini(ticket, grounding, options.redraft);

  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return generateWithGemini(ticket, grounding, options.redraft);
    return generateWithOpenAiCompatible(ticket, grounding, {
      provider: "groq",
      apiKey,
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      baseUrl: "https://api.groq.com/openai/v1",
      redraft: options.redraft,
    });
  }

  return generateWithAnthropic(ticket, grounding);
}
