/** The bot: which KataGo profile plays a rank, the handicap below the weakest bot, how the bot picks a move, the KataGo client. */
import { isLegal } from './rules.mjs';

export const boardSize = 13;
export const evenKomi = 6.5;
/** Ranks are kept as kyu; 0 and below are dan: 0 is 1 dan, -8 is 9 dan. */
/** Without saved games the rank starts at 30 kyu; losses take it lower without end, under more stones. */
export const startKyu = 30;
export const rankText = (kyu) => (kyu >= 1 ? `${kyu} кю` : `${1 - kyu} дан`);

/** The scale of OGS: rating = 525·e^(rank/23.15), where rank 0 is 30 kyu; win odds by Elo. */
export const eloOfKyu = (kyu) => 525 * Math.exp((30 - kyu) / 23.15);

/**
 * KataGo's human profiles on 13 × 13, measured against each other by scripts/calibrate.mjs and fitted
 * by scripts/fit.mjs (calibration/fit.json): Elo over rank_20k at knots every few ranks, keyed by the
 * profile's rank, and the handicap points one Elo needs, measured in handicap games between profiles.
 * The bots' own scale is the truth here: they were never measured against people.
 */
const measuredElo = { 20: 0, 15: 172, 10: 435, 5: 751, 0: 1262, [-2]: 1351 };
const handicapPerElo = 0.0903;
const measuredKyus = Object.keys(measuredElo).map(Number).sort((a, b) => b - a);
const profileName = (kyu) => (kyu < 1 ? `rank_${1 - kyu}d` : `rank_${kyu}k`);
/** What the gap between two profiles is worth in margin points, by the measurements. */
export const profileGapPoints = (weak, strong) => (profileElo(strong) - profileElo(weak)) * handicapPerElo;
/** Elo of any profile from 20 kyu to 9 dan, on straight lines between the fitted knots. */
function profileElo(kyu) {
  const upper = measuredKyus.findLast((measured) => measured >= kyu);
  const lower = measuredKyus.find((measured) => measured <= kyu);
  if (upper === lower) return measuredElo[upper];
  return measuredElo[upper] + (measuredElo[lower] - measuredElo[upper]) * (upper - kyu) / (upper - lower);
}

/**
 * The fixed point of the scale, as in nine: KataGo's 5 kyu bot is 5 kyu here, where the human model has
 * plenty of games to learn from. Every other rank is placed from it by the OGS scale, so steps are even.
 */
const anchorKyu = 5;
/** A profile's rating on the OGS scale. */
const profileRating = (kyu) => eloOfKyu(anchorKyu) + profileElo(kyu) - profileElo(anchorKyu);
export const kyuOfElo = (elo) => 30 - 23.15 * Math.log(elo / 525);
/** The profiles from 20 kyu to 3 dan: ranks stop at 1 dan, which on 13 × 13 takes a profile above rank_1d. */
const profiles = Array.from({ length: 23 }, (_, index) => 20 - index);
/** The weakest bot's rank; weaker players get a handicap from it. */
export const botFloorKyu = Math.round(kyuOfElo(profileRating(profiles[0])));
/** The strongest rank is 1 dan, or lower if the strongest profile would fall short of it by over half a step. */
const topKyu = 0;
export const strongestKyu = (() => {
  const top = profileRating(profiles.at(-1));
  let kyu = botFloorKyu;
  while (kyu > topKyu && eloOfKyu(kyu - 1) - top <= (eloOfKyu(kyu - 1) - eloOfKyu(kyu)) / 2) kyu--;
  return kyu;
})();
/** A win takes the rank one step up, a loss one step down; down there is no floor. */
export const nextKyu = (kyu, won) => Math.max(strongestKyu, kyu + (won ? -1 : 1));

/** The profile whose measured strength is closest to the rank on the OGS scale; the weakest bot below it. */
export function botFor(kyu) {
  const target = eloOfKyu(Math.min(kyu, botFloorKyu));
  let best = profiles[0];
  for (const profile of profiles) {
    if (Math.abs(profileRating(profile) - target) < Math.abs(profileRating(best) - target)) best = profile;
  }
  return profileName(best);
}

const columns = 'ABCDEFGHJKLMNOPQRST';
export const gtpOf = (point, size = boardSize) => (point === null ? 'pass' : columns[point % size] + (size - Math.floor(point / size)));
const pointOf = (gtp, size = boardSize) => (size - Number(gtp.slice(1))) * size + columns.indexOf(gtp[0]);

/**
 * Black's handicap stones on 13 × 13 as they are usually set: the corners first, the center on odd counts
 * from five, the middles of the sides from six.
 */
const corners = ['K10', 'D4', 'K4', 'D10'];
const handicapSets = {
  2: corners.slice(0, 2),
  3: corners.slice(0, 3),
  4: corners,
  5: [...corners, 'G7'],
  6: [...corners, 'D7', 'K7'],
  7: [...corners, 'D7', 'K7', 'G7'],
  8: [...corners, 'D7', 'K7', 'G10', 'G4'],
  9: [...corners, 'D7', 'K7', 'G10', 'G4', 'G7'],
};
export const maxHandicap = 9;
export const handicapStones = (count) => (handicapSets[count] ?? []).map((gtp) => pointOf(gtp));

/**
 * KataGo's lead for black with that many handicap stones, no komi, white to move; 0 is the even game
 * (calibration/stones.json). Between bots two and three stones hold up; a fourth gave the weaker bot far
 * less than KataGo's lead says (calibration/check-20-12-*.json), so bot-against-bot checks use at most three.
 */
const stoneLead = { 0: 6.4, 2: 19.1, 3: 31.4, 4: 47.1, 5: 57.5, 6: 72.1, 7: 81.7, 8: 94.9, 9: 102.4 };
const botStoneCounts = [0, 2, 3];
/** One more stone is worth about 12 points (from 2 to 9 stones by KataGo's lead). */
const stonePoints = 12;
const halfPoint = (value) => Math.round(value - 0.5) + 0.5;
/** How far a komi is from the usual 0.5 to 6.5. */
const unusual = (komi) => Math.max(0, 0.5 - komi, komi - evenKomi);

/**
 * The game for a rank: even with komi 6.5 from the weakest bot up. Below it the usual handicap ladder, a
 * stone for every rank: one rank weaker is black with komi 0.5, two ranks two stones, up to nine stones
 * with komi 0.5. Past nine stones each rank is a stone's worth, 12 points, more komi to black.
 */
export function handicapFor(kyu) {
  const ranks = kyu - botFloorKyu;
  if (ranks <= 0) return { stones: 0, komi: evenKomi };
  const stones = ranks === 1 ? 0 : Math.min(maxHandicap, ranks);
  return { stones, komi: 0.5 - Math.max(0, ranks - maxHandicap) * stonePoints };
}
/** Stones and komi worth `points` for black over the even game, as bot-against-bot checks give it. */
export function handicapOf(points) {
  if (!points) return { stones: 0, komi: evenKomi };
  const options = botStoneCounts.map((stones) => ({ stones, komi: halfPoint(stoneLead[stones] - stoneLead[0] + evenKomi - points) }));
  return options.reduce((best, option) => (unusual(option.komi) < unusual(best.komi) ? option : best));
}

/** The game as KataGo's analysis engine reads it: handicap stones, komi, every move including passes. */
export function enginePosition({ stones = [], komi, moves }) {
  const first = stones.length ? 1 : 0;
  return {
    rules: 'japanese',
    komi,
    boardXSize: boardSize,
    boardYSize: boardSize,
    initialStones: stones.map((point) => ['B', gtpOf(point)]),
    initialPlayer: first ? 'W' : 'B',
    moves: moves.map((point, index) => [(index + first) % 2 ? 'W' : 'B', gtpOf(point)]),
  };
}

/** Sample a legal point from the human policy by its probabilities. */
export function pickHumanMove(policy, position, random = Math.random) {
  const { size } = position;
  const legal = [];
  for (let point = 0; point < size * size; point++) {
    if (policy[point] > 0 && isLegal(position, point)) legal.push(point);
  }
  if (!legal.length) return null;
  let left = random() * legal.reduce((sum, point) => sum + policy[point], 0);
  for (const point of legal) {
    left -= policy[point];
    if (left <= 0) return point;
  }
  return legal.at(-1);
}

/** The bot's move, `null` for a pass: it plays like a person of `profile` and passes when KataGo itself would. */
export async function chooseBotMove(engine, game, position, profile) {
  const answer = await engine.query({
    ...enginePosition(game),
    maxVisits: 64,
    includePolicy: true,
    overrideSettings: { humanSLProfile: profile, ignorePreRootHistory: false },
  });
  if (answer.moveInfos?.[0]?.move === 'pass') return null;
  return pickHumanMove(answer.humanPolicy, position);
}

/** Who owns each point at the end, from -1 (white) to 1 (black), after a search deep enough to settle dead stones. */
export async function finalOwnership(engine, game) {
  const answer = await engine.query({ ...enginePosition(game), maxVisits: 400, includeOwnership: true });
  return answer.ownership;
}

/** KataGo's analysis engine over the backend: one JSON line out, one JSON line back per query. */
export class KataGo {
  #pending = new Map();
  #next = 0;
  constructor(backend) {
    this.backend = backend;
    backend.onEngineLine((line) => this.#receive(line));
    backend.onEngineStop((message) => this.#fail(message));
  }
  #fail(message) {
    for (const entry of this.#pending.values()) entry.reject(new Error(message));
    this.#pending.clear();
  }
  #receive(line) {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    const entry = this.#pending.get(value.id);
    if (!entry || value.warning) return;
    this.#pending.delete(value.id);
    if (value.error) entry.reject(new Error(`KataGo: ${value.error}`));
    else entry.resolve(value);
  }
  query(fields) {
    const id = `q${++this.#next}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.backend.sendToEngine(JSON.stringify({ id, ...fields })).catch((error) => {
        this.#pending.delete(id);
        reject(error);
      });
    });
  }
}
