/* Imperial Rivals — pure game engine.
 *
 * One shared rules implementation, with no DOM, no rendering, no toasts and
 * no Math.random. Used by:
 *   - tcg/index.html (the playable game, loaded as a classic script that
 *     sets window.TCGEngine)
 *   - Node harnesses (require) — the AI simulator, and later the server
 *
 * Model: state + actions + events.
 *   - createGame({ decks: [uids x15, uids x15], seed }) builds a match.
 *     The page passes a fresh random seed per game; the simulator passes a
 *     fixed seed for replayable matches.
 *   - legalActions(player) lists every action the acting player may take.
 *   - apply(player, action) validates (throws on anything illegal) and
 *     returns the events the action produced.
 *   - submit(player) ends a player's phase. Player 0's submit hands the
 *     phase to player 1; player 1's submit either ends the game (turn 6)
 *     or starts the next round (income -> tax -> draw, both players).
 *   - view(player) is the public view for that player: own hand, both
 *     boards, opponent hand size only. Policies NEVER see more than this.
 *   - state() is a full plain-data snapshot (for logs, not for players).
 *   - clone() is an independent copy with the same RNG state, for rollouts
 *     and atomic turn validation.
 *   - result() is null until turn 6 ends, then { winner, detail, ... }.
 *
 * Actions are plain data (JSON-able). Targets ride inside the action:
 *   { kind: 'play', handIndex, ministry, target?: { ministry, slot } }
 *   { kind: 'item', handIndex, ministry, slot }
 *   { kind: 'action', handIndex, ministry, slot }  // Auctioneer: discard hand[handIndex] for 2 coins
 *   { kind: 'submit' }
 * A targeting card (Poisoner, Grand Spymaster) may always be played
 * WITHOUT a target — the ability then fizzles, exactly as when the player
 * cancels targeting in the UI.
 * Death check: at the end of a turn, after both players' plays are
 * resolved, agents at 0 or lower total power are removed to discard
 * (with their item), cascading until none remain, before the next
 * round or the final scoring.
 *
 * Events are the engine's only output channel. The page turns them into
 * toasts; the simulator logs them. Round-start events (taxHit, smokeHit,
 * tax, forcedDiscard) describe effects on either side; play-effect events
 * carry player + source so the page can stay silent for the AI, as before.
 */
(function (root) {
  'use strict';

  // ---------- Set 1 card data (single source of truth) ----------
  var SET1 = [
    // Military agents (11)
    { uid: 'militia-recruit', name: 'Recruit', type: 'agent', cost: 2, power: 3, ministry: 0, rarity: 'C', text: '' },
    { uid: 'militia-captain', name: 'Captain', type: 'agent', cost: 4, power: 6, ministry: 0, rarity: 'C', text: '' },
    { uid: 'militia-levy', name: 'Levy', type: 'agent', cost: 1, power: 2, ministry: 0, rarity: 'C', text: '' },
    { uid: 'sentry', name: 'Sentry', type: 'agent', cost: 1, power: 1, ministry: 0, rarity: 'C', text: 'On play: opponent loses 1 coin at the start of your next turn.' },
    { uid: 'man-at-arms', name: 'Imperial Guard', type: 'agent', cost: 3, power: 5, ministry: 0, rarity: 'C', text: '' },
    { uid: 'quartermaster', name: 'Provisioner', type: 'agent', cost: 5, power: 6, ministry: 0, rarity: 'C', text: 'Your other Military agents get +2 power.' },
    { uid: 'warlord', name: 'Warlord', type: 'agent', cost: 6, power: 9, ministry: 0, rarity: 'C', text: '' },
    { uid: 'tax-collector', name: 'Tax Collector', type: 'agent', cost: 3, power: 4, ministry: 0, rarity: 'U', text: 'The tax amount is +1.' },
    { uid: 'veteran-sergeant', name: 'Drillmaster', type: 'agent', cost: 4, power: 4, ministry: 0, rarity: 'U', text: '+2 power for each other agent in your Military.' },
    { uid: 'raider', name: 'Raider', type: 'agent', cost: 3, power: 4, ministry: 0, rarity: 'U', text: 'On play: opponent loses 1 coin at the start of your next turn.' },
    { uid: 'grand-marshal', name: 'Grand Marshal', type: 'agent', cost: 6, power: 7, ministry: 0, rarity: 'R', text: 'The tax amount is +2.' },
    // Commerce agents (11)
    { uid: 'peddler', name: 'Peddler', type: 'agent', cost: 2, power: 3, ministry: 1, rarity: 'C', text: '' },
    { uid: 'merchant-prince', name: 'Merchant Prince', type: 'agent', cost: 4, power: 6, ministry: 1, rarity: 'C', text: '' },
    { uid: 'errand-boy', name: 'Errand Boy', type: 'agent', cost: 1, power: 2, ministry: 1, rarity: 'C', text: '' },
    { uid: 'broker', name: 'Broker', type: 'agent', cost: 1, power: 1, ministry: 1, rarity: 'C', text: 'On play: gain 1 coin.' },
    { uid: 'shopkeeper', name: 'Shopkeeper', type: 'agent', cost: 3, power: 5, ministry: 1, rarity: 'C', text: '' },
    { uid: 'moneylender', name: 'Moneylender', type: 'agent', cost: 5, power: 7, ministry: 1, rarity: 'C', text: 'On play: gain 3 coins.' },
    { uid: 'trade-magnate', name: 'Guildmaster', type: 'agent', cost: 6, power: 9, ministry: 1, rarity: 'C', text: '' },
    { uid: 'treasurer', name: 'Treasurer', type: 'agent', cost: 4, power: 5, ministry: 1, rarity: 'U', text: 'On play: +1 income.' },
    { uid: 'smuggler', name: 'Smuggler', type: 'agent', cost: 2, power: 2, ministry: 1, rarity: 'U', text: 'On play: draw a card.' },
    { uid: 'auctioneer', name: 'Auctioneer', type: 'agent', cost: 3, power: 4, ministry: 1, rarity: 'U', text: 'Action: discard a card from your hand: gain 2 coins.' },
    { uid: 'grand-treasurer', name: 'Grand Treasurer', type: 'agent', cost: 6, power: 7, ministry: 1, rarity: 'R', text: 'On play: +3 income.' },
    // Intrigue agents (11)
    { uid: 'informant', name: 'Informant', type: 'agent', cost: 2, power: 3, ministry: 2, rarity: 'C', text: '' },
    { uid: 'spymaster', name: 'Spymaster', type: 'agent', cost: 4, power: 6, ministry: 2, rarity: 'C', text: '' },
    { uid: 'pickpocket', name: 'Pickpocket', type: 'agent', cost: 1, power: 2, ministry: 2, rarity: 'C', text: '' },
    { uid: 'lookout', name: 'Lookout', type: 'agent', cost: 1, power: 1, ministry: 2, rarity: 'C', text: 'On play: draw a card.' },
    { uid: 'courier', name: 'Courier', type: 'agent', cost: 3, power: 5, ministry: 2, rarity: 'C', text: '' },
    { uid: 'spy', name: 'Spy', type: 'agent', cost: 5, power: 7, ministry: 2, rarity: 'C', text: 'On play: draw a card.' },
    { uid: 'mastermind', name: 'Mastermind', type: 'agent', cost: 6, power: 8, ministry: 2, rarity: 'C', text: 'On play: draw 2 cards.' },
    { uid: 'double-agent', name: 'Double Agent', type: 'agent', cost: 3, power: 4, ministry: 2, rarity: 'U', text: "On play: at the start of your next turn, after the draw phase, your opponent discards a random card." },
    { uid: 'blackmailer', name: 'Blackmailer', type: 'agent', cost: 4, power: 5, ministry: 2, rarity: 'U', text: 'On play: at the start of your next turn, after the draw phase, your opponent discards a random card.' },
    { uid: 'poisoner', name: 'Poisoner', type: 'agent', cost: 3, power: 4, ministry: 2, rarity: 'U', text: "On play: give an opponent's agent -3 power." },
    { uid: 'grand-spymaster', name: 'Grand Spymaster', type: 'agent', cost: 6, power: 7, ministry: 2, rarity: 'R', text: "On play: gain control of an opponent's agent." },
    // Neutral agents (8)
    { uid: 'villager', name: 'Villager', type: 'agent', cost: 1, power: 1, ministry: null, rarity: 'C', text: '' },
    { uid: 'artisan', name: 'Artisan', type: 'agent', cost: 2, power: 2, ministry: null, rarity: 'C', text: '' },
    { uid: 'scholar', name: 'Scholar', type: 'agent', cost: 3, power: 3, ministry: null, rarity: 'C', text: '' },
    { uid: 'elder', name: 'Elder', type: 'agent', cost: 4, power: 4, ministry: null, rarity: 'C', text: '' },
    { uid: 'master', name: 'Master', type: 'agent', cost: 5, power: 5, ministry: null, rarity: 'C', text: '' },
    { uid: 'sage', name: 'Sage', type: 'agent', cost: 6, power: 6, ministry: null, rarity: 'C', text: '' },
    { uid: 'diplomat', name: 'Diplomat', type: 'agent', cost: 3, power: 2, ministry: null, rarity: 'U', text: 'On play: gain 1 coin and draw a card.' },
    { uid: 'imperial-arbiter', name: 'Imperial Arbiter', type: 'agent', cost: 6, power: 6, ministry: null, rarity: 'R', text: 'You win tied ministries.' },
    // Items (13): the old Equip type is merged into Item. One item per
    // agent, played onto an own agent with no item yet. On-attach is the
    // default timing; Abacus is the while-attached exception, and the
    // Smoke Bomb discards itself at the start of the next turn.
    { uid: 'coin-pouch', name: 'Coin Pouch', type: 'item', cost: 0, power: null, ministry: 1, rarity: 'C', text: 'When attached: gain 2 coins.', coinOnAttach: 2 },
    { uid: 'smoke-bomb', name: 'Smoke Bomb', type: 'item', cost: 1, power: null, ministry: 0, rarity: 'C', text: 'At the start of your next turn, after income: discard this item. Opponent loses 1 coin.' },
    { uid: 'sealed-letter', name: 'Sealed Letter', type: 'item', cost: 1, power: null, ministry: 2, rarity: 'U', text: 'When attached: draw a card.', drawOnAttach: 1 },
    { uid: 'abacus', name: 'Abacus', type: 'item', cost: 1, power: null, ministry: 1, rarity: 'U', text: 'While attached: +1 income.', incomeBonus: 1 },
    { uid: 'dragon-pearl', name: 'Dragon Pearl', type: 'item', cost: 3, power: null, ministry: null, rarity: 'R', text: '+X power, where X is the number of your agents on the field.', isPearl: true },
    { uid: 'iron-arms', name: 'Iron Bracers', type: 'item', cost: 2, power: null, ministry: 0, rarity: 'C', text: 'Attached agent gets +4 power.', attachPower: 4 },
    { uid: 'merchants-scale', name: "Merchant's Scale", type: 'item', cost: 2, power: null, ministry: 1, rarity: 'C', text: 'Attached agent gets +4 power.', attachPower: 4 },
    { uid: 'concealed-blade', name: 'Concealed Blade', type: 'item', cost: 2, power: null, ministry: 2, rarity: 'C', text: 'Attached agent gets +4 power.', attachPower: 4 },
    { uid: 'travelers-pack', name: "Traveler's Pack", type: 'item', cost: 2, power: null, ministry: null, rarity: 'C', text: 'Attached agent gets +3 power.', attachPower: 3 },
    { uid: 'tiger-armor', name: 'Tiger Armor', type: 'item', cost: 3, power: null, ministry: 0, rarity: 'U', text: 'Attached agent gets +4 power. The tax amount is +1.', attachPower: 4 },
    { uid: 'war-chest', name: 'War Chest', type: 'item', cost: 2, power: null, ministry: 1, rarity: 'U', text: 'When attached: gain 3 coins. Attached agent gets +1 power.', attachPower: 1, coinOnAttach: 3 },
    { uid: 'shadow-cloak', name: 'Shadow Cloak', type: 'item', cost: 3, power: null, ministry: 2, rarity: 'U', text: 'When attached: draw a card. Attached agent gets +4 power.', attachPower: 4, drawOnAttach: 1 },
    { uid: 'dragon-regalia', name: 'Dragon Regalia', type: 'item', cost: 4, power: null, ministry: null, rarity: 'R', text: 'Attached agent gets +3 power. As long as this is attached, players cannot play agents on the attached agent\'s ministry (starting next turn).', attachPower: 3 }
  ];
  var cardDef = {};
  SET1.forEach(function (t) { cardDef[t.uid] = t; });

  var MINISTRIES = [{ name: 'Military' }, { name: 'Commerce' }, { name: 'Intrigue' }];
  var MAX_TURNS = 6;
  var MAX_PER_MINISTRY = 3;
  var STARTING_HAND = 4;

  // ---------- seeded RNG (mulberry32) ----------
  // Same seed + same actions = the identical game. Policies that want
  // randomness MUST use the game's rng; Math.random breaks replays.
  function mulberry32(seed) {
    var a = seed >>> 0;
    function r() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    r.state = function () { return a; };
    r.setState = function (s) { a = s | 0; };
    return r;
  }

  // ---------- pure helpers ----------
  function makeCard(t, id) {
    var c = {
      id: id,
      uid: t.uid, name: t.name, type: t.type,
      cost: t.cost, power: t.power, ministry: t.ministry,
      rarity: t.rarity, text: t.text
    };
    if (t.type === 'agent') { c.item = null; c.actionUsed = false; }
    if (t.type === 'item') {
      c.attachPower = t.attachPower || 0;
      c.coinOnAttach = t.coinOnAttach || 0;
      c.drawOnAttach = t.drawOnAttach || 0;
      c.incomeBonus = t.incomeBonus || 0;
      c.isPearl = !!t.isPearl;
      c.smokeArmed = false;
    }
    return c;
  }

  function agentPower(c) {
    var p = c.power || 0;
    if (c.item) p += c.item.attachPower || 0;
    if (c.powerDelta) p += c.powerDelta;
    return p;
  }

  // Total power of one agent in its ministry, including the Drillmaster
  // and Provisioner auras. This is the value the death check uses.
  function totalAgentPower(board, m, c) {
    var p = agentPower(c);
    if (c.uid === 'veteran-sergeant') p += 2 * (board[m].length - 1);
    if (m === 0) {
      var prov = 0;
      board[m].forEach(function (x) { if (x.uid === 'quartermaster') prov += 1; });
      p += 2 * (prov - (c.uid === 'quartermaster' ? 1 : 0));
    }
    return p;
  }

  function ministryPower(board, m) {
    var t = 0;
    var agents = board[m];
    var prov = 0;
    if (m === 0) agents.forEach(function (x) { if (x.uid === 'quartermaster') prov += 1; });
    agents.forEach(function (c) {
      var p = agentPower(c);
      if (c.uid === 'veteran-sergeant') p += 2 * (agents.length - 1);
      if (m === 0) p += 2 * (prov - (c.uid === 'quartermaster' ? 1 : 0));
      t += p;
    });
    return t;
  }

  // A ministry's bonus is active while 2+ agents stand in it.
  function hasBonus(board, m) { return board[m].length >= 2; }

  function taxModifier(board) {
    var n = 0;
    board[0].forEach(function (c) {
      if (c.uid === 'tax-collector') n += 1;
      if (c.uid === 'grand-marshal') n += 2;
      if (c.item && c.item.uid === 'tiger-armor') n += 1;
    });
    return n;
  }

  function abacusCount(board) {
    var n = 0;
    board.forEach(function (arr) {
      arr.forEach(function (c) { if (c.item && c.item.uid === 'abacus') n += 1; });
    });
    return n;
  }

  // Current tax level from two boards: each Military bonus +1, plus tax
  // modifiers from both boards. Same value the round-start tax phase
  // charges, so the page indicator and the engine can never drift apart.
  function taxLevel(boardA, boardB) {
    return (hasBonus(boardA, 0) ? 1 : 0) + (hasBonus(boardB, 0) ? 1 : 0) +
      taxModifier(boardA) + taxModifier(boardB);
  }

  function sameAction(a, b) {
    if (a.kind !== b.kind || a.handIndex !== b.handIndex ||
        a.ministry !== b.ministry || a.slot !== b.slot) return false;
    var ta = a.target, tb = b.target;
    if (!ta && !tb) return true;
    if (!ta || !tb) return false;
    return ta.ministry === tb.ministry && ta.slot === tb.slot;
  }

  function copyCard(c) {
    var o = {};
    for (var k in c) {
      if (k === 'item') o.item = c.item ? Object.assign({}, c.item) : null;
      else o[k] = c[k];
    }
    return o;
  }
  function copyBoard(board) {
    return board.map(function (arr) { return arr.map(copyCard); });
  }

  // ---------- game ----------
  function createGame(opts) {
    var decks = opts.decks;
    var seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
    var rng = mulberry32(seed);
    if (!decks || decks.length !== 2) throw new Error('createGame needs decks[2]');
    decks.forEach(function (d) {
      if (!d || d.length !== 15) throw new Error('deck must have 15 cards');
      d.forEach(function (uid) { if (!cardDef[uid]) throw new Error('unknown card uid: ' + uid); });
    });
    var initialDecks = [decks[0].slice(), decks[1].slice()];

    var nextId = 1;
    function mk(uid) { return makeCard(cardDef[uid], nextId++); }
    function shuffled(uids) {
      var d = uids.map(mk);
      for (var j = d.length - 1; j > 0; j--) {
        var k = Math.floor(rng() * (j + 1));
        var tmp = d[j]; d[j] = d[k]; d[k] = tmp;
      }
      return d;
    }
    function newPlayer(uids) {
      return {
        deck: shuffled(uids), hand: [], board: [[], [], []],
        baseIncome: 1, income: 1, coins: 1,
        discards: [],
        pendingTax: 0, pendingDiscards: 0
      };
    }
    var players = [newPlayer(decks[0]), newPlayer(decks[1])];
    var turn = 1, activePlayer = 0, gameOver = false;

    function drawCard(P) { if (P.deck.length > 0) P.hand.push(P.deck.pop()); }
    for (var i = 0; i < STARTING_HAND; i++) { drawCard(players[0]); drawCard(players[1]); }

    // Dragon Pearl power is dynamic: +X where X is the controller's
    // agent count, including the host. Recompute it whenever boards
    // change, so agentPower / ministryPower always see the current X.
    function refreshItems() {
      players.forEach(function (P) {
        var count = 0;
        P.board.forEach(function (arr) { count += arr.length; });
        P.board.forEach(function (arr) {
          arr.forEach(function (c) {
            if (c.item && c.item.isPearl) c.item.attachPower = count;
          });
        });
      });
    }

    function sync(P) {
      P.income = P.baseIncome + (hasBonus(P.board, 1) ? 1 : 0) + abacusCount(P.board);
    }
    function syncAll() { refreshItems(); sync(players[0]); sync(players[1]); }

    // Regalia lock: bites only from the turn AFTER the item attaches
    // (turns are simultaneous, so the opponent still gets to play into
    // the ministry during the turn the Regalia hits the board).
    function locked(m) {
      for (var b = 0; b < 2; b++) {
        for (var j = 0; j < players[b].board[m].length; j++) {
          var it = players[b].board[m][j].item;
          if (it && it.uid === 'dragon-regalia' &&
              (it._lockedFrom === undefined || it._lockedFrom < turn)) return true;
        }
      }
      return false;
    }

    // End-of-turn death check: remove every agent at 0 or lower total
    // power, with its item, to its owner's discard pile. Removing one
    // agent can drop another (auras, Pearl count), so repeat until none
    // remain. Runs once per turn, in submit(1), before the next round
    // or the final scoring — never mid-turn, so a Poisoned agent stays
    // on the board, visible, until the turn is revealed.
    function deathCheck(evts) {
      for (;;) {
        refreshItems();
        var dead = [];
        players.forEach(function (P, pi) {
          P.board.forEach(function (arr, m) {
            arr.forEach(function (c, si) {
              if (totalAgentPower(P.board, m, c) <= 0) dead.push({ pi: pi, m: m, si: si, card: c });
            });
          });
        });
        if (dead.length === 0) break;
        // Remove highest slot first within each ministry so indices in
        // the same ministry stay valid as we splice.
        dead.sort(function (a, b) { return (a.pi - b.pi) || (a.m - b.m) || (b.si - a.si); });
        dead.forEach(function (d) {
          var P = players[d.pi];
          var removed = P.board[d.m].splice(d.si, 1)[0];
          P.discards.push(removed);
          var item = removed.item;
          removed.item = null;
          if (item) P.discards.push(item);
          evts.push({ type: 'removed', player: d.pi, card: removed.uid, cardName: removed.name, ministry: d.m, item: item ? item.uid : null });
        });
        syncAll();
      }
    }

    function onPlayEffects(P, card, evts) {
      var me = players[P];
      switch (card.uid) {
        case 'broker': me.coins += 1; evts.push({ type: 'coin', player: P, amount: 1, source: 'broker' }); break;
        case 'moneylender': me.coins += 3; evts.push({ type: 'coin', player: P, amount: 3, source: 'moneylender' }); break;
        case 'lookout':
        case 'spy': drawCard(me); evts.push({ type: 'draw', player: P, count: 1, source: card.uid }); break;
        case 'mastermind': drawCard(me); drawCard(me); evts.push({ type: 'draw', player: P, count: 2, source: 'mastermind' }); break;
        case 'diplomat': me.coins += 1; drawCard(me);
          evts.push({ type: 'coin', player: P, amount: 1, source: 'diplomat' });
          evts.push({ type: 'draw', player: P, count: 1, source: 'diplomat' });
          break;
        case 'treasurer': me.baseIncome += 1; sync(me); evts.push({ type: 'income', player: P, amount: 1, source: 'treasurer' }); break;
        case 'grand-treasurer': me.baseIncome += 3; sync(me); evts.push({ type: 'income', player: P, amount: 3, source: 'grand-treasurer' }); break;
        case 'smuggler': drawCard(me); evts.push({ type: 'draw', player: P, count: 1, source: 'smuggler' }); break;
        case 'raider':
        case 'sentry': me.pendingTax += 1; evts.push({ type: 'delayedTax', player: P, amount: 1, source: card.uid }); break;
        case 'double-agent':
        case 'blackmailer': me.pendingDiscards += 1; evts.push({ type: 'delayedDiscard', player: P, amount: 1, source: card.uid }); break;
        // poisoner / grand-spymaster resolve through the action's target below
      }
    }

    function applyPlay(P, action, evts) {
      var me = players[P], foe = players[1 - P];
      var card = me.hand.splice(action.handIndex, 1)[0];
      me.coins -= card.cost;
      me.board[action.ministry].push(card);
      evts.push({ type: 'play', player: P, card: card.uid, ministry: action.ministry });
      if (me.board[action.ministry].length === 2) evts.push({ type: 'bonus', player: P, ministry: action.ministry });
      onPlayEffects(P, card, evts);
      if (action.target) {
        var tm = action.target.ministry, ti = action.target.slot;
        if (card.uid === 'poisoner') {
          var tgt = foe.board[tm][ti];
          tgt.powerDelta = (tgt.powerDelta || 0) - 3;
          evts.push({ type: 'weaken', player: P, target: { ministry: tm, slot: ti } });
        } else if (card.uid === 'grand-spymaster') {
          var hadBonus = hasBonus(foe.board, tm);
          var stolen = foe.board[tm].splice(ti, 1)[0];
          me.board[tm].push(stolen);
          stolen.actionUsed = false; // a stolen agent is a fresh play for its new controller
          // Stealing counts as playing the agent for income bonuses:
          // Treasurer / Grand Treasurer income moves to the stealer and
          // leaves the original player. One-time coin/draw/delayed
          // effects do NOT re-fire on a steal.
          var incAmt = stolen.uid === 'treasurer' ? 1 : stolen.uid === 'grand-treasurer' ? 3 : 0;
          if (incAmt > 0) {
            foe.baseIncome = Math.max(1, foe.baseIncome - incAmt);
            me.baseIncome += incAmt;
            evts.push({ type: 'incomeTransfer', player: P, victim: 1 - P, amount: incAmt, source: stolen.uid });
          }
          evts.push({ type: 'steal', player: P, target: { ministry: tm, slot: ti } });
          if (me.board[tm].length === 2) evts.push({ type: 'bonus', player: P, ministry: tm });
          if (hadBonus && !hasBonus(foe.board, tm)) evts.push({ type: 'bonusLost', victim: 1 - P, ministry: tm });
        }
      }
      syncAll();
      return evts;
    }

    function applyItem(P, action, evts) {
      var me = players[P];
      var it = me.hand.splice(action.handIndex, 1)[0];
      me.coins -= it.cost;
      var ag = me.board[action.ministry][action.slot];
      ag.item = it;
      if (it.uid === 'dragon-regalia') it._lockedFrom = turn;
      if (it.uid === 'smoke-bomb') it.smokeArmed = true;
      evts.push({ type: 'item', player: P, card: it.uid, ministry: action.ministry, slot: action.slot });
      if (it.coinOnAttach) {
        me.coins += it.coinOnAttach;
        evts.push({ type: 'coin', player: P, amount: it.coinOnAttach, source: it.uid });
      }
      if (it.drawOnAttach) {
        drawCard(me);
        evts.push({ type: 'draw', player: P, count: 1, source: it.uid });
      }
      if (it.uid === 'abacus') {
        evts.push({ type: 'income', player: P, amount: 1, source: 'abacus' });
      }
      if (it.uid === 'smoke-bomb') {
        evts.push({ type: 'smokeArmed', player: P });
      }
      syncAll();
      return evts;
    }

    // Auctioneer action ability: once per turn per Auctioneer, discard a
    // hand card to gain 2 coins. The discarded card goes to the discard
    // pile and triggers nothing.
    function applyAction(P, action, evts) {
      var me = players[P];
      var ag = me.board[action.ministry][action.slot];
      var card = me.hand.splice(action.handIndex, 1)[0];
      me.discards.push(card);
      me.coins += 2;
      ag.actionUsed = true;
      evts.push({ type: 'action', player: P, card: 'auctioneer', discarded: card.uid, discardedName: card.name, ministry: action.ministry, slot: action.slot });
      evts.push({ type: 'coin', player: P, amount: 2, source: 'auctioneer' });
      syncAll();
      return evts;
    }

    function legalActions(P) {
      var acts = [];
      if (gameOver || activePlayer !== P) return acts;
      var me = players[P], foe = players[1 - P];
      me.hand.forEach(function (card, hi) {
        if (card.type === 'agent' && card.cost <= me.coins) {
          for (var m = 0; m < 3; m++) {
            if (me.board[m].length >= MAX_PER_MINISTRY) continue;
            if (locked(m)) continue;
            if (card.ministry !== null && card.ministry !== undefined && card.ministry !== m) continue;
            if (card.uid === 'poisoner') {
              foe.board.forEach(function (arr, m2) {
                arr.forEach(function (t, si) {
                  acts.push({ kind: 'play', handIndex: hi, ministry: m, target: { ministry: m2, slot: si } });
                });
              });
              acts.push({ kind: 'play', handIndex: hi, ministry: m });
            } else if (card.uid === 'grand-spymaster') {
              foe.board.forEach(function (arr, m2) {
                if (me.board[m2].length >= MAX_PER_MINISTRY) return;
                arr.forEach(function (t, si) {
                  acts.push({ kind: 'play', handIndex: hi, ministry: m, target: { ministry: m2, slot: si } });
                });
              });
              acts.push({ kind: 'play', handIndex: hi, ministry: m });
            } else {
              acts.push({ kind: 'play', handIndex: hi, ministry: m });
            }
          }
        }
      });
      me.hand.forEach(function (card, hi) {
        if (card.type !== 'item' || card.cost > me.coins) return;
        for (var m = 0; m < 3; m++) {
          if (card.ministry !== null && card.ministry !== undefined && card.ministry !== m) continue;
          me.board[m].forEach(function (ag, si) {
            if (ag.item) return; // one item per agent
            acts.push({ kind: 'item', handIndex: hi, ministry: m, slot: si });
          });
        }
      });
      // Auctioneer action: once per turn per Auctioneer, discard any
      // hand card for 2 coins.
      me.board.forEach(function (arr, m) {
        arr.forEach(function (ag, si) {
          if (ag.uid !== 'auctioneer' || ag.actionUsed) return;
          me.hand.forEach(function (card, hi) {
            acts.push({ kind: 'action', handIndex: hi, ministry: m, slot: si });
          });
        });
      });
      acts.push({ kind: 'submit' });
      return acts;
    }

    function submit(P) {
      if (gameOver) throw new Error('game is over');
      if (activePlayer !== P) throw new Error('not player ' + P + ' phase');
      if (P === 0) {
        activePlayer = 1;
        return [{ type: 'phase', player: 1 }];
      }
      // End of turn: death check first, after all of both players'
      // effects have resolved, before the next round or final scoring.
      var deathEvts = [];
      deathCheck(deathEvts);
      // Player 1's submit: turn 6 ends the game, otherwise the next round starts.
      if (turn >= MAX_TURNS) {
        gameOver = true;
        return deathEvts.concat([{ type: 'gameOver', result: computeResult() }]);
      }
      turn += 1;
      players.forEach(function (P) {
        P.board.forEach(function (arr) {
          arr.forEach(function (c) { c.actionUsed = false; });
        });
      });
      var evts = deathEvts.concat([{ type: 'roundStart', round: turn }]);
      // income phase: base +1, effective income (base + Commerce bonus), coins refill
      players[0].baseIncome += 1;
      players[1].baseIncome += 1;
      syncAll();
      players[0].coins = players[0].income;
      players[1].coins = players[1].income;
      // delayed taxes (Sentry / Raider), each side's queue hits the opponent
      for (var q = 0; q < 2; q++) {
        if (players[q].pendingTax > 0) {
          var amt = Math.min(players[q].pendingTax, players[1 - q].coins);
          players[1 - q].coins -= amt;
          players[q].pendingTax = 0;
          if (amt > 0) evts.push({ type: 'taxHit', victim: 1 - q, amount: amt });
        }
      }
      // Smoke Bombs: at the start of the turn, after income, each armed
      // Smoke Bomb is discarded from its host and its controller's
      // opponent loses 1 coin (capped at 0). A Bomb removed before
      // this point — death check, or its host leaving the board — never
      // fires. A stolen Bomb fires against its new controller's
      // opponent, i.e. the effect reverses with the steal.
      players.forEach(function (P, pi) {
        P.board.forEach(function (arr) {
          arr.forEach(function (ag) {
            if (ag.item && ag.item.uid === 'smoke-bomb' && ag.item.smokeArmed) {
              var bomb = ag.item;
              ag.item = null;
              P.discards.push(bomb);
              var amt = Math.min(1, players[1 - pi].coins);
              players[1 - pi].coins -= amt;
              if (amt > 0) evts.push({ type: 'smokeHit', victim: 1 - pi, amount: amt });
            }
          });
        });
      });
      syncAll();
      // tax phase: the side with the weaker Military loses `tax` coins
      // (denial-only: the stronger side gains nothing). Tie loses nothing.
      var tax = taxLevel(players[0].board, players[1].board);
      if (tax > 0) {
        var yp = ministryPower(players[0].board, 0);
        var op = ministryPower(players[1].board, 0);
        if (yp > op) {
          var t1 = Math.min(tax, players[1].coins);
          players[1].coins -= t1;
          if (t1 > 0) evts.push({ type: 'tax', payer: 1, amount: t1 });
        } else if (op > yp) {
          var t2 = Math.min(tax, players[0].coins);
          players[0].coins -= t2;
          if (t2 > 0) evts.push({ type: 'tax', payer: 0, amount: t2 });
        }
      }
      // draw phase: 1 + Intrigue bonus each
      var pd = 1 + (hasBonus(players[0].board, 2) ? 1 : 0);
      var od = 1 + (hasBonus(players[1].board, 2) ? 1 : 0);
      for (var i = 0; i < pd; i++) drawCard(players[0]);
      for (var j = 0; j < od; j++) drawCard(players[1]);
      evts.push({ type: 'draw', player: 0, count: pd, source: 'round' });
      evts.push({ type: 'draw', player: 1, count: od, source: 'round' });
      // post-draw delayed discards (Double Agent / Blackmailer)
      for (var d = 0; d < 2; d++) {
        if (players[d].pendingDiscards > 0) {
          var dc = 0, cards = [];
          for (var k = 0; k < players[d].pendingDiscards; k++) {
            var hand = players[1 - d].hand;
            if (hand.length > 0) {
              var c = hand.splice(Math.floor(rng() * hand.length), 1)[0];
              players[1 - d].discards.push(c);
              cards.push(c.uid);
              dc += 1;
            }
          }
          players[d].pendingDiscards = 0;
          if (dc > 0) evts.push({ type: 'forcedDiscard', victim: 1 - d, count: dc, cards: cards });
        }
      }
      activePlayer = 0;
      return evts;
    }

    function apply(P, action) {
      if (gameOver) throw new Error('game is over');
      if (activePlayer !== P) throw new Error('not player ' + P + ' phase');
      if (!action || typeof action.kind !== 'string') throw new Error('bad action');
      if (action.kind === 'submit') return submit(P);
      var legal = legalActions(P);
      var ok = legal.some(function (a) { return sameAction(a, action); });
      if (!ok) throw new Error('illegal action: ' + JSON.stringify(action));
      var evts = [];
      if (action.kind === 'play') return applyPlay(P, action, evts);
      if (action.kind === 'item') return applyItem(P, action, evts);
      if (action.kind === 'action') return applyAction(P, action, evts);
      throw new Error('unknown action kind: ' + action.kind);
    }

    function computeResult() {
      var arb = [false, false];
      players.forEach(function (P, pi) {
        P.board.forEach(function (arr) {
          arr.forEach(function (c) { if (c.uid === 'imperial-arbiter') arb[pi] = true; });
        });
      });
      var detail = [], wins = [0, 0], powers = [0, 0];
      for (var m = 0; m < 3; m++) {
        var p0 = ministryPower(players[0].board, m);
        var p1 = ministryPower(players[1].board, m);
        powers[0] += p0; powers[1] += p1;
        var w = p0 > p1 ? 0 : p1 > p0 ? 1 :
          (arb[0] && !arb[1] ? 0 : arb[1] && !arb[0] ? 1 : null);
        if (w !== null) wins[w] += 1;
        detail.push({ ministry: m, name: MINISTRIES[m].name, p0: p0, p1: p1, winner: w });
      }
      var winner = wins[0] > wins[1] ? 0 : wins[1] > wins[0] ? 1 :
        (powers[0] > powers[1] ? 0 : powers[1] > powers[0] ? 1 : null);
      var tiebreak = wins[0] === wins[1] && winner !== null;
      return { winner: winner, wins: wins, powers: powers, detail: detail, tiebreak: tiebreak };
    }

    function view(P) {
      var me = players[P], foe = players[1 - P];
      return {
        turn: turn, activePlayer: activePlayer, gameOver: gameOver,
        locked: [locked(0), locked(1), locked(2)],
        me: {
          hand: me.hand.map(copyCard), deckCount: me.deck.length,
          board: copyBoard(me.board), income: me.income, coins: me.coins,
          discards: me.discards.map(copyCard)
        },
        opp: {
          handCount: foe.hand.length, deckCount: foe.deck.length,
          board: copyBoard(foe.board), income: foe.income, coins: foe.coins,
          discards: foe.discards.map(copyCard)
        }
      };
    }

    function state() {
      return JSON.parse(JSON.stringify({
        turn: turn, activePlayer: activePlayer, gameOver: gameOver,
        players: players.map(function (P) {
          return {
            hand: P.hand, deck: P.deck, board: P.board,
            baseIncome: P.baseIncome, income: P.income, coins: P.coins,
            discards: P.discards,
            pendingTax: P.pendingTax,
            pendingDiscards: P.pendingDiscards
          };
        })
      }));
    }

    // Internal: adopt a state() snapshot + RNG state (used by clone).
    function _restore(snap, rngState) {
      turn = snap.turn; activePlayer = snap.activePlayer; gameOver = snap.gameOver;
      for (var i = 0; i < 2; i++) {
        var s = snap.players[i], P = players[i];
        P.hand = s.hand; P.deck = s.deck; P.board = s.board;
        P.baseIncome = s.baseIncome; P.income = s.income; P.coins = s.coins;
        P.discards = s.discards;
        P.pendingTax = s.pendingTax;
        P.pendingDiscards = s.pendingDiscards;
      }
      var maxId = 0;
      players.forEach(function (P) {
        [P.hand, P.deck, P.discards].forEach(function (arr) {
          arr.forEach(function (c) { if (c.id > maxId) maxId = c.id; });
        });
        P.board.forEach(function (arr) {
          arr.forEach(function (c) {
            if (c.id > maxId) maxId = c.id;
            if (c.item && c.item.id > maxId) maxId = c.item.id;
          });
        });
      });
      nextId = maxId + 1;
      rng.setState(rngState);
    }

    function clone() {
      var g = createGame({ decks: initialDecks, seed: seed });
      g._restore(state(), rng.state());
      return g;
    }

    return {
      seed: seed, rng: rng,
      view: view, state: state, clone: clone, _restore: _restore,
      legalActions: legalActions, apply: apply, submit: submit,
      result: function () { return gameOver ? computeResult() : null; }
    };
  }

  // ---------- greedy policy (the current AI, as a view -> action function) ----------
  // Decision rule: first consider an Auctioneer action to afford a play,
  // then play the affordable agent with the highest cost (then power) to
  // the best-scored valid column, then attach the affordable item with
  // the highest value. Poisoner weakens the opponent's strongest agent;
  // Grand Spymaster steals the strongest agent it has room for; Regalia
  // locks the ministry where its lead is largest. Returns
  // { kind: 'submit' } when nothing is playable. Uses ONLY the view.
  // Deterministic: rng is kept for API compatibility but no longer
  // drives placement.
  function greedyPolicy(view, rng) {
    rng = rng || Math.random;
    var me = view.me, foe = view.opp;
    function validCols(card, board) {
      var cols = [];
      for (var m = 0; m < 3; m++) {
        if (board[m].length >= MAX_PER_MINISTRY) continue;
        if (view.locked[m]) continue;
        if (card.ministry !== null && card.ministry !== undefined && card.ministry !== m) continue;
        cols.push(m);
      }
      return cols;
    }
    function hasItemTarget(card) {
      for (var mm = 0; mm < 3; mm++) {
        if (card.ministry !== null && card.ministry !== undefined && card.ministry !== mm) continue;
        for (var si = 0; si < me.board[mm].length; si++) {
          if (!me.board[mm][si].item) return true;
        }
      }
      return false;
    }
    function itemValue(c) {
      if (view.turn >= MAX_TURNS && (c.uid === 'smoke-bomb' || c.uid === 'abacus')) return -1;
      var v = c.attachPower || 0;
      v += c.coinOnAttach || 0;
      if (c.drawOnAttach) v += 3;
      if (c.uid === 'abacus') v += 3;
      if (c.uid === 'smoke-bomb') v += 2;
      return v;
    }
    // Keep-value of a hand card, for choosing Auctioneer-action fodder:
    // low = discardable. Ability cards and Auctioneer are protected.
    function keepScore(c) {
      if (c.type === 'agent') {
        var s = c.power || 0;
        if (['treasurer', 'grand-treasurer', 'broker', 'moneylender', 'diplomat',
             'lookout', 'spy', 'mastermind', 'smuggler', 'tax-collector',
             'grand-marshal', 'sentry', 'raider', 'poisoner', 'grand-spymaster',
             'imperial-arbiter', 'quartermaster', 'veteran-sergeant'].indexOf(c.uid) >= 0) s += 3;
        if (c.uid === 'auctioneer') s += 10;
        if (c.ministry !== null && c.ministry !== undefined &&
            (me.board[c.ministry].length >= MAX_PER_MINISTRY || view.locked[c.ministry])) s = -10;
        return s;
      }
      if (c.type === 'item') return itemValue(c);
      return 0;
    }
    // Score a ministry for placing `card`: flipping to a lead beats closing
    // a gap, which beats padding a lead; triggering the 2nd-slot bonus and
    // securing a second winning ministry are both worth extra. Ties go to
    // the lowest ministry index, so placement is deterministic.
    function bestCol(card, cols) {
      var leadsBefore = 0;
      for (var mm = 0; mm < 3; mm++) {
        if (ministryPower(me.board, mm) > ministryPower(foe.board, mm)) leadsBefore++;
      }
      var bestM = cols[0], bestS = -Infinity;
      cols.forEach(function (m) {
        var sim = me.board.map(function (arr) { return arr.slice(); });
        sim[m] = sim[m].concat([card]);
        var myBefore = ministryPower(me.board, m), foePow = ministryPower(foe.board, m);
        var myAfter = ministryPower(sim, m), gain = myAfter - myBefore;
        var score = 0;
        if (me.board[m].length === 1) score += 4;
        if (myBefore < foePow && myAfter > foePow) score += 20;
        else if (myBefore < foePow && myAfter === foePow) score += 12;
        else if (myBefore < foePow) score += gain;
        else score += gain * 0.25;
        var leadsAfter = leadsBefore;
        if (myBefore <= foePow && myAfter > foePow) leadsAfter++;
        if (leadsAfter > leadsBefore) score += 15;
        if (score > bestS) { bestS = score; bestM = m; }
      });
      return bestM;
    }
    // ---- Auctioneer action (once per turn per Auctioneer; coins do not
    // carry over, so an action is only worth it if its 2 coins get spent
    // this turn). Runs before playing, because the policy loop re-runs
    // after the action and then plays with the new coin total.
    var auctioneer = null;
    me.board.forEach(function (arr, m) {
      arr.forEach(function (ag, si) {
        if (!auctioneer && ag.uid === 'auctioneer' && !ag.actionUsed) {
          auctioneer = { ministry: m, slot: si };
        }
      });
    });
    if (auctioneer && me.hand.length > 0) {
      var affordableExists = false;
      me.hand.forEach(function (c) {
        if (c.type === 'agent' && c.cost <= me.coins && validCols(c, me.board).length > 0) affordableExists = true;
        if (c.type === 'item' && c.cost <= me.coins && hasItemTarget(c)) affordableExists = true;
      });
      var bestUnaff = null, bestUnaffHi = -1, bestUnaffPow = -Infinity;
      me.hand.forEach(function (c, hi) {
        if (c.cost === null || c.cost === undefined || c.cost <= me.coins || c.cost > me.coins + 2) return;
        var ok = false, pow = 0;
        if (c.type === 'agent' && validCols(c, me.board).length > 0) { ok = true; pow = c.power || 0; }
        if (c.type === 'item' && hasItemTarget(c)) { ok = true; pow = itemValue(c); }
        if (ok && (!bestUnaff || c.cost > bestUnaff.cost ||
            (c.cost === bestUnaff.cost && pow > bestUnaffPow))) {
          bestUnaff = c; bestUnaffHi = hi; bestUnaffPow = pow;
        }
      });
      if (bestUnaff) {
        var fodderHi = -1, fodderScore = Infinity, fodderPow = 0;
        me.hand.forEach(function (c, hi) {
          if (hi === bestUnaffHi) return;
          var s = keepScore(c);
          if (s < fodderScore) {
            fodderScore = s; fodderHi = hi;
            fodderPow = c.type === 'item' ? itemValue(c) : (c.power || 0);
          }
        });
        if (fodderHi >= 0) {
          var isAbility = ['treasurer', 'grand-treasurer', 'broker', 'moneylender', 'diplomat',
            'lookout', 'spy', 'mastermind', 'smuggler', 'tax-collector', 'grand-marshal',
            'sentry', 'raider', 'poisoner', 'grand-spymaster', 'imperial-arbiter',
            'quartermaster', 'veteran-sergeant'].indexOf(bestUnaff.uid) >= 0;
          if (!affordableExists || isAbility || bestUnaffPow > fodderPow + 1) {
            return { kind: 'action', handIndex: fodderHi, ministry: auctioneer.ministry, slot: auctioneer.slot };
          }
        }
      }
    }
    var bestCard = null, bestHi = -1;
    me.hand.forEach(function (c, hi) {
      if (c.type !== 'agent' || c.cost > me.coins) return;
      if (validCols(c, me.board).length === 0) return;
      if (!bestCard || c.cost > bestCard.cost ||
          (c.cost === bestCard.cost && c.power > bestCard.power)) { bestCard = c; bestHi = hi; }
    });
    if (bestCard) {
      var cols = validCols(bestCard, me.board);
      var m = bestCol(bestCard, cols);
      var act = { kind: 'play', handIndex: bestHi, ministry: m };
      if (bestCard.uid === 'poisoner') {
        var bp = null, bpPow = -Infinity;
        foe.board.forEach(function (arr, m2) {
          arr.forEach(function (t, si) {
            var p = agentPower(t);
            if (p > bpPow) { bpPow = p; bp = { ministry: m2, slot: si }; }
          });
        });
        if (bp) act.target = bp;
      } else if (bestCard.uid === 'grand-spymaster') {
        var bs = null, bsPow = -Infinity;
        foe.board.forEach(function (arr, m2) {
          if (me.board[m2].length >= MAX_PER_MINISTRY) return;
          arr.forEach(function (t, si) {
            var p = agentPower(t);
            if (p > bsPow) { bsPow = p; bs = { ministry: m2, slot: si }; }
          });
        });
        if (bs) act.target = bs;
      }
      return act;
    }
    var bestItem = null, bestItemHi = -1, bestItemVal = -Infinity;
    me.hand.forEach(function (c, hi) {
      if (c.type !== 'item' || c.cost > me.coins) return;
      if (!hasItemTarget(c)) return;
      var v = itemValue(c);
      if (v < 0) return;
      if (!bestItem || v > bestItemVal || (v === bestItemVal && c.cost > bestItem.cost)) {
        bestItem = c; bestItemHi = hi; bestItemVal = v;
      }
    });
    if (bestItem) {
      var tgt = null;
      if (bestItem.uid === 'dragon-regalia') {
        var bestLead = -Infinity;
        me.board.forEach(function (arr, mm) {
          if (bestItem.ministry !== null && bestItem.ministry !== undefined && bestItem.ministry !== mm) return;
          arr.forEach(function (ag, si) {
            if (ag.item) return;
            var lead = ministryPower(me.board, mm) - ministryPower(foe.board, mm);
            if (lead > bestLead) { bestLead = lead; tgt = { ministry: mm, slot: si }; }
          });
        });
      } else if ((bestItem.attachPower || 0) > 0) {
        var bestPow = -Infinity;
        me.board.forEach(function (arr, mm) {
          if (bestItem.ministry !== null && bestItem.ministry !== undefined && bestItem.ministry !== mm) return;
          arr.forEach(function (ag, si) {
            if (ag.item) return;
            var p = agentPower(ag);
            if (p > bestPow) { bestPow = p; tgt = { ministry: mm, slot: si }; }
          });
        });
      } else {
        var worstPow = Infinity;
        me.board.forEach(function (arr, mm) {
          if (bestItem.ministry !== null && bestItem.ministry !== undefined && bestItem.ministry !== mm) return;
          arr.forEach(function (ag, si) {
            if (ag.item) return;
            var p = agentPower(ag);
            if (p < worstPow) { worstPow = p; tgt = { ministry: mm, slot: si }; }
          });
        });
      }
      if (tgt) return { kind: 'item', handIndex: bestItemHi, ministry: tgt.ministry, slot: tgt.slot };
    }
    return { kind: 'submit' };
  }

  // ---------- export ----------
  var api = {
    SET1: SET1, cardDef: cardDef,
    MINISTRIES: MINISTRIES, MAX_TURNS: MAX_TURNS, MAX_PER_MINISTRY: MAX_PER_MINISTRY,
    createGame: createGame, greedyPolicy: greedyPolicy,
    agentPower: agentPower, ministryPower: ministryPower, taxLevel: taxLevel
  };
  root.TCGEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
