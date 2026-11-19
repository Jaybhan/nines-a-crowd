/* Nine's a Crowd: study flow, move logging and upload.
 *
 * Screens: intro -> instructions -> (quiz) -> rounds -> survey -> debrief.
 * Rounds listed in ZCONFIG.ratingBoards are wrapped in two questions (time to
 * a perfect score, and fun), asked once before the round and once after it.
 * Every screen change that produces data enqueues one JSON record; the
 * Uploader keeps unsent records in localStorage and retries until they land.
 *
 * Record kinds (all share v, study, app, session_id, record_id, kind, client_ts,
 * and t_ms = milliseconds since the page loaded):
 *   start    the Start button was pressed; condition, round order (boards, and
 *            randomized: whether that order was drawn at random), device,
 *            intro_ms (time on the first screen)
 *   quiz     answers to the comprehension questions, each with rt_ms (time to
 *            answer) and read_ms (time on the explanation)
 *   game     one finished round: every move as [row, col, ms since round start];
 *            game_index is the round's position in this participant's order;
 *            t0_ms is the round's start on the t_ms clock; events lists
 *            [name, ms since round start] for hidden / visible / done_open /
 *            done_cancel / rules_open
 *   partial  snapshot of an unfinished round, sent when the page is hidden
 *   survey   part "closing": answers to the closing questions, rt_ms
 *            part "round_rating": the two ratings before or after one round,
 *            with time_rt_ms / fun_rt_ms (when each was picked) and rt_ms
 * quiz, game, partial and closing survey records also carry timeline: one
 * [label, t_ms] entry per screen shown and answer given so far.
 */
(function () {
  "use strict";

  var CFG = window.ZCONFIG || {};
  var Z = window.ZLogic;
  var APP_VERSION = "1.1.0";  // 1.1.0: random board order, screen timeline
  var SCHEMA = 1;
  var params = new URLSearchParams(window.location.search);
  var DEBUG = params.get("debug") === "1";
  // Number of moves ever made in this study on this device. A later visit sends
  // the count along, so the analysis can tell a second play-through (many prior
  // moves) from a page reload right after starting (a handful).
  var MOVES_KEY = "zmoves_" + CFG.studyId;
  // After a new screen or dialog appears, clicks are ignored for this long, so
  // the second click of a double-click cannot press whatever just appeared.
  var GUARD_MS = CFG.clickGuardMs === undefined ? 350 : CFG.clickGuardMs;

  var app = document.getElementById("app");
  var modalRoot = document.getElementById("modal-root");
  var debugEl = document.getElementById("debug");

  // ------------------------------------------------------------------ utils
  function uid(prefix) {
    var id;
    if (window.crypto && crypto.randomUUID) {
      id = crypto.randomUUID().replace(/-/g, "");
    } else if (window.crypto && crypto.getRandomValues) {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } else {
      id = Date.now().toString(16) + Math.random().toString(16).slice(2);
    }
    return prefix + "_" + id;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  var store = {
    get: function (key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set: function (key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  };

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s"); }

  // --------------------------------------------------------------- uploader
  // Each queued item is {r: record, n: deliveries whose reply could not be read,
  // a: failed attempts, t: earliest time of the next attempt, b: already sent
  // once by beacon}. A record leaves the queue only when the server confirms
  // it, refuses it for good, or it has been delivered MAX_UNREAD times (spaced
  // out by the back-off) without a readable reply.
  var Uploader = (function () {
    var KEY = "zq_" + CFG.studyId;
    var MAX_UNREAD = 3;
    var TIMEOUT_MS = 20000;
    var endpoint = CFG.endpoint || "";
    var crossOrigin = /^https?:\/\//i.test(endpoint) && endpoint.indexOf(window.location.origin + "/") !== 0;
    var queue = [];
    try {
      queue = (JSON.parse(store.get(KEY) || "[]") || []).map(function (item) {
        item = item && item.r ? item : { r: item, n: 0 };
        item.t = 0;  // left over from an earlier visit: try again straight away
        return item;
      });
    } catch (e) { queue = []; }
    var busy = false, retryTimer = null, listeners = [];
    var replyHidden = false;  // true once this endpoint has answered without a readable reply
    var stats = { confirmed: 0, unconfirmed: 0, rejected: 0 };

    function notify() {
      listeners.forEach(function (fn) { try { fn(queue.length); } catch (e) { /* ignore */ } });
    }
    function persist() { store.set(KEY, JSON.stringify(queue)); notify(); }

    function post(body, mode) {
      var options = {
        method: "POST",
        mode: mode,
        body: body,
        keepalive: true,
        // text/plain keeps this a "simple" request: no CORS preflight, which
        // Google Apps Script web apps cannot answer.
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      };
      var timer = null;
      if (window.AbortController) {  // a stalled request must not block the rest of the queue
        var controller = new AbortController();
        options.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      }
      function settle() { if (timer) clearTimeout(timer); }
      return fetch(endpoint, options).then(
        function (resp) { settle(); return resp; },
        function (err) { settle(); throw err; }
      );
    }

    // resolves to
    //   "sent"      the server confirmed it stored the record
    //   "rejected"  the server refused the record for good
    //   "unread"    something answered, but the browser could not read the reply
    //   "retry"     nothing usable happened; try again later
    function sendOne(record) {
      var body = JSON.stringify(record);
      function opaque() {
        // An opaque request fails only if nothing answered at all, which tells a
        // dead network apart from a reply this page is not allowed to read (an
        // error page, a mis-set deployment). It never proves the record was
        // stored, so the caller keeps the record and tries again later.
        return post(body, "no-cors").then(function () { replyHidden = true; return "unread"; }, function () { return "retry"; });
      }
      if (crossOrigin && replyHidden) return opaque();  // one request per attempt instead of two
      return post(body, crossOrigin ? "cors" : "same-origin").then(function (resp) {
        if (!resp.ok) return "retry";
        return resp.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
          if (data && data.ok === true) return "sent";
          if (data && data.ok === false && !data.retry) return "rejected";
          return "retry";
        }, function () { return "retry"; });
      }, function () {
        return crossOrigin ? opaque() : "retry";
      });
    }

    function schedule() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (!queue.length) return;
      var next = Math.min.apply(null, queue.map(function (item) { return item.t || 0; }));
      retryTimer = setTimeout(function () { retryTimer = null; flush(); }, Math.max(50, next - Date.now()));
    }

    function settle(item, status) {
      if (status === "unread") item.n = (item.n || 0) + 1;
      if (status === "retry" || (status === "unread" && item.n < MAX_UNREAD)) {
        item.a = (item.a || 0) + 1;  // wait 2 s, 4 s, 8 s, ... up to 30 s before this record's next attempt
        item.t = Date.now() + Math.min(30000, 2000 * Math.pow(2, item.a - 1));
        persist();
        return;
      }
      if (status === "sent") stats.confirmed += 1;
      else if (status === "unread") stats.unconfirmed += 1;
      else stats.rejected += 1;
      var i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      persist();
    }

    // Sends every record that is due. New records are due at once; records that
    // failed wait out their own back-off, so adding a record never hurries the
    // retries of an older one.
    function flush() {
      if (busy || !endpoint) { notify(); return Promise.resolve(); }
      var now = Date.now();
      var due = queue.filter(function (item) { return !(item.t > now); });
      if (!due.length) { schedule(); notify(); return Promise.resolve(); }
      busy = true;
      var chain = Promise.resolve();
      due.forEach(function (item) {
        chain = chain.then(function () {
          return sendOne(item.r).then(function (status) { settle(item, status); });
        });
      });
      function finished() {
        busy = false;
        var again = queue.some(function (item) { return !(item.t > Date.now()); });  // added meanwhile
        if (again) return flush();
        schedule();
        notify();
        return undefined;
      }
      return chain.then(finished, finished);
    }

    function beacon(payload) {
      if (!endpoint || !navigator.sendBeacon) return false;
      try {
        var blob = new Blob([JSON.stringify(payload)], { type: "text/plain;charset=utf-8" });
        return navigator.sendBeacon(endpoint, blob);
      } catch (e) { return false; }
    }

    // When the page is being hidden or closed, hand everything still waiting to
    // the browser in one request. The records stay queued (a beacon cannot be
    // confirmed); each is beaconed at most once.
    function beaconQueue() {
      var fresh = queue.filter(function (item) { return !item.b; });
      if (!fresh.length) return;
      if (beacon(fresh.map(function (item) { return item.r; }))) {
        fresh.forEach(function (item) { item.b = 1; });
        persist();
      }
    }

    return {
      enqueue: function (record) { queue.push({ r: record, n: 0 }); persist(); flush(); },
      flush: flush,
      beacon: beacon,
      beaconQueue: beaconQueue,
      pending: function () { return queue.length; },
      stats: function () { return { confirmed: stats.confirmed, unconfirmed: stats.unconfirmed, rejected: stats.rejected, unsent: queue.length }; },
      hasEndpoint: function () { return !!endpoint; },
      onChange: function (fn) { listeners.push(fn); }
    };
  })();

  // ---------------------------------------------------------------- session
  var boards = (CFG.boards || [{ m: 4, n: 4 }]).map(function (b) { return { m: b.m, n: b.n }; });
  var conditions = CFG.feedbackConditions && CFG.feedbackConditions.length ? CFG.feedbackConditions : ["highlight"];
  var session = {
    id: uid("s"),
    feedback: conditions[Math.floor(Math.random() * conditions.length)],
    order: CFG.randomizeBoardOrder ? shuffle(boards) : boards,
    priorMoves: parseInt(store.get(MOVES_KEY) || "0", 10) || 0,
    movesMade: 0,
    results: [],
    timeline: []  // [what happened, milliseconds since the page loaded], one entry per screen and answer
  };

  // Every time recorded below is in milliseconds on one clock that starts when the page
  // loads (performance.now(): it only moves forward, whatever the device's wall clock does).
  function clockMs() { return Math.round(performance.now()); }
  function mark(label) { session.timeline.push([label, clockMs()]); }
  function boardName(spec) { return spec.m + "x" + spec.n; }
  var currentGame = null; // the round in progress, for partial snapshots

  // null = no move limit (the default)
  function maxMovesFor() { return CFG.maxMoves > 0 ? Math.round(CFG.maxMoves) : null; }

  function baseRecord(kind) {
    var rec = {
      v: SCHEMA,
      study: CFG.studyId,
      app: APP_VERSION,
      session_id: session.id,
      record_id: uid("r"),
      kind: kind,
      client_ts: Date.now(),
      t_ms: clockMs()  // when this record was made, on the session clock
    };
    if (DEBUG) rec.debug = true;
    return rec;
  }

  function gameRecord(game, kind, endReason) {
    var rec = baseRecord(kind);
    rec.game_index = game.index;
    rec.m = game.m;
    rec.n = game.n;
    rec.max_moves = game.maxMoves;
    rec.feedback = session.feedback;
    rec.started_ts = game.startedTs;
    rec.t0_ms = Math.round(game.t0);  // when the round started, on the session clock (move times count from here)
    rec.order = session.order.map(boardName);  // the order this participant was given
    rec.timeline = session.timeline.slice();
    rec.moves = game.moves.slice();
    rec.events = game.events.slice();
    rec.n_moves = game.moves.length;
    rec.end_reason = endReason;
    rec.t_end_ms = Math.round(performance.now() - game.t0);
    rec.final_board = Z.boardToString(game.board);
    rec.final_score = Z.score(game.board);
    return rec;
  }

  function sendPartial() {
    var game = currentGame;
    if (!game || game.over || game.moves.length === game.partialAt) return;
    game.partialAt = game.moves.length;
    Uploader.beacon(gameRecord(game, "partial", "abandoned"));
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (currentGame && !currentGame.over) currentGame.events.push(["hidden", Math.round(performance.now() - currentGame.t0)]);
      sendPartial();
      Uploader.beaconQueue();
    } else {
      if (currentGame && !currentGame.over) currentGame.events.push(["visible", Math.round(performance.now() - currentGame.t0)]);
      Uploader.flush();
    }
  });
  window.addEventListener("pagehide", function () { sendPartial(); Uploader.beaconQueue(); });

  // ------------------------------------------------------------ click guard
  var guardUntil = 0;
  function armGuard() { guardUntil = performance.now() + GUARD_MS; }
  function guard(event) {
    if (performance.now() < guardUntil) { event.stopPropagation(); event.preventDefault(); }
  }
  document.addEventListener("click", guard, true);
  document.addEventListener("mousedown", guard, true);  // so the stray click cannot move keyboard focus either

  // ------------------------------------------------------------------ views
  function show(node) {
    while (app.firstChild) app.removeChild(app.firstChild);
    app.appendChild(node);
    window.scrollTo(0, 0);
    armGuard();
    var heading = node.querySelector("h1, h2");
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
  }

  function openModal(title, body, buttons, onDismiss) {
    var previous = document.activeElement;
    var backdrop = el("div", { class: "modal-backdrop" });
    var actions = el("div", { class: "actions" });
    function close() {
      document.removeEventListener("keydown", onKey);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (previous && previous.focus && document.contains(previous)) previous.focus();
      armGuard();  // a double-click on a dialog button must not reach the board underneath
    }
    function onKey(event) {
      if (event.key === "Escape" && onDismiss) { close(); onDismiss(); }
    }
    buttons.forEach(function (b) {
      actions.appendChild(el("button", {
        class: "btn block" + (b.primary ? " primary" : ""), type: "button", "data-action": b.id,
        onclick: function () { close(); if (b.onClick) b.onClick(); }
      }, [b.label]));
    });
    var box = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("h2", { text: title })
    ].concat(body, [actions]));
    backdrop.appendChild(box);
    modalRoot.appendChild(backdrop);
    document.addEventListener("keydown", onKey);
    armGuard();
    // keyboard focus starts on the button marked focus (the safe choice), else the first
    var wanted = buttons.filter(function (b) { return b.focus; })[0];
    var target = wanted ? actions.querySelector('[data-action="' + wanted.id + '"]') : actions.querySelector("button");
    if (target) target.focus();
    return close;
  }

  function buildBoard(m, n, options) {
    options = options || {};
    var interactive = !!options.onCell;
    var root = el("div", { class: "board" + (options.mini ? " mini" : "") });
    root.style.setProperty("--n", n);
    if (!interactive) { root.setAttribute("role", "img"); root.setAttribute("aria-label", options.label || "Example board"); }
    var cells = [];
    for (var r = 0; r < m; r++) {
      cells.push([]);
      for (var c = 0; c < n; c++) {
        (function (row, col) {
          var cell = interactive
            ? el("button", { class: "cell", type: "button", "data-r": row, "data-c": col, onclick: function () { options.onCell(row, col); } })
            : el("div", { class: "cell" });
          cells[row].push(cell);
          root.appendChild(cell);
        })(r, c);
      }
    }
    function paint(board, bad) {
      for (var i = 0; i < m; i++) {
        for (var j = 0; j < n; j++) {
          var on = !!board[i][j], isBad = !!(bad && bad[i][j]);
          cells[i][j].className = "cell" + (on ? " on" : "") + (isBad ? " bad" : "");
          if (interactive) {
            cells[i][j].setAttribute("aria-pressed", on ? "true" : "false");
            cells[i][j].setAttribute("aria-label",
              "Row " + (i + 1) + ", column " + (j + 1) + ", " + (on ? "on" : "off") + (isBad ? ", part of a forbidden pattern" : ""));
          }
        }
      }
    }
    return { root: root, paint: paint };
  }

  function exampleBoard(text, label) {
    var board = Z.stringToBoard(text);
    var view = buildBoard(board.length, board[0].length, { mini: true, label: label });
    view.paint(board, Z.findViolations(board).cells);
    return { root: view.root, board: board };
  }

  // ------------------------------------------------------------------ intro
  function introScreen() {
    var rounds = session.order.length;
    var nameInput = el("input", { class: "field", type: "text", id: "name", maxlength: "80", autocomplete: "name", placeholder: "Leave blank to stay anonymous" });
    var emailInput = el("input", { class: "field", type: "email", id: "email", maxlength: "120", autocomplete: "email", inputmode: "email", placeholder: "Leave blank to stay anonymous" });
    var card = el("div", { class: "card" }, [
      el("div", { class: "eyebrow", text: "A 5-10 minute puzzle" }),
      el("h1", { text: "Nine's a Crowd" }),
      el("p", { class: "lede", text: "This puzzle is part of an MIT class project (9.660, Computational Cognitive Science) on how people explore a math problem they have never seen before." }),
      el("p", { text: plural(rounds, "short round") + " of a grid puzzle and a few quick questions. This should take at most 5-10 minutes. You are welcome to spend longer, or stop at any time." }),
      el("p", {}, [el("strong", { text: "Please do not use AI or any other outside help. " }), "This study is about how people think, so we need your own attempt."]),
      el("p", { class: "small", id: "data-note", text: "How your data may be used: we record the squares you click, their timing and your answers. These may be analysed and reported in class work, talks and research publications, and shared with other researchers. If you give your name or email, they are kept by the research team and are not published." }),
      CFG.consentExtra ? el("p", { class: "small", text: CFG.consentExtra }) : null,
      CFG.contactEmail ? el("p", { class: "small" }, ["Questions? Contact ", el("a", { href: "mailto:" + CFG.contactEmail, text: CFG.contactEmail }), "."]) : null,
      session.priorMoves >= 5 ? el("p", { class: "small", text: "Looks like you have played before on this device. You are welcome to play again." }) : null,
      el("label", { class: "q", for: "name" }, ["Your name ", el("span", { class: "opt", text: "(optional)" })]),
      nameInput,
      el("label", { class: "q", for: "email" }, ["Your email ", el("span", { class: "opt", text: "(optional)" })]),
      emailInput,
      el("div", { class: "actions" }, [
        el("button", { class: "btn primary block", type: "button", id: "start-btn", onclick: function () { onStart(nameInput.value, emailInput.value); } }, ["Start"])
      ])
    ]);
    mark("intro");
    show(card);
  }

  function onStart(name, email) {
    var rec = baseRecord("start");
    rec.intro_ms = rec.t_ms - session.timeline[session.timeline.length - 1][1];  // time spent on the first screen
    name = String(name || "").trim().slice(0, 80);
    email = String(email || "").trim().slice(0, 120);
    if (name) rec.name = name;  // both optional; absent when left blank
    if (email) rec.email = email;
    rec.feedback = session.feedback;
    rec.boards = session.order.map(function (b) { return [b.m, b.n]; });
    rec.randomized = !!CFG.randomizeBoardOrder;
    rec.max_moves = session.order.map(maxMovesFor);
    rec.prior_moves = session.priorMoves;
    rec.repeat = session.priorMoves > 0;
    rec.device = {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      touch: (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window
    };
    var src = (params.get("src") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    if (src) rec.src = src;
    Uploader.enqueue(rec);
    instructionsScreen();
  }

  // ----------------------------------------------------------- instructions
  var EXAMPLE_BAD = "11001/01100/11011/11001/00110";
  var EXAMPLE_OK = "11001/01100/10011/11001/00110";

  function rulesBody() {
    var bad = exampleBoard(EXAMPLE_BAD, "Example board with a forbidden pattern");
    var ok = exampleBoard(EXAMPLE_OK, "Example board without a forbidden pattern");
    return [
      el("p", { text: "Tap a square to switch it on. Tap it again to switch it off. Every square that is on is worth 1 point." }),
      el("div", { class: "rule" }, [
        el("p", {}, [el("strong", { text: "The catch: " }), "pick any 3 rows and any 3 columns. They cross at 9 squares. If all 9 are on, that is a forbidden pattern, and your score is 0 until you break it."]),
        el("p", { class: "small", text: "The rows and columns do not have to be next to each other." })
      ]),
      el("div", { class: "examples" }, [
        el("div", { class: "example" }, [
          bad.root,
          el("div", { class: "tag no", text: "Score " + Z.score(bad.board) }),
          el("p", { class: "small", text: "Rows 1, 3, 4 and columns 1, 2, 5 cross at nine on-squares." })
        ]),
        el("div", { class: "example" }, [
          ok.root,
          el("div", { class: "tag yes", text: "Score " + Z.score(ok.board) }),
          el("p", { class: "small", text: "One of those nine is off, so every square counts." })
        ])
      ]),
      el("p", { text: "When you think you cannot do better, press Done." + (CFG.maxMoves > 0 ? " Each round also has a move limit, shown at the top." : "") + " Your score for the round is whatever the board is worth when the round ends." })
    ];
  }

  function instructionsScreen() {
    var card = el("div", { class: "card" }, [el("h2", { text: "How to play" })].concat(rulesBody(), [
      CFG.comprehensionCheck ? el("p", { id: "next-note", text: "First we will do a quick comprehension check, then you will go to the main puzzle." }) : null,
      el("div", { class: "actions" }, [
        el("button", {
          class: "btn primary block", type: "button", id: "instructions-btn",
          onclick: function () { if (CFG.comprehensionCheck) quizScreen(0, []); else startRound(0); }
        }, ["Got it"])
      ])
    ]));
    mark("instructions");
    show(card);
  }

  // ------------------------------------------------------------------- quiz
  var QUIZ = [
    { id: "q_violation", board: "1111/1011/0100/1011" },
    { id: "q_clean", board: "1110/1011/1110/0101" }
  ];

  function quizScreen(index, answers) {
    var item = QUIZ[index];
    var board = Z.stringToBoard(item.board);
    var violations = Z.findViolations(board);
    var truth = violations.count > 0 ? "yes" : "no";
    var view = buildBoard(board.length, board[0].length, { mini: true, label: "Quiz board" });
    view.paint(board, null);
    var t0 = performance.now();
    var feedback = el("div", {});
    var choices = el("div", { class: "actions row" });

    function answer(value) {
      var correct = value === truth;
      answers.push({ id: item.id, answer: value, correct: correct, rt_ms: Math.round(performance.now() - t0) });
      mark("quiz_" + (index + 1) + "_answer");
      var answered = performance.now();
      view.paint(board, violations.cells);
      while (choices.firstChild) choices.removeChild(choices.firstChild);
      var explain = truth === "yes"
        ? "There is a forbidden pattern (marked): three rows and three columns whose nine crossing squares are all on. This board scores 0."
        : "No forbidden pattern here: no three rows share three on-columns. This board scores " + Z.score(board) + ".";
      feedback.className = "feedback " + (correct ? "right" : "wrong");
      feedback.appendChild(el("p", {}, [el("strong", { text: correct ? "Right. " : "Not quite. " }), explain]));
      var last = index + 1 >= QUIZ.length;
      feedback.appendChild(el("button", {
        class: "btn primary block", type: "button", id: "quiz-next",
        onclick: function () {
          answers[answers.length - 1].read_ms = Math.round(performance.now() - answered);  // time on the explanation
          if (!last) { quizScreen(index + 1, answers); return; }
          var rec = baseRecord("quiz");
          rec.items = answers;
          rec.timeline = session.timeline.slice();
          Uploader.enqueue(rec);
          startRound(0);
        }
      }, [last ? "Start round 1" : "Next"]));
      feedback.querySelector("button").focus();
    }

    ["yes", "no"].forEach(function (value) {
      choices.appendChild(el("button", {
        class: "btn", type: "button", "data-answer": value, onclick: function () { answer(value); }
      }, [value === "yes" ? "Yes" : "No"]));
    });

    mark("quiz_" + (index + 1));
    show(el("div", { class: "card" }, [
      el("div", { class: "eyebrow", text: "Quick check " + (index + 1) + " of " + QUIZ.length }),
      el("h2", { text: "Does this board contain a forbidden pattern?" }),
      view.root,
      choices,
      feedback
    ]));
  }

  // ---------------------------------------------------------- round ratings
  var TIME_CHOICES = [[10, "10 sec"], [30, "30 sec"], [60, "1 min"], [120, "2 min"], [300, "5 min"], [600, "10 min"], [1200, "20 min"],
                      [1800, "30 min"], [2400, "40 min"], [3600, "1 hour"]];

  function isRated(spec) { return (CFG.ratingBoards || []).indexOf(spec.m + "x" + spec.n) >= 0; }

  function startRound(index) {
    if (isRated(session.order[index])) ratingScreen(index); else gameScreen(index);
  }

  // The two questions: how long a perfect score would take, and how fun the grid
  // is. onChange receives {time_s, fun} once both are answered, else null.
  function ratingBlock(phase, spec, onChange) {
    var before = phase === "before";
    var grid = "the " + spec.m + " × " + spec.n + " grid";  // named, because the next grid may be mentioned nearby
    var t0 = performance.now();
    var node = el("div", { class: "rating" }, [
      el("label", { class: "q" }, [before
        ? "How long do you think it would take you to get a perfect score on this grid?"
        : "Now that you have played it: how long do you think it would take you to get a perfect score on " + grid + "?"]),
      el("p", { class: "small", text: "A perfect score is the highest score anyone could possibly get on it." }),
      el("div", { class: "choices grid4" }, TIME_CHOICES.map(function (o) {
        return el("label", { class: "choice" }, [el("input", { type: "radio", name: "rate_time", value: String(o[0]) }), el("span", { text: o[1] })]);
      })),
      el("label", { class: "q" }, [before ? "How fun do you expect this grid to be?" : "How fun was " + grid + "?"]),
      el("div", { class: "choices scale" }, [1, 2, 3, 4, 5, 6, 7].map(function (v) {
        return el("label", { class: "choice" }, [el("input", { type: "radio", name: "rate_fun", value: String(v) }), el("span", { text: String(v) })]);
      })),
      el("div", { class: "scale-ends" }, [el("span", { text: "Not fun at all" }), el("span", { text: "Very fun" })])
    ]);
    function read() {
      var time = node.querySelector('input[name="rate_time"]:checked');
      var fun = node.querySelector('input[name="rate_fun"]:checked');
      // *_rt_ms: when each answer was last picked, counted from the moment the questions appeared
      return time && fun ? { time_s: Number(time.value), fun: Number(fun.value), time_rt_ms: picked.rate_time, fun_rt_ms: picked.rate_fun } : null;
    }
    var picked = {};
    node.addEventListener("change", function (event) {
      if (event.target && event.target.name) picked[event.target.name] = Math.round(performance.now() - t0);
      onChange(read());
    });
    return { node: node, read: read, rt: function () { return Math.round(performance.now() - t0); } };
  }

  function sendRating(index, phase, answer, rtMs) {
    var spec = session.order[index];
    var rec = baseRecord("survey");
    rec.part = "round_rating";
    rec.phase = phase;
    rec.game_index = index;
    rec.m = spec.m;
    rec.n = spec.n;
    rec.time_s = answer.time_s;
    rec.fun = answer.fun;
    rec.time_rt_ms = answer.time_rt_ms;
    rec.fun_rt_ms = answer.fun_rt_ms;
    rec.rt_ms = rtMs;  // when the button was pressed
    mark("rating_" + phase + "_" + boardName(spec) + "_answer");
    Uploader.enqueue(rec);
  }

  // Shown before a rated round: the empty grid and the two questions.
  function ratingScreen(index) {
    var spec = session.order[index];
    var preview = buildBoard(spec.m, spec.n, { mini: true, label: "Empty " + spec.m + " by " + spec.n + " grid" });
    preview.paint(Z.emptyBoard(spec.m, spec.n), null);
    var go = el("button", {
      class: "btn primary block", type: "button", id: "rating-btn", disabled: true,
      onclick: function () {
        var answer = block.read();
        if (!answer) return;
        sendRating(index, "before", answer, block.rt());
        gameScreen(index);
      }
    }, ["Start round " + (index + 1)]);
    var block = ratingBlock("before", spec, function (answer) { go.disabled = !answer; });
    mark("rating_before_" + boardName(spec));
    show(el("div", { class: "card" }, [
      el("div", { class: "eyebrow", text: "Before round " + (index + 1) }),
      el("h2", { text: "Next: a " + spec.m + " × " + spec.n + " grid" }),
      preview.root,
      block.node,
      el("div", { class: "actions" }, [go])
    ]));
  }

  // ------------------------------------------------------------------- game
  function gameScreen(index) {
    var spec = session.order[index];
    var m = spec.m, n = spec.n;
    mark("round_" + boardName(spec));
    var game = {
      index: index, m: m, n: n, maxMoves: maxMovesFor(spec),
      board: Z.emptyBoard(m, n), moves: [], events: [],
      t0: performance.now(), startedTs: Date.now(), over: false, partialAt: 0
    };
    currentGame = game;
    var highlight = session.feedback === "highlight";
    var wasViolating = false;

    var movesLeft = el("span", { class: "moves-left", id: "moves-left" });
    var num = el("div", { class: "num", id: "score" });
    var status = el("div", { class: "status", id: "status" });
    var onCount = el("div", { class: "small muted", id: "on-count" });
    var scorebox = el("div", { class: "scorebox" }, [
      el("div", {}, [el("div", { class: "label", text: "Score" }), num]),
      el("div", {}, [status, onCount])
    ]);
    var view = buildBoard(m, n, { onCell: onCell });
    view.root.id = "board";
    var doneBtn = el("button", { class: "btn primary block", type: "button", id: "done-btn", onclick: askDone }, ["Done, submit this board"]);

    function now() { return Math.round(performance.now() - game.t0); }

    function refresh() {
      var v = Z.findViolations(game.board);
      var ones = Z.countOnes(game.board);
      var violating = v.count > 0;
      num.textContent = violating ? "0" : String(ones);
      scorebox.className = "scorebox" + (violating ? " violating" : "");
      if (violating && !wasViolating) {
        void scorebox.offsetWidth; // restart the animation
        scorebox.className += " shake";
      }
      wasViolating = violating;
      status.className = "status" + (violating ? "" : " ok");
      while (status.firstChild) status.removeChild(status.firstChild);
      status.appendChild(el("span", { class: "icon", "aria-hidden": "true", text: violating ? "!" : "✓" }));
      status.appendChild(document.createTextNode(violating ? "Forbidden pattern: score is 0 until you break it" : "No forbidden pattern"));
      onCount.textContent = plural(ones, "square") + " on";
      if (game.maxMoves !== null) {
        var left = game.maxMoves - game.moves.length;
        movesLeft.textContent = "Moves left: " + left;
        movesLeft.className = "moves-left" + (left <= Math.max(5, Math.round(game.maxMoves * 0.1)) ? " low" : "");
      }
      view.paint(game.board, highlight ? v.cells : null);
    }

    function onCell(r, c) {
      if (game.over) return;
      game.board[r][c] = game.board[r][c] ? 0 : 1;
      game.moves.push([r, c, now()]);
      session.movesMade += 1;
      store.set(MOVES_KEY, String(session.priorMoves + session.movesMade));
      refresh();
      if (game.maxMoves !== null && game.moves.length >= game.maxMoves) finish("out_of_moves");
    }

    function askDone() {
      if (game.over) return;
      var sc = Z.score(game.board);
      var violating = Z.findViolations(game.board).count > 0;
      game.events.push(["done_open", now()]);
      var body = violating
        ? [el("p", { text: "Your board has a forbidden pattern, so it would score 0. Submit it anyway?" })]
        : [el("p", { text: "Submit this board for " + plural(sc, "point") + "? You cannot change it afterwards." })];
      openModal("End this round?", body, [
        { id: "confirm", label: violating ? "Submit anyway" : "Submit", primary: !violating, onClick: function () { finish("submit"); } },
        { id: "cancel", label: "Keep playing", primary: violating, focus: true, onClick: cancelled }
      ], cancelled);
      function cancelled() { game.events.push(["done_cancel", now()]); }
    }

    function finish(reason) {
      if (game.over) return;
      game.over = true;
      view.root.className += " locked";
      var rec = gameRecord(game, "game", reason);
      Uploader.enqueue(rec);
      currentGame = null;
      var result = { m: m, n: n, score: rec.final_score, reason: reason, violating: Z.findViolations(game.board).count > 0 };
      session.results.push(result);
      roundDoneScreen(index, result);
    }

    show(el("div", {}, [
      el("div", { class: "topbar" }, [
        el("span", {}, [el("strong", { text: "Round " + (index + 1) + " of " + session.order.length }), " · " + m + " × " + n + " grid"]),
        movesLeft
      ]),
      scorebox,
      view.root,
      el("div", { class: "game-actions" }, [
        doneBtn,
        el("button", {
          class: "btn link", type: "button", id: "rules-btn",
          onclick: function () {
            game.events.push(["rules_open", now()]);
            openModal("How to play", rulesBody(), [{ id: "close", label: "Back to the board", primary: true }], function () {});
          }
        }, ["How to play"])
      ])
    ]));
    refresh();
  }

  function roundDoneScreen(index, result) {
    var last = index + 1 >= session.order.length;
    var rated = isRated(session.order[index]);
    var lines = [];
    if (result.reason === "out_of_moves") lines.push("You used all your moves for this round.");
    lines.push(result.violating
      ? "Your final board had a forbidden pattern, so this round scored 0."
      : "You scored " + plural(result.score, "point") + ".");
    if (!last && !isRated(session.order[index + 1])) {  // a rated round introduces itself on its own screen
      var next = session.order[index + 1];
      lines.push("Next up: a " + next.m + " × " + next.n + " grid.");
    }
    var label = last ? "Almost done: 3 quick questions"
      : (isRated(session.order[index + 1]) ? "Continue" : "Start round " + (index + 2));
    var go = el("button", {
      class: "btn primary block", type: "button", id: "next-btn", disabled: rated,
      onclick: function () {
        if (rated) {
          var answer = block.read();
          if (!answer) return;
          sendRating(index, "after", answer, block.rt());
        }
        if (last) surveyScreen(); else startRound(index + 1);
      }
    }, [label]);
    var block = rated ? ratingBlock("after", session.order[index], function (answer) { go.disabled = !answer; }) : null;
    mark("round_done_" + boardName(session.order[index]));
    show(el("div", { class: "card" }, [
      el("div", { class: "eyebrow", text: "Round " + (index + 1) + " of " + session.order.length + " complete" }),
      el("h2", { text: result.violating ? "Round over" : "Nice work" })
    ].concat(lines.map(function (t) { return el("p", { text: t }); }), [
      block ? block.node : null,
      el("div", { class: "actions" }, [go])
    ])));
  }

  // ----------------------------------------------------------------- survey
  function radioGroup(name, options, row) {
    return el("div", { class: "choices" + (row ? " row" : "") }, options.map(function (o) {
      return el("label", { class: "choice" }, [
        el("input", { type: "radio", name: name, value: o[0] }),
        el("span", { text: o[1] })
      ]);
    }));
  }

  function surveyScreen() {
    var text = el("textarea", { id: "strategy", maxlength: "2000", placeholder: "A sentence or two is plenty." });
    var form = el("form", { class: "card", onsubmit: submit }, [
      el("h2", { text: "Three quick questions" }),
      el("p", { class: "small", text: "All optional. Skip anything you like." }),
      el("label", { class: "q", for: "strategy" }, ["How did you decide which squares to switch on, and when to stop?"]),
      text,
      el("label", { class: "q" }, ["How much math have you done?"]),
      radioGroup("math", [
        ["none", "No college-level math"],
        ["some", "A few college math classes"],
        ["major", "A math-heavy major (math, CS, physics, engineering, ...)"],
        ["advanced", "Math competitions or math research"]
      ]),
      el("label", { class: "q" }, ["Had you seen this puzzle, or a math problem like it, before today?"]),
      radioGroup("seen", [["no", "No"], ["unsure", "Not sure"], ["yes", "Yes"]], true),
      el("div", { class: "actions" }, [
        el("button", { class: "btn primary block", type: "submit", id: "survey-btn" }, ["Finish and see how I did"])
      ])
    ]);

    function picked(name) {
      var input = form.querySelector('input[name="' + name + '"]:checked');
      return input ? input.value : null;
    }
    function submit(event) {
      event.preventDefault();
      var rec = baseRecord("survey");
      rec.part = "closing";
      rec.rt_ms = rec.t_ms - shownAt;  // time spent on the closing questions
      mark("survey_answer");
      rec.timeline = session.timeline.slice();
      rec.strategy_text = text.value.trim().slice(0, 2000);
      rec.math_background = picked("math");
      rec.seen_before = picked("seen");
      Uploader.enqueue(rec);
      debriefScreen();
    }
    mark("survey");
    var shownAt = clockMs();
    show(form);
  }

  // ---------------------------------------------------------------- debrief
  function debriefScreen() {
    var total = 0, best = 0, known = true;
    var rows = session.results.map(function (r, i) {
      var opt = Z.optimum(r.m, r.n);
      total += r.score;
      if (opt === null) known = false; else best += opt;
      return el("tr", {}, [
        el("td", { text: "Round " + (i + 1) }),
        el("td", { text: r.m + " × " + r.n }),
        el("td", { class: "you", text: String(r.score) }),
        el("td", { text: opt === null ? "?" : String(opt) })
      ]);
    });
    var shareUrl = CFG.shareUrl || (window.location.origin + window.location.pathname);
    var shareInput = el("input", { type: "text", readonly: true, value: shareUrl, "aria-label": "Link to this puzzle", id: "share-url" });
    var copyBtn = el("button", {
      class: "btn", type: "button",
      onclick: function () {
        shareInput.select();
        var done = function () { copyBtn.textContent = "Copied"; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(shareUrl).then(done, function () {});
        else { try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ } }
      }
    }, ["Copy link"]);
    var saveStatus = el("p", { class: "save-status", id: "save-status", role: "status" });

    show(el("div", { class: "card" }, [
      el("div", { class: "eyebrow", text: "All done" }),
      el("h1", { text: "Thank you!" }),
      el("table", { class: "results" }, [
        el("thead", {}, [el("tr", {}, ["", "Grid", "You", "Best possible"].map(function (h) { return el("th", { text: h }); }))]),
        el("tbody", {}, rows)
      ]),
      known && best > 0 ? el("p", { text: "You reached " + Math.round((100 * total) / best) + "% of the best possible total." }) : null,
      el("h3", { text: "What was this?" }),
      el("p", { text: "You were playing a small case of the Zarankiewicz problem, an open question in combinatorics: how many 1s fit in a grid of 0s and 1s without a full 3 × 3 pattern of 1s? For large grids nobody knows the exact answer. We are studying how people explore a math problem they have never seen: which moves look promising, and when it feels like time to stop." }),
      el("h3", { text: "Know someone who would enjoy it?" }),
      el("p", { class: "small", text: "Please share the link, but keep the best-possible scores to yourself so they get a fresh start." }),
      el("div", { class: "share" }, [shareInput, copyBtn]),
      saveStatus
    ]));

    function update() {
      var st = Uploader.stats();
      if (!Uploader.hasEndpoint()) saveStatus.textContent = "";
      else if (st.unsent > 0) saveStatus.textContent = "Saving your results. Please keep this page open for a moment...";
      else if (st.unconfirmed > 0) saveStatus.textContent = "Your results have been sent. You can close this page.";
      else saveStatus.textContent = "Your results are saved. You can close this page.";
    }
    Uploader.onChange(update);
    update();
    Uploader.flush();
  }

  // ------------------------------------------------------------------ start
  if (DEBUG && debugEl) {
    debugEl.hidden = false;
    var paintDebug = function () {
      var st = Uploader.stats();
      debugEl.textContent = "debug · " + session.id.slice(0, 10) + " · " + session.feedback +
        " · confirmed " + st.confirmed + " · unconfirmed " + st.unconfirmed + " · unsent " + st.unsent;
    };
    Uploader.onChange(paintDebug);
    paintDebug();
  }
  window.__zgame = { sessionId: session.id, pending: Uploader.pending, stats: Uploader.stats, feedback: session.feedback };
  Uploader.flush(); // deliver anything left over from an earlier visit
  introScreen();
})();
