import { describe, it, expect } from "vitest";
import { matchVoiceCommand, normalizeSpoken } from "./command-matcher";

describe("normalizeSpoken", () => {
	it("lowercases, strips punctuation and collapses whitespace", () => {
		expect(normalizeSpoken("  Voice   Command,  Approve! ")).toBe("voice command approve");
		expect(normalizeSpoken("Ça va — très bien.")).toBe("ça va très bien");
	});
});

describe("matchVoiceCommand", () => {
	it("matches the phrase regardless of case and punctuation and returns the rest verbatim", () => {
		expect(matchVoiceCommand("Voice command, approve.", "voice command")).toEqual({ command: "approve." });
		expect(matchVoiceCommand("voice command answer Put it in the Inbox, please", "voice command"))
			.toEqual({ command: "answer Put it in the Inbox, please" });
		expect(matchVoiceCommand("VOICE COMMAND", "voice command")).toEqual({ command: "" });
	});

	it("tolerates whisper variants of the phrase", () => {
		expect(matchVoiceCommand("voice commands reject", "voice command")).toEqual({ command: "reject" });
		expect(matchVoiceCommand("Voice-command: repeat", "voice command")).toEqual({ command: "repeat" });
	});

	it("does not match when the phrase is absent, partial, or not at the start", () => {
		expect(matchVoiceCommand("please approve the change", "voice command")).toBeNull();
		expect(matchVoiceCommand("voice", "voice command")).toBeNull();
		expect(matchVoiceCommand("I said voice command approve", "voice command")).toBeNull();
		expect(matchVoiceCommand("voice comment approve", "voice command")).toBeNull();
	});

	it("supports custom and single-word trigger phrases and rejects blank ones", () => {
		expect(matchVoiceCommand("Hey Notor, cancel", "hey notor")).toEqual({ command: "cancel" });
		expect(matchVoiceCommand("Computer approve", "computer")).toEqual({ command: "approve" });
		expect(matchVoiceCommand("anything", "   ")).toBeNull();
	});
});
