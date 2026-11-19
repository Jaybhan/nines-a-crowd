/* Study configuration. This is the only file you need to edit before going live. */
window.ZCONFIG = {
  // Identifies this version of the study in every saved record.
  studyId: "nines-v1",

  // Where results are sent.
  //   "/api/submit"  -> the local test server (backend/local_server.py)
  //   "https://script.google.com/macros/s/.../exec"  -> your Google Apps Script web app
  // scripts/set_endpoint.py writes this line for you.
  endpoint: "https://script.google.com/macros/s/AKfycbwMQ1Ap-1ytVQx8bHPL7ROdYoZpeiLAurhZb5HlFIbuYyYaPYSyMKFQDE_34yHhSBak/exec",

  // The rounds. With randomizeBoardOrder true, every participant gets them in a
  // random order (each of the 6 orders equally likely), and the order is saved
  // with their data. With false, everyone plays them in the order listed here.
  boards: [
    { m: 4, n: 4 },
    { m: 5, n: 5 },
    { m: 6, n: 6 }
  ],
  randomizeBoardOrder: false,

  // Move limit per round. 0 = no limit: a round ends only when the player presses
  // Done, and no move counter is shown. A positive number brings the limit back.
  maxMoves: 0,

  // What players see when a forbidden pattern is on the board.
  //   "highlight"   the cells of every forbidden pattern are marked
  //   "score_only"  only the score drops to 0
  // Each participant is assigned one entry at random, so listing both runs a
  // between-subjects comparison.
  feedbackConditions: ["highlight"],

  // Two quick yes/no questions after the instructions (answers are recorded,
  // nobody is screened out).
  comprehensionCheck: true,

  // Rounds that ask, once before and once after playing, how long a perfect score
  // would take (10 seconds to 1 hour) and how fun the grid is (1 to 7).
  // Use [] to switch the questions off.
  ratingBoards: ["5x5", "6x6"],

  // Shown on the first screen. Leave empty to omit the line.
  contactEmail: "",
  // Optional extra sentence on the first screen, e.g. consent wording your course or COUHES requires.
  consentExtra: "",

  // Link shown on the last screen for sharing; defaults to this page's address.
  shareUrl: "",

  // Clicks are ignored for this many milliseconds after a new screen or dialog
  // appears, so a double-click cannot press a button that has only just shown up.
  clickGuardMs: 350
};
