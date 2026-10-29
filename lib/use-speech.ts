"use client";

/**
 * Browser speech in and out.
 *
 * Two constraints shape this file.
 *
 * 1. The officer's voice is audible to the microphone, so if both run at once the
 *    officer transcribes itself and the applicant's answer is polluted with the
 *    question. Recognition is hard-stopped for the whole time the officer speaks
 *    (bundled mp3 or browser speechSynthesis alike) and cannot be armed until the
 *    utterance ends.
 * 2. Speech output is fully offline. Pre-recorded lines ship as mp3s listed in
 *    `audio/manifest.json` (built by scripts/bundle-audio.mjs); anything not in
 *    the manifest is spoken by the browser's own en-US voice.
 * 3. Two listening styles are needed. Push-to-talk sets `continuous = true` so a
 *    pause mid-answer does not cut you off. Hands-free sets `continuous = false`
 *    and lets Chrome's own end-of-speech detection act as a voice activity
 *    detector, which is what makes auto-listen possible without extra machinery.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  0: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResult };
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Set at build time; "" at the site root, "/civics-trainer" under a GitHub Pages project. */
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

/** Same normalization the bundler keys the manifest by (lib/tts.ts `clean`). */
const cleanLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 2800);

let manifestPromise: Promise<Record<string, string>> | null = null;
function loadManifest(): Promise<Record<string, string>> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE_PATH}/audio/manifest.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
      .catch(() => ({}));
  }
  return manifestPromise;
}

/** URL of the bundled recording for a line, or null when there is none. */
export async function audioUrlFor(text: string): Promise<string | null> {
  const file = (await loadManifest())[cleanLine(text)];
  return file ? `${BASE_PATH}/audio/${file}` : null;
}

/**
 * Fetch the bundled recording for a line. Returns null when the line has no
 * recording (or it fails to load), so callers fall back to the browser voice.
 */
export async function fetchSpeech(text: string): Promise<Blob | null> {
  try {
    const url = await audioUrlFor(text);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/** Best available en-US voice; voices load asynchronously in Chrome. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  const us = voices.filter((v) => v.lang.replace("_", "-").toLowerCase() === "en-us");
  return (
    us.find((v) => /google us english/i.test(v.name)) ??
    us.find((v) => /samantha|alex|aaron|natural/i.test(v.name)) ??
    us.find((v) => v.localService) ??
    us[0] ??
    voices.find((v) => v.lang.toLowerCase().startsWith("en")) ??
    null
  );
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  // Touch the list early so it is populated by the first utterance.
  window.speechSynthesis.getVoices();
}

export interface UseSpeech {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  transcript: string;
  startListening: () => void;
  stopListening: () => void;
  /** Hands-free: listen until Chrome detects the end of speech, then resolve. */
  listenOnce: () => Promise<string>;
  clearTranscript: () => void;
  speak: (text: string, audio?: Blob | null) => Promise<void>;
  cancelSpeech: () => void;
  error: string | null;
}

export function useSpeech(): UseSpeech {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  /** Guards the feedback loop: recognition must never start while this is true. */
  const speakingRef = useRef(false);
  const finalRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Resolver for an in-flight audio clip, so cancelSpeech can end the wait. */
  const audioDone = useRef<(() => void) | null>(null);
  /** Resolver for an in-flight browser utterance, so cancelSpeech can end the wait. */
  const synthDone = useRef<(() => void) | null>(null);
  /** Resolver for an in-flight listenOnce(). */
  const onceResolve = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setSupported(true);

    const rec = new Ctor();
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) finalRef.current += `${text} `;
        else interim += text;
      }
      setTranscript(`${finalRef.current}${interim}`.replace(/\s+/g, " ").trim());
    };

    rec.onerror = (event) => {
      const code = event.error ?? "unknown";
      // "no-speech" and "aborted" are normal outcomes, not failures.
      if (code !== "no-speech" && code !== "aborted") {
        setError(
          code === "not-allowed"
            ? "Microphone permission denied. Allow it in the address bar, or type your answer."
            : `Speech recognition error: ${code}`,
        );
      }
      setListening(false);
    };

    rec.onend = () => {
      setListening(false);
      const resolve = onceResolve.current;
      if (resolve) {
        onceResolve.current = null;
        resolve(finalRef.current.replace(/\s+/g, " ").trim());
      }
    };

    recognition.current = rec;
    return () => {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    };
  }, []);

  const armed = useCallback((continuous: boolean) => {
    const rec = recognition.current;
    if (!rec || speakingRef.current) return null;
    rec.continuous = continuous;
    setError(null);
    finalRef.current = "";
    setTranscript("");
    return rec;
  }, []);

  const startListening = useCallback(() => {
    // continuous: a pause mid-answer must not end the turn.
    const rec = armed(true);
    if (!rec) return;
    try {
      rec.start();
      setListening(true);
    } catch {
      /* already running */
    }
  }, [armed]);

  const stopListening = useCallback(() => {
    try {
      recognition.current?.stop();
    } catch {
      /* not running */
    }
    setListening(false);
  }, []);

  const listenOnce = useCallback(async () => {
    // non-continuous: Chrome's end-of-speech detection ends the turn for us.
    const rec = armed(false);
    if (!rec) return "";
    return new Promise<string>((resolve) => {
      onceResolve.current = resolve;
      try {
        rec.start();
        setListening(true);
      } catch {
        onceResolve.current = null;
        resolve("");
      }
    });
  }, [armed]);

  const clearTranscript = useCallback(() => {
    finalRef.current = "";
    setTranscript("");
  }, []);

  /**
   * Browser voice for lines without a recording. Resolves on `onend` (or error),
   * which is what releases the microphone guard in `speak`. Chrome occasionally
   * never fires `onend`, so a length-based safety timer resolves it regardless;
   * otherwise the mic would stay muted forever.
   */
  const speakWithBrowser = (text: string) =>
    new Promise<void>((resolve) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return resolve();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 4000 + text.length * 110);
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = "en-US";
      utterance.rate = 0.97;
      utterance.onend = done;
      utterance.onerror = done;
      synthDone.current = done;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });

  const speak = useCallback(async (text: string, audio?: Blob | null) => {
    if (!text.trim()) return;

    // Stop the mic before a single word is spoken, not after.
    try {
      recognition.current?.abort();
    } catch {
      /* not running */
    }
    setListening(false);
    speakingRef.current = true;
    setSpeaking(true);

    try {
      const blob = audio ?? (await fetchSpeech(text));
      if (!blob) {
        await speakWithBrowser(text);
        return;
      }
      const url = URL.createObjectURL(blob);
      const element = new Audio(url);
      audioRef.current = element;
      const played = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(url);
          resolve(ok);
        };
        audioDone.current = () => done(true);
        element.onended = () => done(true);
        element.onerror = () => done(false);
        void element.play().catch(() => done(false));
      });
      // A clip that would not play (autoplay policy, decode error): say it anyway.
      if (!played && speakingRef.current) await speakWithBrowser(text);
    } finally {
      audioDone.current = null;
      synthDone.current = null;
      audioRef.current = null;
      speakingRef.current = false;
      setSpeaking(false);
    }
  }, []);

  const cancelSpeech = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    audioDone.current?.();
    synthDone.current?.();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  return {
    supported,
    listening,
    speaking,
    transcript,
    startListening,
    stopListening,
    listenOnce,
    clearTranscript,
    speak,
    cancelSpeech,
    error,
  };
}
