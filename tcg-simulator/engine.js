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
 *   { kind: 'equip', handIndex, ministry, slot }
 *   { kind: 'sell', handIndex, target?: { ministry, slot } }  // Dragon Pearl return
 *   { kind: 'submit' }
 * A targeting card (Poisoner, Grand Spymaster, Dragon Pearl) may always be
 * played/sold WITHOUT a target — the ability then fizzles, exactly as when
 * the player cancels targeting in the UI.
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
    { uid: 'auctioneer', name: 'Auctioneer', type: 'agent', cost: 3, power: 4, ministry: 1, rarity: 'U', text: 'Whenever you discard a card, gain 1 extra coin.' },
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
    // Items (5)
    { uid: 'coin-pouch', name: 'Coin Pouch', type: 'item', cost: null, power: null, ministry: null, rarity: 'C', text: 'When discarded: gain 1 extra coin for each agent in your Commerce.' },
    { uid: 'smoke-bomb', name: 'Smoke Bomb', type: 'item', cost: null, power: null, ministry: null, rarity: 'C', text: 'When discarded: opponent loses 1 coin for each agent in your Military at the start of your next turn.' },
    { uid: 'sealed-letter', name: 'Sealed Letter', type: 'item', cost: null, power: null, ministry: null, rarity: 'U', text: 'When discarded: draw a card.' },
    { uid: 'abacus', name: 'Abacus', type: 'item', cost: null, power: null, ministry: null, rarity: 'U', text: 'When discarded: +1 income if you have an agent in Commerce.' },
    { uid: 'dragon-pearl', name: 'Dragon Pearl', type: 'item', cost: null, power: null, ministry: null, rarity: 'R', text: 'When discarded: return an agent to your hand, gain its cost in coins.' },
    // Equips (8)
    { uid: 'iron-arms', name: 'Iron Bracers', type: 'equip', cost: 2, power: null, ministry: 0, rarity: 'C', text: 'Attached agent gets +4 power.', attachPower: 4 },
    { uid: 'merchants-scale', name: "Merchant's Scale", type: 'equip', cost: 2, power: null, ministry: 1, rarity: 'C', text: 'Attached agent gets +4 power.', attachPower: 4 },
    { uid: 'concealed-blade', name: 'Concealed Blade', type: 'equip', cost: 2, power: null, ministry: 2, rarity: 'C', text: 'Attached agent gets +4 power.', attachPower: 4 },
    { uid: 'travelers-pack', name: "Traveler's Pack", type: 'equip', cost: 2, power: null, ministry: null, rarity: 'C', text: 'Attached agent gets +3 power.', attachPower: 3 },
    { uid: 'tiger-armor', name: 'Tiger Armor', type: 'equip', cost: 3, power: null, ministry: 0, rarity: 'U', text: 'Attached agent gets +4 power. The tax amount is +1.', attachPower: 4 },
    { uid: 'war-chest', name: 'War Chest', type: 'equip', cost: 2, power: null, ministry: 1, rarity: 'U', text: 'When attached: gain 3 coins. Attached agent gets +1 power.', attachPower: 1, coinOnAttach: 3 },
    { uid: 'shadow-cloak', name: 'Shadow Cloak', type: 'equip', cost: 3, power: null, ministry: 2, rarity: 'U', text: 'When attached: draw a card. Attached agent gets +4 power.', attachPower: 4, drawOnAttach: 1 },
    { uid: 'dragon-regalia', name: 'Dragon Regalia', type: 'equip', cost: 4, power: null, ministry: null, rarity: 'R', text: 'Attached agent gets +3 power. As long as this is equipped, players cannot play agents on the equipped agent\'s ministry (starting next turn).', attachPower: 3 }
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
    if (t.type === 'agent') c.equips = [];
    if (t.type === 'equip') {
      c.attachPower = t.attachPower || 0;
      c.coinOnAttach = t.coinOnAttach || 0;
      c.drawOnAttach = t.drawOnAttach || 0;
    }
    return c;
  }

  function agentPower(c) {
    var p = c.power || 0;
    (c.equips || []).forEach(function (e) { p += e.attachPower || 0; });
    if (c.powerDelta) p += c.powerDelta;
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
      (c.equips || []).forEach(function (e) { if (e.uid === 'tiger-armor') n += 1; });
    });
    return n;
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
      if (k === 'equips') o.equips = c.equips ? c.equips.slice() : c.equips;
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
        discards: [], discardUsed: false,
        pendingTax: 0, pendingSmoke: false, pendingDiscards: 0
      };
    }
    var players = [newPlayer(decks[0]), newPlayer(decks[1])];
    var turn = 1, activePlayer = 0, gameOver = false;

    function drawCard(P) { if (P.deck.length > 0) P.hand.push(P.deck.pop()); }
    for (var i = 0; i < STARTING_HAND; i++) { drawCard(players[0]); drawCard(players[1]); }

    function sync(P) { P.income = P.baseIncome + (hasBonus(P.board, 1) ? 1 : 0); }
    function syncAll() { sync(players[0]); sync(players[1]); }

    // Regalia lock: bites only from the turn AFTER the equip (turns are
    // simultaneous, so the opponent still gets to play into the ministry
    // during the turn the Regalia hits the board).
    function locked(m) {
      for (var b = 0; b < 2; b++) {
        for (var j = 0; j < players[b].board[m].length; j++) {
          var eqs = players[b].board[m][j].equips || [];
          for (var k = 0; k < eqs.length; k++) {
            if (eqs[k].uid === 'dragon-regalia' &&
                (eqs[k]._lockedFrom === undefined || eqs[k]._lockedFrom < turn)) return true;
          }
        }
      }
      return false;
    }

    function sellVal(P) {
      var n = 1;
      for (var m = 0; m < 3; m++) {
        for (var j = 0; j < P.board[m].length; j++) {
          if (P.board[m][j].uid === 'auctioneer') n += 1;
        }
      }
      return n;
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
          evts.push({ type: 'steal', player: P, target: { ministry: tm, slot: ti } });
          if (me.board[tm].length === 2) evts.push({ type: 'bonus', player: P, ministry: tm });
          if (hadBonus && !hasBonus(foe.board, tm)) evts.push({ type: 'bonusLost', victim: 1 - P, ministry: tm });
        }
      }
      syncAll();
      return evts;
    }

    function applyEquip(P, action, evts) {
      var me = players[P];
      var eq = me.hand.splice(action.handIndex, 1)[0];
      me.coins -= eq.cost;
      var ag = me.board[action.ministry][action.slot];
      ag.equips.push(eq);
      if (eq.uid === 'dragon-regalia') eq._lockedFrom = turn;
      evts.push({ type: 'equip', player: P, card: eq.uid, ministry: action.ministry, slot: action.slot });
      if (eq.coinOnAttach) {
        me.coins += eq.coinOnAttach;
        evts.push({ type: 'coin', player: P, amount: eq.coinOnAttach, source: 'war-chest' });
      }
      if (eq.drawOnAttach) {
        drawCard(me);
        evts.push({ type: 'draw', player: P, count: 1, source: 'shadow-cloak' });
      }
      syncAll();
      return evts;
    }

    function itemFx(P, card, target, evts) {
      var me = players[P];
      switch (card.uid) {
        case 'coin-pouch': {
          var n = me.board[1].length;
          me.coins += n;
          evts.push({ type: 'coin', player: P, amount: n, source: 'coin-pouch' });
          break;
        }
        case 'smoke-bomb':
          me.pendingSmoke = true;
          evts.push({ type: 'delayedSmoke', player: P });
          break;
        case 'sealed-letter':
          drawCard(me);
          evts.push({ type: 'draw', player: P, count: 1, source: 'sealed-letter' });
          break;
        case 'abacus':
          if (me.board[1].length > 0) {
            me.baseIncome += 1; sync(me);
            evts.push({ type: 'income', player: P, amount: 1, source: 'abacus' });
          } else {
            evts.push({ type: 'noEffect', player: P, source: 'abacus' });
          }
          break;
        case 'dragon-pearl': {
          if (!target) { evts.push({ type: 'noEffect', player: P, source: 'dragon-pearl' }); break; }
          var m = target.ministry, idx = target.slot;
          var had = hasBonus(me.board, m);
          var tgt = me.board[m].splice(idx, 1)[0];
          tgt.equips = [];
          tgt.powerDelta = 0;
          me.hand.push(tgt);
          me.coins += tgt.cost;
          sync(me);
          if (had && !hasBonus(me.board, m)) evts.push({ type: 'bonusLost', victim: P, ministry: m });
          evts.push({ type: 'return', player: P, card: tgt.uid, cardName: tgt.name, coins: tgt.cost });
          break;
        }
      }
    }

    function applySell(P, action, evts) {
      var me = players[P];
      var card = me.hand.splice(action.handIndex, 1)[0];
      me.discards.push(card);
      me.coins += sellVal(me);
      me.discardUsed = true;
      evts.push({ type: 'sell', player: P, card: card.uid });
      if (card.type === 'item') itemFx(P, card, action.target, evts);
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
        if (card.type !== 'equip' || card.cost > me.coins) return;
        for (var m = 0; m < 3; m++) {
          if (card.ministry !== null && card.ministry !== undefined && card.ministry !== m) continue;
          me.board[m].forEach(function (ag, si) {
            acts.push({ kind: 'equip', handIndex: hi, ministry: m, slot: si });
          });
        }
      });
      if (!me.discardUsed) {
        me.hand.forEach(function (card, hi) {
          if (card.uid === 'dragon-pearl') {
            me.board.forEach(function (arr, m) {
              arr.forEach(function (ag, si) {
                acts.push({ kind: 'sell', handIndex: hi, target: { ministry: m, slot: si } });
              });
            });
            acts.push({ kind: 'sell', handIndex: hi });
          } else {
            acts.push({ kind: 'sell', handIndex: hi });
          }
        });
      }
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
      // Player 1's submit: turn 6 ends the game, otherwise the next round starts.
      if (turn >= MAX_TURNS) {
        gameOver = true;
        return [{ type: 'gameOver', result: computeResult() }];
      }
      turn += 1;
      players[0].discardUsed = false;
      players[1].discardUsed = false;
      var evts = [{ type: 'roundStart', round: turn }];
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
      // delayed smoke bombs: -1 coin per the actor's Military agents, counted now
      for (var s = 0; s < 2; s++) {
        if (players[s].pendingSmoke) {
          var ps = Math.min(players[s].board[0].length, players[1 - s].coins);
          players[1 - s].coins -= ps;
          players[s].pendingSmoke = false;
          if (ps > 0) evts.push({ type: 'smokeHit', victim: 1 - s, amount: ps });
        }
      }
      // tax phase: each Military bonus +1, plus tax modifiers; the side with
      // the weaker Military pays the stronger side (floor 0, tie pays nothing)
      var tax = (hasBonus(players[0].board, 0) ? 1 : 0) + (hasBonus(players[1].board, 0) ? 1 : 0) +
        taxModifier(players[0].board) + taxModifier(players[1].board);
      if (tax > 0) {
        var yp = ministryPower(players[0].board, 0);
        var op = ministryPower(players[1].board, 0);
        if (yp > op) {
          var t1 = Math.min(tax, players[1].coins);
          players[1].coins -= t1; players[0].coins += t1;
          if (t1 > 0) evts.push({ type: 'tax', payer: 1, amount: t1 });
        } else if (op > yp) {
          var t2 = Math.min(tax, players[0].coins);
          players[0].coins -= t2; players[1].coins += t2;
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
      if (action.kind === 'equip') return applyEquip(P, action, evts);
      if (action.kind === 'sell') return applySell(P, action, evts);
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
          discards: me.discards.map(copyCard), discardUsed: me.discardUsed,
          sellValue: sellVal(me)
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
            discards: P.discards, discardUsed: P.discardUsed,
            pendingTax: P.pendingTax, pendingSmoke: P.pendingSmoke,
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
        P.discards = s.discards; P.discardUsed = s.discardUsed;
        P.pendingTax = s.pendingTax; P.pendingSmoke = s.pendingSmoke;
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
            (c.equips || []).forEach(function (e) { if (e.id > maxId) maxId = e.id; });
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
  // Decision rule, unchanged from the old opponentPlay: play the affordable
  // agent with the highest cost (then power) to a random valid column, then
  // attach the affordable equip with the highest cost. Poisoner weakens the
  // opponent's strongest agent; Grand Spymaster steals the strongest agent
  // it has room for; Regalia locks the ministry where its lead is largest.
  // Returns { kind: 'submit' } when nothing is playable. Uses ONLY the view.
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
    var bestCard = null, bestHi = -1;
    me.hand.forEach(function (c, hi) {
      if (c.type !== 'agent' || c.cost > me.coins) return;
      if (validCols(c, me.board).length === 0) return;
      if (!bestCard || c.cost > bestCard.cost ||
          (c.cost === bestCard.cost && c.power > bestCard.power)) { bestCard = c; bestHi = hi; }
    });
    if (bestCard) {
      var cols = validCols(bestCard, me.board);
      var m = cols[Math.floor(rng() * cols.length)];
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
    var bestEq = null, bestEqHi = -1;
    me.hand.forEach(function (c, hi) {
      if (c.type !== 'equip' || c.cost > me.coins) return;
      var hasTgt = false;
      for (var mm = 0; mm < 3; mm++) {
        if (c.ministry !== null && c.ministry !== undefined && c.ministry !== mm) continue;
        if (me.board[mm].length > 0) { hasTgt = true; break; }
      }
      if (!hasTgt) return;
      if (!bestEq || c.cost > bestEq.cost) { bestEq = c; bestEqHi = hi; }
    });
    if (bestEq) {
      var tgt = null;
      if (bestEq.uid === 'dragon-regalia') {
        var bestLead = -Infinity;
        me.board.forEach(function (arr, mm) {
          if (bestEq.ministry !== null && bestEq.ministry !== undefined && bestEq.ministry !== mm) return;
          arr.forEach(function (ag, si) {
            var lead = ministryPower(me.board, mm) - ministryPower(foe.board, mm);
            if (lead > bestLead) { bestLead = lead; tgt = { ministry: mm, slot: si }; }
          });
        });
      } else {
        for (var m2 = 0; m2 < 3; m2++) {
          if (bestEq.ministry !== null && bestEq.ministry !== undefined && bestEq.ministry !== m2) continue;
          if (me.board[m2].length > 0) { tgt = { ministry: m2, slot: 0 }; break; }
        }
      }
      if (tgt) return { kind: 'equip', handIndex: bestEqHi, ministry: tgt.ministry, slot: tgt.slot };
    }
    return { kind: 'submit' };
  }

  // ---------- export ----------
  var api = {
    SET1: SET1, cardDef: cardDef,
    MINISTRIES: MINISTRIES, MAX_TURNS: MAX_TURNS, MAX_PER_MINISTRY: MAX_PER_MINISTRY,
    createGame: createGame, greedyPolicy: greedyPolicy,
    agentPower: agentPower, ministryPower: ministryPower
  };
  root.TCGEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
