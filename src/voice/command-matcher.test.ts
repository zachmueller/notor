import { describe, it, expect } from "vitest";
import { normalizeSpoken, stripWakeWord } from "./command-matcher";

describe("normalizeSpoken", () => {
	it("lowercases, strips punctuation and collapses whitespace", () => {
		expect(normalizeSpoken("  Hey   Notor,  Approve! ")).toBe("hey notor approve");
		expect(normalizeSpoken("Ça va — très bien.")).toBe("ça va très bien");
	});
});

describe("stripWakeWord", () => {
	it("removes the wake word regardless of case and punctuation and keeps the rest verbatim", () => {
		expect(stripWakeWord("Hey Notor, approve.", "Hey Notor")).toBe("approve.");
		expect(stripWakeWord("hey notor answer Put it in the Inbox, please", "Hey Notor"))
			.toBe("answer Put it in the Inbox, please");
		expect(stripWakeWord("HEY NOTOR", "Hey Notor")).toBe("");
	});

	it("tolerates whisper's spellings of the wake word", () => {
		const spellings = ["Hey Notor", "Hey Nota", "Hey Noter"];
		expect(stripWakeWord("Hey Nota, summarize my inbox", spellings)).toBe("summarize my inbox");
		expect(stripWakeWord("Hey Noter. What's on my agenda?", "Hey Notor")).toBe("What's on my agenda?");
		expect(stripWakeWord("Hey motor, what's next", "Hey Notor")).toBe("what's next");
		expect(stripWakeWord("Hay no tor, cancel", "Hey Notor")).toBe("cancel");
		expect(stripWakeWord("Notor, status", "Hey Notor")).toBe("status");
	});

	it("removes a leftover tail of the wake word", () => {
		expect(stripWakeWord("tor, what's next?", "Hey Notor")).toBe("what's next?");
	});

	it("leaves transcripts without the wake word alone", () => {
		expect(stripWakeWord("  summarize my inbox ", "Hey Notor")).toBe("summarize my inbox");
		expect(stripWakeWord("or maybe tomorrow", "Hey Notor")).toBe("or maybe tomorrow");
		expect(stripWakeWord("please approve the change", "Hey Notor")).toBe("please approve the change");
		expect(stripWakeWord("I said hey notor approve", "Hey Notor")).toBe("I said hey notor approve");
		const spellings = ["Hey Notor", "Hey Nota"];
		expect(stripWakeWord("Note that I'm out tomorrow", spellings)).toBe("Note that I'm out tomorrow");
		expect(stripWakeWord("Not now", spellings)).toBe("Not now");
		expect(stripWakeWord("Doctor appointment at noon", spellings)).toBe("Doctor appointment at noon");
		expect(stripWakeWord("no, turn it off", spellings)).toBe("no, turn it off");
	});

	it("supports custom and single-word wake words and ignores blank ones", () => {
		expect(stripWakeWord("Computer, approve", "computer")).toBe("approve");
		expect(stripWakeWord("Okay Jarvis send it", "okay jarvis")).toBe("send it");
		expect(stripWakeWord("anything", "   ")).toBe("anything");
	});
});
