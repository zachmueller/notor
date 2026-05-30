import { scaffold } from "./_scaffold-helper";

export const ASK_USER = scaffold(
	"ask_user",
	"Ask the user one or more follow-up questions and wait for their answers before continuing. Use this when you need clarification, a decision, or missing information to proceed correctly — instead of guessing or ending your turn. Provide concise suggested answers when there are likely choices; the user can pick a suggestion or type a free-text reply. Keep to a few focused questions (max 5).",
	"read",
	`params:
  questions:
    type: "object[]"
    description: "The follow-up questions to ask (1-5). Each renders with optional suggested-answer chips and a free-text input."
    properties:
      question:
        type: string
        description: "The question text shown to the user."
      suggestions:
        type: "string[]"
        description: "Optional suggested answers rendered as clickable chips."
    required_items:
      - question`,
	`const log = utils.logger("ask_user");

const rawQuestions = params.questions;
if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
  throw new Error("Missing or invalid required parameter: questions (must be a non-empty array).");
}
if (rawQuestions.length > 5) {
  throw new Error("Too many questions: " + rawQuestions.length + ". Ask at most 5 questions per call.");
}

// Normalize and validate each question.
const questions = rawQuestions.map((q, i) => {
  const question = (q && typeof q === "object" ? q.question : undefined);
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("questions[" + i + "].question must be a non-empty string.");
  }
  const suggestions = Array.isArray(q.suggestions)
    ? q.suggestions.filter((s) => typeof s === "string" && s.trim().length > 0)
    : undefined;
  return { question: question.trim(), suggestions };
});

if (utils.abortSignal?.aborted) {
  throw new Error("ask_user cancelled before any question was answered.");
}

// Render all questions together and await every answer. utils.ask suspends the
// tool loop until the user responds (or aborts, which throws).
const answers = await Promise.all(
  questions.map((q) => utils.ask(q.question, { suggestions: q.suggestions, allowFreeText: true }))
);

// utils.ask returns null only when no interaction channel is wired (headless /
// background / sub-agent contexts). Do NOT coerce that to a blank string — the
// model would mistake an empty answer for the user's response. Surface a clear
// error instead so the caller knows ask_user is unavailable in this context.
if (utils.abortSignal?.aborted) {
  throw new Error("ask_user cancelled before all questions were answered.");
}
if (answers.some((a) => a == null)) {
  throw new Error(
    "ask_user requires an interactive chat panel; no interaction channel was available in this context (e.g. a background or sub-agent run). Proceed without asking, or surface the questions in your reply."
  );
}

const items = questions.map((q, i) => ({
  question: q.question,
  suggestions: q.suggestions ?? [],
  answer: answers[i] ?? "",
}));

log.info("ask_user answered", { count: items.length });

// Persist the full Q&A so it re-renders on conversation reload.
try {
  await utils.chatBlocks?.emit("interaction", { items });
} catch (e) {
  log.warn("Failed to persist interaction block", { error: String(e) });
}

return { answers: items.map((it) => ({ question: it.question, answer: it.answer })) };`,
);
