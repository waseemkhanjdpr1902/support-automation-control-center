import {
  assertReviewerAccess,
  handleRouteError,
  jsonError,
  jsonOk,
} from "@/lib/api-utils";
import { evaluateDraftSafety } from "@/lib/safety";
import { getTicket, updateTicket } from "@/lib/store";
import { approveTicketSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const payload = approveTicketSchema.parse(await request.json());
    const authError = assertReviewerAccess(payload.reviewerRole, payload.reviewerCode);

    if (authError) {
      return authError;
    }

    const ticket = await getTicket(id);

    if (!ticket) {
      return jsonError("Ticket not found.", 404);
    }

    const responseBody = payload.finalResponse ?? ticket.finalResponse ?? ticket.aiDraft;

    if (!responseBody) {
      return jsonError("No response draft is available for approval.", 409);
    }

    const safety = evaluateDraftSafety(ticket, responseBody);

    if (!safety.passed) {
      await updateTicket(
        id,
        {
          status: "needs_review",
          finalResponse: responseBody,
        },
        {
          action: "safety_flagged",
          actor: "safety-check",
          message: "Approval blocked because the response needs a safety edit.",
          metadata: { safety },
        },
      );

      return jsonError("Draft failed safety check. Edit before approval.", 409, { safety });
    }

    const approved = await updateTicket(
      id,
      {
        status: "approved",
        finalResponse: responseBody,
      },
      {
        action: "approved",
        actor: payload.reviewerRole,
        message: `${payload.reviewerRole.replace("_", " ")} approved the response for agent copy.`,
        metadata: { safety, reviewerRole: payload.reviewerRole },
      },
    );

    if (!approved) {
      return jsonError("Ticket not found.", 404);
    }

    return jsonOk({ ticket: approved });
  } catch (error) {
    return handleRouteError(error);
  }
}
