/**
 * Browser storage for the civics study data.
 *
 * The question bank is bundled into the app at build time (data/questions.json).
 * Progress and session history live in localStorage under the `civics:` prefix,
 * so everything stays on this device and works with no server at all.
 *
 * Every access is guarded for environments without `window` (static prerender,
 * vitest). There, an in-memory map stands in for localStorage, so the same code
 * paths run and nothing throws.
 */

import bank from "../data/questions.json";
import { emptyProgress, type Mode, type Progress, type Question } from "./mastery";

export const STORAGE_PREFIX = "civics:";
const PROGRESS_KEY = `${STORAGE_PREFIX}progress`;
const SESSIONS_KEY = `${STORAGE_PREFIX}sessions`;
/** Session history is a capped array; the oldest entries fall off first. */
export const MAX_SESSIONS = 200;

/** Fallback used when localStorage is unavailable (SSR, tests, privacy mode). */
const memory = new Map<string, string>();

function storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  if (typeof window !== "undefined") {
    try {
      const ls = window.localStorage;
      if (ls) return ls;
    } catch {
      // Access can throw in some privacy modes; fall through to memory.
    }
  }
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy-mode failure: progress for this answer is lost, the drill goes on.
  }
}

const questions = bank as Question[];

/** The 128-question bank, bundled at build time. */
export function loadQuestions(): Question[] {
  return questions;
}

export function questionById(id: number): Question | undefined {
  return questions.find((q) => q.id === id);
}

export function loadProgress(): Progress {
  const raw = readJson<Partial<Progress>>(PROGRESS_KEY);
  if (!raw || typeof raw !== "object") return emptyProgress();
  // A corrupt entry should not wedge the app; missing fields fall back to empty.
  return { step: raw.step ?? 0, q: raw.q ?? {}, log: Array.isArray(raw.log) ? raw.log : [] };
}

export function saveProgress(progress: Progress): void {
  writeJson(PROGRESS_KEY, progress);
}

export interface SessionRecord {
  startedAt: string;
  endedAt: string;
  mode: Mode;
  asked: number;
  correct: number;
  passed: boolean;
  results: Array<{ questionId: number; verdict: string; transcript: string; selfGraded?: boolean }>;
}

export function loadSessions(): SessionRecord[] {
  const raw = readJson<SessionRecord[]>(SESSIONS_KEY);
  return Array.isArray(raw) ? raw : [];
}

export function appendSession(record: SessionRecord): void {
  const all = [...loadSessions(), record];
  writeJson(SESSIONS_KEY, all.slice(-MAX_SESSIONS));
}

/** Replace the stored session that started at `startedAt` (after a self-grade correction). */
export function replaceSession(record: SessionRecord): void {
  const all = loadSessions();
  const index = all.map((s) => s.startedAt).lastIndexOf(record.startedAt);
  if (index === -1) return appendSession(record);
  all[index] = record;
  writeJson(SESSIONS_KEY, all);
}

/** Drop the stored session that started at `startedAt` (a finished exam that was reopened). */
export function removeSession(startedAt: string): void {
  const all = loadSessions();
  const index = all.map((s) => s.startedAt).lastIndexOf(startedAt);
  if (index === -1) return;
  all.splice(index, 1);
  writeJson(SESSIONS_KEY, all);
}

/** Erase all progress and session history on this device. */
export function resetProgress(): void {
  const s = storage();
  try {
    s.removeItem(PROGRESS_KEY);
    s.removeItem(SESSIONS_KEY);
  } catch {
    /* nothing stored */
  }
}
