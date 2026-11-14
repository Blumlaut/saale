import { describe, it, expect } from "vitest";
import {
  INITIAL_WINDOW_GROUPS,
  STEP_REVEAL_ROWS,
  WINDOW_GROWTH_GROUPS,
  WINDOW_ROW_BUDGET,
  WINDOW_ROW_CAP,
  revealStartFor,
  stepWindowStart,
  tailWindowStart,
  windowAnchor,
  windowRows,
  windowStartFor,
  type WindowTurns,
} from "@/lib/chat/render-window";

/** What one turn costs, as a walk over the window reads it. */
interface Row {
  anchor: string;
  rows: number;
  prompt: boolean;
}

/** A window's turns, read the way the component reads them. */
function windowOf(rows: readonly Row[]): WindowTurns {
  return {
    length: rows.length,
    anchor: (index) => rows[index]!.anchor,
    rows: (index) => rows[index]!.rows,
    prompt: (index) => rows[index]!.prompt,
  };
}

/**
 * Where the transcript's render window starts, and when it moves.
 *
 * The component tests drive these through the DOM; here they are fed shapes a
 * real chat takes and checked on their own: a huge turn among small ones, a
 * window that grows, an anchor that a rebuilt list no longer holds.
 */

/** `count` turns of `rows` rows each, anchored by index. */
function turnRows(count: number, rows = 1): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    anchor: `t${index}`,
    rows,
    prompt: false,
  }));
}

/** The same, ready to walk. */
function turns(count: number, rows = 1): WindowTurns {
  return windowOf(turnRows(count, rows));
}

/** A prompt/answer pair, the shape a chat actually ends up in. */
function exchange(index: number, answerRows = 1): Row[] {
  return [
    { anchor: `prompt${index}`, rows: 1, prompt: true },
    { anchor: `answer${index}`, rows: answerRows, prompt: false },
  ];
}

describe("windowRows", () => {
  it("adds the rows a window would mount", () => {
    expect(windowRows(turns(3, 4), 0)).toBe(12);
    expect(windowRows(turns(3, 4), 2)).toBe(4);
    expect(windowRows(turns(3, 4), 3)).toBe(0);
  });
});

describe("windowStartFor", () => {
  it("has nothing to hide in an empty transcript", () => {
    expect(windowStartFor(turns(0))).toBe(0);
  });

  it("mounts a short transcript whole", () => {
    expect(windowStartFor(turns(5))).toBe(0);
    expect(windowStartFor(turns(INITIAL_WINDOW_GROUPS))).toBe(0);
  });

  it("stops at the turn count for turns that cost little", () => {
    expect(windowStartFor(turns(60))).toBe(60 - INITIAL_WINDOW_GROUPS);
  });

  it("stops at the row budget for turns that cost a lot", () => {
    // Twenty turns of ten rows: the budget is reached long before the count is.
    expect(windowStartFor(turns(20, 10))).toBe(5);
  });

  it("includes the turn that crosses the budget instead of skipping it", () => {
    // The turn above the newest ones is the one that goes over: it is mounted,
    // folded by its own step control, and nothing before it is.
    const rows: Row[] = [
      { anchor: "old", rows: 1, prompt: false },
      { anchor: "huge", rows: 100, prompt: false },
      { anchor: "small", rows: 1, prompt: false },
      { anchor: "smaller", rows: 1, prompt: false },
      { anchor: "newest", rows: 60, prompt: false },
    ];
    expect(windowStartFor(windowOf(rows))).toBe(1);
  });

  it("keeps a turn larger than the whole budget", () => {
    const rows: Row[] = [
      { anchor: "old", rows: 1, prompt: false },
      { anchor: "huge", rows: WINDOW_ROW_BUDGET, prompt: false },
    ];
    // The newest turn never leaves the window on its own.
    expect(windowStartFor(windowOf(rows))).toBe(1);
  });
});

describe("revealStartFor", () => {
  it("has nothing left to reveal at the top", () => {
    expect(revealStartFor(turns(10), 0)).toBe(0);
  });

  it("reveals a page of turns at a time", () => {
    const rows = turns(100);
    expect(100 - revealStartFor(rows, 100 - INITIAL_WINDOW_GROUPS)).toBe(
      INITIAL_WINDOW_GROUPS + WINDOW_GROWTH_GROUPS,
    );
  });

  it("stops at the row budget", () => {
    expect(revealStartFor(turns(100, 10), 90)).toBe(90 - Math.ceil(WINDOW_ROW_BUDGET / 10));
  });

  it("always makes progress, however large the turn above is", () => {
    const rows: Row[] = [
      { anchor: "huge", rows: WINDOW_ROW_BUDGET, prompt: false },
      { anchor: "small", rows: 1, prompt: false },
    ];
    expect(revealStartFor(windowOf(rows), 2)).toBe(0);
    expect(revealStartFor(windowOf(rows), 1)).toBe(0);
  });
});

describe("tailWindowStart", () => {
  it("paginates when there is no window to hold", () => {
    expect(tailWindowStart(turns(60), null)).toBe(60 - INITIAL_WINDOW_GROUPS);
  });

  it("holds the turn it started at as turns are appended", () => {
    const held = "t40";
    expect(tailWindowStart(turns(41), held)).toBe(40);
    expect(tailWindowStart(turns(80), held)).toBe(40);
    // 40 turns of one row: still inside the cap.
    expect(windowRows(turns(80), 40)).toBe(40);
  });

  it("follows the anchor when earlier turns are prepended", () => {
    const rows = windowOf([{ anchor: "older", rows: 1, prompt: true }, ...turnRows(3)]);
    expect(tailWindowStart(rows, "t0")).toBe(1);
  });

  it("paginates again once the window outgrows the cap", () => {
    const held = "t0";
    const withinCap = turns(40, 10);
    expect(windowRows(withinCap, 0)).toBeLessThanOrEqual(WINDOW_ROW_CAP);
    expect(tailWindowStart(withinCap, held)).toBe(0);

    const pastCap = turns(46, 10);
    expect(windowRows(pastCap, 0)).toBeGreaterThan(WINDOW_ROW_CAP);
    expect(tailWindowStart(pastCap, held)).toBe(windowStartFor(pastCap));
  });

  it("paginates when the anchored turn is gone", () => {
    expect(tailWindowStart(turns(60), "not-a-turn")).toBe(60 - INITIAL_WINDOW_GROUPS);
    expect(tailWindowStart(turns(0), "not-a-turn")).toBe(0);
  });

  it("never starts past the transcript", () => {
    expect(tailWindowStart(turns(0), null)).toBe(0);
  });
});

describe("prompt boundaries", () => {
  /** Forty-one turns alternating prompt and answer, one row each. */
  const exchanges = (count: number): Row[] =>
    Array.from({ length: count }, (_, index) => ({
      anchor: `g${index}`,
      rows: 1,
      prompt: index % 2 === 0,
    }));

  it("opens the window at the prompt its first answer answers", () => {
    const rows: Row[] = [
      { anchor: "older", rows: 1, prompt: true },
      { anchor: "olderAnswer", rows: 1, prompt: false },
      ...exchange(1, WINDOW_ROW_BUDGET),
      ...exchange(2),
    ];
    // The budget runs out inside the long answer, which takes its prompt too.
    expect(rows[3]!.prompt).toBe(false);
    expect(rows[2]!.prompt).toBe(true);
    expect(windowStartFor(windowOf(rows))).toBe(2);
  });

  it("reveals a prompt together with the answer it opens", () => {
    const rows = exchanges(41);
    // The reveal stops on an answer: the prompt above it comes with it.
    expect(rows[11]!.prompt).toBe(false);
    expect(revealStartFor(windowOf(rows), 41)).toBe(10);
  });

  it("leaves a window that already opens with a prompt alone", () => {
    const rows = exchanges(41);
    // Twenty turns back lands on an answer, so the prompt above it joins.
    expect(rows[20]!.prompt).toBe(true);
    expect(windowStartFor(windowOf(rows))).toBe(20);
  });
});

describe("windowAnchor", () => {
  it("names the turn the window starts at", () => {
    expect(windowAnchor(turns(3), 1)).toBe("t1");
  });

  it("has no anchor for an empty window", () => {
    expect(windowAnchor(turns(0), 0)).toBeNull();
    expect(windowAnchor(turns(3), 3)).toBeNull();
  });
});

describe("stepWindowStart", () => {
  it("starts at the top of a turn that fits", () => {
    expect(stepWindowStart(0, null)).toBe(0);
    expect(stepWindowStart(WINDOW_ROW_BUDGET, null)).toBe(0);
  });

  it("mounts the newest window's worth of a long turn", () => {
    expect(stepWindowStart(200, null)).toBe(200 - WINDOW_ROW_BUDGET);
  });

  it("holds where the reader unfolded it", () => {
    expect(stepWindowStart(400, 20)).toBe(20);
    expect(stepWindowStart(200, 0)).toBe(0);
  });

  it("lets go once the run outgrows the cap", () => {
    expect(stepWindowStart(20 + WINDOW_ROW_CAP, 20)).toBe(20);
    expect(stepWindowStart(21 + WINDOW_ROW_CAP, 20)).toBe(21 + WINDOW_ROW_CAP - WINDOW_ROW_BUDGET);
  });

  it("falls back to the newest window when the unfold is past the end", () => {
    // A reload replaced the run with a shorter one; there is nothing to hold.
    expect(stepWindowStart(10, 20)).toBe(0);
    expect(stepWindowStart(400, 400)).toBe(400 - WINDOW_ROW_BUDGET);
  });

  it("reveals a control's worth per click", () => {
    const start = stepWindowStart(400, null);
    expect(start - STEP_REVEAL_ROWS).toBeLessThan(start);
  });
});
