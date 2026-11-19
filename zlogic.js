/* Game rules for "Nine's a Crowd" (the Zarankiewicz game Z(m, n, 3, 3)).
 *
 * Pure functions, no DOM. Loaded as a plain <script> in the browser (global
 * ZLogic) and with require() in Node for tests. The Python package zgame/
 * implements the same rules; tests/test_js_parity.py checks they agree.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Z(m, n, 3, 3): the most ones an m x n grid can hold with no all-ones 3x3
  // submatrix. Each value was proven optimal by integer programming
  // (scripts/verify_optima.py). Keys are "small x large".
  var OPTIMA = {
    "3x3": 8, "3x4": 10, "3x5": 12, "3x6": 14, "3x7": 16, "3x8": 18,
    "4x4": 13, "4x5": 16, "4x6": 18, "4x7": 21, "4x8": 24,
    "5x5": 20, "5x6": 22, "5x7": 25, "5x8": 28,
    "6x6": 26, "6x7": 29, "6x8": 32,
    "7x7": 33
  };

  function optimum(m, n) {
    var a = Math.min(m, n), b = Math.max(m, n);
    if (a < 3) return m * n;
    var v = OPTIMA[a + "x" + b];
    return v === undefined ? null : v;
  }

  function emptyBoard(m, n) {
    var board = [];
    for (var i = 0; i < m; i++) {
      var row = [];
      for (var j = 0; j < n; j++) row.push(0);
      board.push(row);
    }
    return board;
  }

  function cloneBoard(board) {
    return board.map(function (row) { return row.slice(); });
  }

  function countOnes(board) {
    var total = 0;
    for (var i = 0; i < board.length; i++)
      for (var j = 0; j < board[i].length; j++) total += board[i][j] ? 1 : 0;
    return total;
  }

  function choose3(k) {
    return k < 3 ? 0 : (k * (k - 1) * (k - 2)) / 6;
  }

  /* Find every violation: 3 rows and 3 columns whose 9 crossing cells are all on.
   * Returns { count, cells } where cells[i][j] is true if cell (i, j) belongs to
   * at least one violation. */
  function findViolations(board) {
    var m = board.length, n = m ? board[0].length : 0;
    var cells = [];
    for (var i = 0; i < m; i++) {
      var row = [];
      for (var j = 0; j < n; j++) row.push(false);
      cells.push(row);
    }
    var count = 0;
    for (var a = 0; a < m; a++) {
      for (var b = a + 1; b < m; b++) {
        for (var c = b + 1; c < m; c++) {
          var common = [];
          for (var col = 0; col < n; col++) {
            if (board[a][col] && board[b][col] && board[c][col]) common.push(col);
          }
          if (common.length >= 3) {
            count += choose3(common.length);
            for (var k = 0; k < common.length; k++) {
              cells[a][common[k]] = true;
              cells[b][common[k]] = true;
              cells[c][common[k]] = true;
            }
          }
        }
      }
    }
    return { count: count, cells: cells };
  }

  function score(board) {
    return findViolations(board).count === 0 ? countOnes(board) : 0;
  }

  function boardToString(board) {
    return board.map(function (row) { return row.join(""); }).join("/");
  }

  function stringToBoard(s) {
    return s.split("/").map(function (row) {
      return row.split("").map(function (ch) { return ch === "1" ? 1 : 0; });
    });
  }

  function applyMoves(m, n, moves) {
    var board = emptyBoard(m, n);
    for (var i = 0; i < moves.length; i++) {
      var r = moves[i][0], c = moves[i][1];
      board[r][c] = board[r][c] ? 0 : 1;
    }
    return board;
  }

  return {
    OPTIMA: OPTIMA,
    optimum: optimum,
    emptyBoard: emptyBoard,
    cloneBoard: cloneBoard,
    countOnes: countOnes,
    findViolations: findViolations,
    score: score,
    boardToString: boardToString,
    stringToBoard: stringToBoard,
    applyMoves: applyMoves
  };
});
