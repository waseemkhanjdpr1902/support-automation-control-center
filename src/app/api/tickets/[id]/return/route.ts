import { assertReviewerAccess, handleRouteError, jsonError, jsonOk } from "@/lib/api-utils";
import { getTicket, updateTicket } from "@/lib/store";
import { returnTicketSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { id } = await params;
    const payload = returnTicketSchema.parse(await request.json());
    const authError = assertReviewerAccess(payload.reviewerRole, payload.reviewerCode);
    if (authError) return authError;

    const ticket = await getTicket(id);
    if (!ticket) return jsonError("Ticket not found.", 404);

    const updated = await updateTicket(
      id,
      { status: "needs_review" },
      {
        action: "returned_for_changes",
        actor: payload.reviewerRole,
        message: payload.note,
        metadata: { reviewerRole: payload.reviewerRole },
      },
    );
    return jsonOk({ ticket: updated });
  } catch (error) {
    return handleRouteError(error);
  }
}
