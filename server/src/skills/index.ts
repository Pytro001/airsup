import { registerSkill } from "./runner.js";
import { projectRouter } from "./project-router.js";
import { signup } from "./signup.js";
import { understandAndConfirm } from "./understand-and-confirm.js";
import { handleBuyerMessage } from "./handle-buyer-message.js";
import { kickoffResearch } from "./kickoff-research.js";
import { match } from "./match.js";
import { outreach } from "./outreach.js";
import { replyHandler } from "./reply-handler.js";
import { qaLoop } from "./qa-loop.js";
import { decompose } from "./decompose.js";
import { quoteSummary } from "./quote-summary.js";
import { paymentTrigger } from "./payment-trigger.js";
import { handover } from "./handover.js";
import { dailyDigest } from "./daily-digest.js";
import { relayBuyerAnswer } from "./relay-buyer-answer.js";
import { tryNextCandidate } from "./try-next-candidate.js";
import { sendStatus } from "./send-status.js";

export function registerAllSkills(): void {
  registerSkill("project-router", projectRouter);
  registerSkill("signup", signup);
  registerSkill("understand-and-confirm", understandAndConfirm);
  registerSkill("handle-buyer-message", handleBuyerMessage);
  registerSkill("kickoff-research", kickoffResearch);
  registerSkill("match", match);
  registerSkill("outreach", outreach);
  registerSkill("reply-handler", replyHandler);
  registerSkill("qa-loop", qaLoop);
  registerSkill("decompose", decompose);
  registerSkill("quote-summary", quoteSummary);
  registerSkill("payment-trigger", paymentTrigger);
  registerSkill("handover", handover);
  registerSkill("daily-digest", dailyDigest);
  registerSkill("relay-buyer-answer", relayBuyerAnswer);
  registerSkill("try-next-candidate", tryNextCandidate);
  registerSkill("send-status", sendStatus);
}

export { triggerSkill } from "./runner.js";
