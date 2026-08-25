import { handleRouteError, jsonError, jsonOk } from "@/lib/api-utils";
import { generateTicketDraft } from "@/lib/ai";
import { retrievePolicyGrounding } from "@/lib/policies";
import { evaluateDraftSafety } from "@/lib/safety";
import { getTicket, updateTicket } from "@/lib/store";
import { draftTicketSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const payload = await request.json().catch(() => ({}));
    const { redraft } = draftTicketSchema.parse(payload);
    const ticket = await getTicket(id);

    if (!ticket) {
      return jsonError("Ticket not found.", 404);
    }

    const policyGrounding = retrievePolicyGrounding(ticket);
    const draft = await generateTicketDraft(ticket, policyGrounding, { redraft });
    const safety = evaluateDraftSafety(
      {
        intent: draft.intent,
        priority: draft.priority,
        sentiment: draft.sentiment,
      },
      draft.draft,
    );
    const usage: Record<string, number> = {};

    if (draft.inputTokens !== undefined) usage.inputTokens = draft.inputTokens;
    if (draft.outputTokens !== undefined) usage.outputTokens = draft.outputTokens;
    if (draft.totalTokens !== undefined) usage.totalTokens = draft.totalTokens;

    const metadata: Record<string, unknown> = {
      provider: draft.provider,
      model: draft.model,
      latencyMs: draft.latencyMs,
      routeReason: draft.routeReason,
      estimatedCostUsd: draft.estimatedCostUsd,
      usage,
      policyGrounding,
      policySourceIds: draft.policySourceIds ?? policyGrounding.citations.map((citation) => citation.id),
      safety,
    };

    if (draft.note) {
      metadata.note = draft.note;
    }

    const updated = await updateTicket(
      id,
      {
        status: ticket.source === "manual" || safety.severity !== "none" ? "needs_review" : "drafted",
        intent: draft.intent,
        sentiment: draft.sentiment,
        priority: draft.priority,
        aiDraft: draft.draft,
        finalResponse: draft.draft,
        aiProvider: draft.provider,
        aiModel: draft.model,
      },
      {
        action: "ai_drafted",
        actor: draft.provider,
        message:
          safety.severity === "none"
            ? ["gemini", "groq", "anthropic", "zai"].includes(draft.provider)
              ? `${draft.provider} classified the message and drafted a response.`
              : "Safe fallback generated a basic acknowledgement because live AI is not configured."
            : `Draft generated with ${safety.severity} safety review flag.`,
        metadata,
      },
    );

    return jsonOk({ ticket: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
