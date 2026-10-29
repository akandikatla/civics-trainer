"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { audioUrlFor, fetchSpeech, useSpeech } from "@/lib/use-speech";
import {
  EngineError,
  answer as answerTurn,
  getStats,
  override as overrideTurn,
  startInterview,
  type CellState,
  type Mode,
  type Stats,
  type TurnResponse,
} from "@/lib/engine";
import { resetProgress } from "@/lib/store";
import { clearInterviews } from "@/lib/interview";
import { loadLocalAnswers } from "@/lib/local-answers";
import type { ExamTally } from "@/lib/mastery";
import { APPROX_DOWNLOAD_MB, getModelState, loadModelGrader, subscribeModel, type ModelState } from "@/lib/model-runtime";
import { installDebugHook } from "@/lib/debug-hook";

type Verdict = "correct" | "risky" | "wrong" | "unintelligible";
type Tally = ExamTally;
type Cell = Stats["cells"][number];

const EMPTY_TALLY: Tally = { asked: 0, correct: 0, remainingToPass: 12, passed: false, failed: false };

const VERDICT_COLOR: Record<Verdict, string> = {
  correct: "var(--mastered)",
  risky: "var(--confirm)",
  wrong: "var(--lapsed)",
  unintelligible: "var(--ink)",
};
const VERDICT_WORD: Record<Verdict, string> = {
  correct: "correct",
  risky: "accepted, but not the official wording",
  wrong: "not correct",
  unintelligible: "didn't catch that",
};
const CELL_COLOR: Record<CellState, string> = {
  mastered: "var(--mastered-quiet)",
  confirm: "var(--confirm)",
  lapsed: "var(--lapsed)",
  unseen: "var(--ink-faint)",
};

const formatUs = (us: number) => `${Math.round(us).toLocaleString("en-US")} µs`;

export default function Home() {
  const speech = useSpeech();

  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [turn, setTurn] = useState<TurnResponse | null>(null);
  const [tally, setTally] = useState<Tally>(EMPTY_TALLY);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [problem, setProblem] = useState<{ error: string; hint?: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [handsFree, setHandsFree] = useState(true);
  const [listenNonce, setListenNonce] = useState(0);
  /** Cells that just became mastered, driving the one bit of motion on the page. */
  const [justLocked, setJustLocked] = useState<number[]>([]);

  const holdingSpace = useRef(false);
  const [model, setModel] = useState<ModelState>(getModelState);

  // The grading model loads in the background from this site (lib/model-runtime.ts).
  // Answers given before it is ready are graded by the offline tiers.
  useEffect(() => {
    installDebugHook();
    const unsubscribe = subscribeModel(setModel);
    const start = window.setTimeout(() => void loadModelGrader(), 0);
    return () => {
      window.clearTimeout(start);
      unsubscribe();
    };
  }, []);

  const refreshStats = useCallback(() => {
    try {
      setStats(getStats());
    } catch {
      /* stats are decoration; never block the drill on them */
    }
  }, []);

  useEffect(refreshStats, [refreshStats]);

  // Load the audio manifest early so the first question plays without a wait.
  useEffect(() => {
    void audioUrlFor("");
  }, []);

  /** Apply a turn returned by the engine to the page state. */
  const applyTurn = useCallback((data: TurnResponse) => {
    setInterviewId(data.interviewId);
    setMode(data.mode);
    setTurn(data);
    setTally(data.tally);
    setFinished(data.finished);
    if (data.questionMastered && data.answeredQuestionId != null) {
      const locked = data.answeredQuestionId;
      setJustLocked((l) => [...l, locked]);
      setTimeout(() => setJustLocked((l) => l.filter((x) => x !== locked)), 700);
    }
  }, []);

  const run = useCallback(
    async (step: () => TurnResponse | Promise<TurnResponse>): Promise<TurnResponse | null> => {
      setBusy(true);
      setProblem(null);
      try {
        const data = await step();
        applyTurn(data);
        return data;
      } catch (err) {
        setProblem({ error: err instanceof Error ? err.message : "Something went wrong." });
        if (err instanceof EngineError && err.expired) {
          setInterviewId(null);
          setFinished(true);
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [applyTurn],
  );

  /**
   * Speak the officer's lines in order, then hand the microphone back. All parts
   * are fetched concurrently up front, so the question's recording is already
   * loaded by the time the feedback line finishes.
   */
  const speakParts = useCallback(
    async (parts: string[]) => {
      const lines = parts.map((p) => p.trim()).filter(Boolean);
      const blobs = await Promise.all(lines.map((line) => fetchSpeech(line)));
      for (let i = 0; i < lines.length; i++) await speech.speak(lines[i], blobs[i]);
    },
    [speech],
  );

  const deliver = useCallback(
    async (data: TurnResponse | null) => {
      if (!data) return;
      await speakParts(data.sayParts?.length ? data.sayParts : [data.say]);
      refreshStats();
    },
    [speakParts, refreshStats],
  );

  const submit = useCallback(
    async (text: string) => {
      const answer = text.trim();
      if (!answer || !interviewId || busy || finished) return;
      speech.clearTranscript();
      setTyped("");
      await deliver(await run(() => answerTurn(interviewId, answer)));
    },
    [interviewId, busy, finished, run, deliver, speech],
  );

  const start = useCallback(
    async (chosen: Mode, starredOnly = false) => {
      speech.cancelSpeech();
      setTally(EMPTY_TALLY);
      setFinished(false);
      setInterviewId(null);
      setTurn(null);
      await deliver(await run(() => startInterview(chosen, starredOnly)));
    },
    [run, deliver, speech],
  );

  /**
   * Self-grade after a wrong verdict. Replaces the recorded verdict in place; only
   * speaks when the correction changes how the exam ends.
   */
  const correctLast = useCallback(
    async (verdict: "correct" | "risky") => {
      if (!interviewId) return;
      setProblem(null);
      try {
        const out = overrideTurn(interviewId, verdict);
        setTally(out.tally);
        setTurn((t) =>
          t
            ? { ...t, verdict: out.verdict, selfGraded: true, canRevise: false, questionMastered: out.questionMastered, tally: out.tally }
            : t,
        );
        if (out.questionMastered) {
          setJustLocked((l) => [...l, out.questionId]);
          setTimeout(() => setJustLocked((l) => l.filter((x) => x !== out.questionId)), 700);
        }
        refreshStats();
        if (out.next) {
          speech.cancelSpeech();
          applyTurn(out.next);
          await deliver(out.next);
        }
      } catch (err) {
        setProblem({ error: err instanceof Error ? err.message : "That correction failed." });
      }
    },
    [interviewId, applyTurn, deliver, refreshStats, speech],
  );

  const reset = useCallback(() => {
    if (!window.confirm("Erase all progress on this device? This cannot be undone.")) return;
    speech.cancelSpeech();
    resetProgress();
    clearInterviews();
    setInterviewId(null);
    setMode(null);
    setTurn(null);
    setTally(EMPTY_TALLY);
    setFinished(false);
    setProblem(null);
    refreshStats();
  }, [speech, refreshStats]);

  const canAnswer = Boolean(interviewId) && !busy && !finished && !speech.speaking;

  // Hands-free. Deps are primitives only: `useSpeech()` returns a fresh object each
  // render, so depending on it re-ran this on every interim transcript and the
  // cleanup cancelled the in-flight listen before it could submit.
  const listenInFlight = useRef(false);
  const submitRef = useRef(submit);
  const listenOnceRef = useRef(speech.listenOnce);
  useEffect(() => {
    submitRef.current = submit;
    listenOnceRef.current = speech.listenOnce;
  }, [submit, speech.listenOnce]);

  useEffect(() => {
    if (!handsFree || !canAnswer || !speech.supported || listenInFlight.current) return;
    listenInFlight.current = true;
    void (async () => {
      try {
        const heard = await listenOnceRef.current();
        if (heard.trim()) submitRef.current(heard);
        else {
          await new Promise((r) => setTimeout(r, 400));
          setListenNonce((n) => n + 1);
        }
      } finally {
        listenInFlight.current = false;
      }
    })();
  }, [handsFree, canAnswer, speech.supported, listenNonce]);

  useEffect(() => {
    const typing = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target) || holdingSpace.current || !canAnswer) return;
      e.preventDefault();
      holdingSpace.current = true;
      speech.startListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !holdingSpace.current) return;
      e.preventDefault();
      holdingSpace.current = false;
      speech.stopListening();
      setTimeout(() => void submit(speech.transcript), 300);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [canAnswer, speech, submit]);

  const verdict = turn?.verdict ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-[54rem] flex-col gap-7 px-6 py-8">
      <Ribbon stats={stats} timing={turn?.timing} />
      <Modes current={mode} busy={busy} onStart={start} />

      {!speech.supported && (
        <Notice tone="confirm">Voice needs Chrome. Type your answers instead; grading is identical.</Notice>
      )}
      {(problem || speech.error) && (
        <Notice tone="lapsed">
          {problem?.error ?? speech.error}
          {problem?.hint && <span className="mt-1 block opacity-80">{problem.hint}</span>}
        </Notice>
      )}
      {stats && stats.skipped.length > 0 && (
        <Notice tone="confirm">
          {stats.skipped.length} questions need answers only you can supply, in
          data/local-answers.json. They stay out of the rotation until then.
        </Notice>
      )}
      <LocalNote />
      <GraderStatus model={model} />

      <QuestionPlate turn={turn} mode={mode} tally={tally} />

      {interviewId && (
      <AnswerChannel
        speech={speech}
        busy={busy}
        handsFree={handsFree}
        canAnswer={canAnswer}
        verdict={verdict}
        turn={turn}
        modelStatus={model.status}
        onCorrect={correctLast}
      />
      )}

      <Controls
        speech={speech}
        canAnswer={canAnswer}
        handsFree={handsFree}
        setHandsFree={setHandsFree}
        typed={typed}
        setTyped={setTyped}
        onSubmit={submit}
        enabled={Boolean(interviewId) && !busy && !finished}
      />

      {mode === "exam" && interviewId && <Scoreboard tally={tally} />}

      <StatusCard stats={stats} currentId={turn?.currentQuestionId ?? null} justLocked={justLocked} />

      <footer className="rule flex flex-wrap items-baseline justify-between gap-4 border-t pt-4 text-[10px]">
        <span style={{ color: "var(--ink-faint)" }}>
          Progress is saved in this browser only. Grading runs on this device: the grading model downloads once
          from this site and is kept in the browser, so it works offline after that.
        </span>
        <button onClick={reset} className="underline underline-offset-2" style={{ color: "var(--ink-faint)" }}>
          reset progress
        </button>
      </footer>
    </main>
  );
}

/** Thin top strip. Counts rather than labels: the numbers carry their own meaning. */
function Ribbon({ stats, timing }: { stats: Stats | null; timing?: TurnResponse["timing"] }) {
  const pct = stats ? Math.round((stats.mastered / Math.max(1, stats.total)) * 100) : 0;
  return (
    <header className="rule flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-b pb-4 text-[11px]">
      <div className="flex items-baseline gap-3">
        <span className="text-[15px] tracking-[0.34em]" style={{ color: "var(--plate)" }}>
          civics
        </span>
        <span style={{ color: "var(--ink-faint)" }}>naturalization interview drill</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {stats && (
          <>
            <span>
              <b className="bloom text-[13px] font-normal" style={{ color: "var(--mastered)" }}>
                {stats.mastered}
              </b>
              <span style={{ color: "var(--ink-faint)" }}> of {stats.total} locked in, {pct}%</span>
            </span>
            <span style={{ color: "var(--ink-faint)" }}>
              {stats.starredMastered}/{stats.starredTotal} of the senior 20
            </span>
          </>
        )}
        {timing && (
          <span style={{ color: "var(--ink-faint)" }} title="Time the grader took on your last answer, on this device">
            graded by the {timing.pipeline === "offline" ? "offline matcher" : "model"}, {formatUs(timing.gradeUs)}
          </span>
        )}
      </div>
    </header>
  );
}

function Modes({
  current,
  busy,
  onStart,
}: {
  current: Mode | null;
  busy: boolean;
  onStart: (m: Mode, starred?: boolean) => void;
}) {
  const items = [
    { label: "mock interview", note: "20 questions, stops at 12 right", go: () => onStart("exam"), on: current === "exam" },
    { label: "every question", note: "all 128, shuffled, endlessly", go: () => onStart("loop"), on: current === "loop" },
    { label: "weakest first", note: "until the set is clean", go: () => onStart("practice"), on: current === "practice" },
    { label: "the senior 20", note: "the starred subset only", go: () => onStart("loop", true), on: false },
  ];
  return (
    <nav className="flex flex-wrap gap-x-7 gap-y-3 text-[12px]">
      {items.map((i) => (
        <button
          key={i.label}
          onClick={i.go}
          disabled={busy}
          className="group text-left disabled:opacity-30"
          style={{ color: i.on ? "var(--plate)" : "var(--ink)" }}
        >
          <span
            className="border-b pb-0.5 transition-colors group-hover:border-current"
            style={{ borderColor: i.on ? "var(--plate)" : "transparent" }}
          >
            {i.label}
          </span>
          <span className="mt-1 block text-[10px]" style={{ color: "var(--ink-faint)" }}>
            {i.note}
          </span>
        </button>
      ))}
    </nav>
  );
}

/**
 * The hero. A question set as a document: serif, paper white, the only large type
 * and the only paper-white element on the page, so the eye has exactly one place
 * to land while you are listening rather than reading.
 */
function QuestionPlate({ turn, mode, tally }: { turn: TurnResponse | null; mode: Mode | null; tally: Tally }) {
  if (!turn) {
    return (
      <section className="rule flex min-h-[13rem] flex-col justify-center border-y py-10">
        <p className="question-plate max-w-[34ch] opacity-40">Pick a mode and the officer starts asking.</p>
        <p className="mt-5 max-w-[62ch] text-[12px] leading-relaxed" style={{ color: "var(--ink-faint)" }}>
          You answer out loud. Every question comes up in the endless mode, and anything you miss returns a
          few questions later, alternating with whatever sits one right answer from being locked in.
        </p>
      </section>
    );
  }

  const context =
    mode === "loop" && turn.cycle
      ? `pass ${turn.cycle}, question ${turn.cyclePosition} of ${turn.cycleTotal}`
      : mode === "exam"
        ? `${tally.asked} asked, ${tally.correct} right, ${tally.remainingToPass} more to pass`
        : "working through your weakest";

  return (
    <section className="rule min-h-[13rem] border-y py-8">
      <div className="mb-5 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px]">
        <span style={{ color: "var(--ink-faint)" }}>{context}</span>
        {turn.pick === "repair" && <span style={{ color: "var(--lapsed)" }}>you missed this one</span>}
        {turn.pick === "confirm" && (
          <span className="bloom" style={{ color: "var(--confirm)" }}>
            one right answer locks this in
          </span>
        )}
        {turn.starred && <span style={{ color: "var(--confirm)" }}>senior 20</span>}
      </div>

      <p className="question-plate max-w-[30ch]">{turn.questionOnly ?? "That is the end of the set."}</p>

      <div className="mt-5 flex flex-wrap items-baseline gap-x-5 text-[11px]" style={{ color: "var(--ink-faint)" }}>
        {turn.section && <span>{turn.section.toLowerCase()}</span>}
        {turn.currentQuestionId && <span>question {turn.currentQuestionId}</span>}
      </div>
    </section>
  );
}

/** What the machine heard, and what it made of it. */
function AnswerChannel({
  speech,
  busy,
  handsFree,
  canAnswer,
  verdict,
  turn,
  modelStatus,
  onCorrect,
}: {
  speech: ReturnType<typeof useSpeech>;
  busy: boolean;
  handsFree: boolean;
  canAnswer: boolean;
  verdict: Verdict | null;
  turn: TurnResponse | null;
  modelStatus: ModelState["status"];
  onCorrect: (v: "correct" | "risky") => void;
}) {
  const status = speech.speaking
    ? "the officer is speaking"
    : busy
      ? "grading"
      : speech.listening
        ? "listening"
        : handsFree && canAnswer
          ? "opening the microphone"
          : "";

  return (
    <section className="space-y-4">
      <div className="flex min-h-[2.2rem] items-baseline gap-3">
        <span
          aria-hidden
          className={speech.listening ? "breathe" : ""}
          style={{ color: speech.listening ? "var(--mastered)" : "var(--ink-faint)" }}
        >
          {speech.listening ? "●" : "○"}
        </span>
        <p className="flex-1 text-[15px]" style={{ color: speech.transcript ? "var(--plate)" : "var(--ink-faint)" }}>
          {speech.transcript || status || "—"}
        </p>
        {speech.transcript && (
          <button
            onClick={speech.clearTranscript}
            className="text-[11px] underline underline-offset-2"
            style={{ color: "var(--ink-faint)" }}
          >
            that is not what I said
          </button>
        )}
      </div>

      {verdict && (
        <div className="border-l-2 pl-4" style={{ borderColor: VERDICT_COLOR[verdict] }}>
          <p className="bloom text-[13px]" style={{ color: VERDICT_COLOR[verdict] }}>
            {VERDICT_WORD[verdict]}
            {turn?.questionMastered && <span style={{ color: "var(--mastered)" }}> and locked in</span>}
            {turn?.selfGraded && <span style={{ color: "var(--ink-faint)" }}> (your own call)</span>}
          </p>
          {verdict === "wrong" && turn?.canRevise && (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px]">
              <span style={{ color: "var(--ink-faint)" }}>graded wrong by mistake?</span>
              <button
                onClick={() => onCorrect("correct")}
                className="border-b pb-0.5"
                style={{ color: "var(--mastered)", borderColor: "var(--mastered)" }}
              >
                I said it right
              </button>
              <button
                onClick={() => onCorrect("risky")}
                className="border-b pb-0.5"
                style={{ color: "var(--confirm)", borderColor: "var(--confirm)" }}
              >
                Close, but not exact
              </button>
            </div>
          )}
          {turn?.matchedAnswer && verdict !== "wrong" && (
            <p className="mt-1 text-[11px]" style={{ color: "var(--ink-faint)" }}>
              matched {turn.matchedAnswer}
            </p>
          )}
          {turn?.officialAnswers && (
            <ul className="mt-3 space-y-1 text-[12px]">
              {turn.officialAnswers.map((a) => (
                <li key={a} style={{ color: "var(--plate)" }}>
                  {a}
                </li>
              ))}
            </ul>
          )}
          {turn?.timing?.pipeline === "offline" && modelStatus !== "failed" && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--ink-faint)" }}>
              Graded by the offline matcher; the grading model was still loading.
            </p>
          )}
          {turn?.citationRejected && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--lapsed)" }}>
              The grader matched an answer that is not on the official list, so it does not count.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Controls({
  speech,
  canAnswer,
  handsFree,
  setHandsFree,
  typed,
  setTyped,
  onSubmit,
  enabled,
}: {
  speech: ReturnType<typeof useSpeech>;
  canAnswer: boolean;
  handsFree: boolean;
  setHandsFree: (v: boolean) => void;
  typed: string;
  setTyped: (v: string) => void;
  onSubmit: (t: string) => void;
  enabled: boolean;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-6 text-[11px]">
        <button
          onMouseDown={() => canAnswer && speech.startListening()}
          onMouseUp={() => {
            if (!speech.listening) return;
            speech.stopListening();
            setTimeout(() => onSubmit(speech.transcript), 300);
          }}
          disabled={!canAnswer}
          className="border-b pb-1 transition-colors disabled:opacity-25"
          style={{
            color: speech.listening ? "var(--plate)" : "var(--ink)",
            borderColor: speech.listening ? "var(--plate)" : "var(--ink-faint)",
          }}
        >
          {speech.listening ? "release to answer" : handsFree ? "or hold space to talk" : "hold space to talk"}
        </button>

        <label className="flex cursor-pointer items-center gap-2" style={{ color: "var(--ink-faint)" }}>
          <input
            type="checkbox"
            checked={handsFree}
            onChange={(e) => setHandsFree(e.target.checked)}
            className="h-3 w-3 accent-current"
          />
          hands-free
        </label>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(typed);
        }}
        className="rule flex items-baseline gap-3 border-b pb-2"
      >
        <span aria-hidden style={{ color: "var(--ink-faint)" }}>
          &gt;
        </span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="or type it"
          disabled={!enabled}
          className="w-full bg-transparent text-[14px] focus:outline-none disabled:opacity-40"
          style={{ color: "var(--plate)" }}
        />
      </form>
    </section>
  );
}

/**
 * The mock interview drawn as what it actually is: twenty slots with the threshold
 * marked after the twelfth. A percentage bar would bury the one number that decides
 * the outcome, which is that the twelfth right answer ends the test.
 */
function Scoreboard({ tally }: { tally: Tally }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end gap-[3px]">
        {Array.from({ length: 20 }, (_, i) => {
          const right = i < tally.correct;
          const missed = i >= tally.correct && i < tally.asked;
          return (
            <div key={i} className="flex flex-col items-center gap-1" style={{ width: 18 }}>
              <div
                className="w-full"
                style={{
                  height: 26,
                  borderRadius: 1,
                  background: right ? "var(--mastered)" : missed ? "var(--lapsed)" : "transparent",
                  border: right || missed ? "none" : "1px solid var(--ink-faint)",
                }}
                title={right ? "right" : missed ? "missed" : "not asked yet"}
              />
              {i === 11 && (
                <span className="text-[9px] leading-none" style={{ color: "var(--plate)" }}>
                  12
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
        {tally.passed
          ? "Twelve right. On the real test the officer stops here."
          : tally.failed
            ? "Twelve is out of reach in this set."
            : `${tally.remainingToPass} more right answers passes.`}
      </p>
    </section>
  );
}

/**
 * The whole bank at a glance: one cell per question, sixteen to a row.
 *
 * Every state carries a distinct shape as well as a colour, so the grid stays
 * readable for a colourblind reader and in print. That is not decoration: the
 * palette validator measured an earlier colour-only version at only 2.0 deltaE
 * under protanopia, meaning "you missed this" and "not seen yet" were identical.
 */
function StatusCard({
  stats,
  currentId,
  justLocked,
}: {
  stats: Stats | null;
  currentId: number | null;
  justLocked: number[];
}) {
  const [hover, setHover] = useState<Cell | null>(null);
  const legend = useMemo(
    () => [
      { state: "mastered" as CellState, label: "locked in", n: stats?.mastered ?? 0 },
      { state: "confirm" as CellState, label: "one answer away", n: stats?.confirm ?? 0 },
      { state: "lapsed" as CellState, label: "missed", n: stats?.lapsed ?? 0 },
      { state: "unseen" as CellState, label: "not seen yet", n: stats?.unseen ?? 0 },
    ],
    [stats],
  );

  if (!stats) return null;

  const fill = (s: CellState) =>
    s === "mastered"
      ? CELL_COLOR.mastered
      : s === "confirm"
        ? `linear-gradient(to top, ${CELL_COLOR.confirm} 50%, transparent 50%)`
        : "transparent";

  return (
    <section className="rule space-y-4 border-t pt-6">
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: "repeat(16, minmax(0, 1fr))", maxWidth: "34rem" }}
        onMouseLeave={() => setHover(null)}
      >
        {stats.cells.map((c) => (
          <button
            key={c.id}
            onMouseEnter={() => setHover(c)}
            onFocus={() => setHover(c)}
            aria-label={`Question ${c.id}, ${legend.find((l) => l.state === c.state)?.label}`}
            className={justLocked.includes(c.id) ? "lock-in" : ""}
            style={{
              aspectRatio: "1",
              borderRadius: 1,
              background: fill(c.state),
              border: c.state === "mastered" ? "none" : `1px solid ${CELL_COLOR[c.state]}`,
              boxShadow:
                c.id === currentId
                  ? "0 0 0 2px var(--plate)"
                  : c.state === "lapsed"
                    ? `inset 0 0 0 2px ${CELL_COLOR.lapsed}`
                    : c.starred
                      ? "inset 0 0 0 1.5px rgba(242,239,230,.62)"
                      : "none",
            }}
          />
        ))}
      </div>

      <div className="flex min-h-[1.4rem] items-baseline">
        {hover ? (
          <p className="text-[11px]">
            <span style={{ color: "var(--plate)" }}>{hover.question}</span>
            <span style={{ color: "var(--ink-faint)" }}>
              {" "}
              is {legend.find((l) => l.state === hover.state)?.label}
              {hover.starred ? ", and one of the senior 20" : ""}
            </span>
          </p>
        ) : (
          <p className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
            Every question in the bank. Point at a cell to read it.
          </p>
        )}
      </div>

      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[10px]">
        {legend.map((l) => (
          <li key={l.state} className="flex items-center gap-2" style={{ color: "var(--ink-faint)" }}>
            <span
              aria-hidden
              className="inline-block"
              style={{
                width: 9,
                height: 9,
                borderRadius: 1,
                background: fill(l.state),
                border: l.state === "mastered" ? "none" : `1px solid ${CELL_COLOR[l.state]}`,
                boxShadow: l.state === "lapsed" ? `inset 0 0 0 2px ${CELL_COLOR.lapsed}` : "none",
              }}
            />
            {l.n} {l.label}
          </li>
        ))}
        <li className="flex items-center gap-2" style={{ color: "var(--ink-faint)" }}>
          <span
            aria-hidden
            className="inline-block"
            style={{
              width: 9,
              height: 9,
              borderRadius: 1,
              border: "1px solid var(--ink-faint)",
              boxShadow: "inset 0 0 0 1.5px rgba(242,239,230,.62)",
            }}
          />
          an inner outline marks the senior 20
        </li>
      </ul>
    </section>
  );
}

/**
 * One quiet line while the grading model downloads, or when it cannot run here.
 * Nothing at all once it is ready.
 */
function GraderStatus({ model }: { model: ModelState }) {
  if (model.status === "ready") return null;
  const faint = { color: "var(--ink-faint)" };
  if (model.status === "failed") {
    return (
      <p className="text-[11px] leading-relaxed" style={faint} role="status">
        The grading model could not start in this browser{model.error ? ` (${model.error})` : ""}, so answers are
        graded by the simpler offline matcher. Use the correction buttons if it gets one wrong.
      </p>
    );
  }
  const mb = (n: number) => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1);
  const downloading = model.phase !== "init" && model.total > 0;
  return (
    <p className="text-[11px] leading-relaxed" style={faint} role="status" aria-live="polite">
      <span className="breathe">Loading grader…</span> ({APPROX_DOWNLOAD_MB} MB, first time only)
      {downloading && (
        <span>
          {" "}
          {mb(model.loaded)} of {mb(model.total)} MB, {Math.floor((model.loaded / model.total) * 100)}%
        </span>
      )}
      {model.phase !== "init" && model.total === 0 && model.loaded > 0 && <span> {mb(model.loaded)} MB so far</span>}
      {model.phase === "init" && <span> starting up</span>}
      <span className="block">Until it is ready, answers are graded by the offline matcher.</span>
    </p>
  );
}

/** The Minnesota answers change with elections; say so on screen, always. */
function LocalNote() {
  const local = loadLocalAnswers();
  if (!local.state) return null;
  return (
    <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-faint)" }}>
      Your senators, representative, governor and capital are answered for {local.state}
      {local.zip ? ` (ZIP ${local.zip})` : ""}, as of October 2026. The November 3, 2026 election can change the
      governor and a Senate seat, so re-check these after the election and at{" "}
      <a
        href="https://www.uscis.gov/citizenship/testupdates"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2"
        style={{ color: "var(--ink)" }}
      >
        uscis.gov/citizenship/testupdates
      </a>{" "}
      before the interview.
    </p>
  );
}

function Notice({ tone, children }: { tone: "confirm" | "lapsed"; children: React.ReactNode }) {
  const color = tone === "confirm" ? "var(--confirm)" : "var(--lapsed)";
  return (
    <div className="border-l-2 pl-4 text-[12px] leading-relaxed" style={{ borderColor: color, color }}>
      {children}
    </div>
  );
}
