import { describe, it, expect } from "vitest";
import { cacheKey, clean, enumerateLines } from "../scripts/bundle-audio.mjs";
import { createHash } from "node:crypto";
import questions from "../data/questions.json";
import local from "../data/local-answers.json";
import { allSpokenLines } from "./engine";

describe("audio bundler stays in sync with the app", () => {
  it("enumerates exactly the lines the engine can speak", () => {
    const { core, dynamic } = enumerateLines(questions, local) as { core: string[]; dynamic: string[] };
    expect(new Set([...core, ...dynamic])).toEqual(new Set(allSpokenLines()));
  });

  it("uses the original lib/tts.ts cache key", () => {
    const text = "  What is the supreme   law of the land? ";
    const expected = createHash("sha256")
      .update("Matthew|generative|What is the supreme law of the land?")
      .digest("hex")
      .slice(0, 32);
    expect(clean(text)).toBe("What is the supreme law of the land?");
    expect(cacheKey(text)).toBe(expected);
  });
});
