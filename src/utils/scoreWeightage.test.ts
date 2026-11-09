import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_MAY_EDIT_SCORE_WEIGHTAGE,
  bonusPct,
  calcFinalScore,
  calcIndividualPoints,
  calcTeamPoints,
  formatPct,
  weightsTotalOk,
  monthStartIso,
} from './scoreWeightage.ts';

describe('bonusPct', () => {
  it('94 → 14%', () => {
    assert.equal(bonusPct(94), 14);
  });

  it('89.9 → 0%', () => {
    assert.equal(bonusPct(89.9), 0);
  });

  it('90 → 10%', () => {
    assert.equal(bonusPct(90), 10);
  });

  it('100 → 20%', () => {
    assert.equal(bonusPct(100), 20);
  });

  it('>100 → 20% capped', () => {
    assert.equal(bonusPct(105), 20);
    assert.equal(bonusPct(100.5), 20);
  });

  it('94.5 → 14.5% (linear between whole points)', () => {
    assert.equal(bonusPct(94.5), 14.5);
  });

  it('null / non-finite → 0', () => {
    assert.equal(bonusPct(null), 0);
    assert.equal(bonusPct(undefined), 0);
    assert.equal(bonusPct(Number.NaN), 0);
  });

  it('89.9 still earns 0%', () => {
    assert.equal(bonusPct(89.9), 0);
  });
});

describe('calcFinalScore', () => {
  it('95 × 80 = 76, 90 × 20 = 18, 76 + 18 = 94', () => {
    assert.equal(calcIndividualPoints(95, 80), 76);
    assert.equal(calcTeamPoints(90, 20), 18);
    assert.equal(calcFinalScore(95, 90, 80, 20), 94);
  });

  it('rounds each side to 1 decimal, then adds, including 89.96', () => {
    const cases = [
      [60, 40, 80, 20],
      [0, 20, 80, 20],
      [7, 2.33, 80, 20],
      [40, 20, 80, 20],
      [9, 3, 80, 20],
      [89.96, 89.96, 80, 20],
    ];
    for (const [kpi, avg, individual, team] of cases) {
      const points = calcIndividualPoints(kpi, individual);
      const teamPoints = calcTeamPoints(avg, team);
      const score = calcFinalScore(kpi, avg, individual, team);
      assert.equal(score, points + teamPoints);
    }
    assert.equal(calcIndividualPoints(89.96, 80), 72);
    assert.equal(calcTeamPoints(89.96, 20), 18);
    assert.equal(calcFinalScore(89.96, 89.96, 80, 20), 90);
    assert.equal(bonusPct(90), 10);
    assert.equal(calcIndividualPoints(0, 80), 0);
    assert.equal(calcTeamPoints(20, 20), 4);
    assert.equal(calcFinalScore(0, 20, 80, 20), 4);
  });
});

describe('admin edit switch', () => {
  it('admin_may_edit_score_weightage stays off', () => {
    assert.equal(ADMIN_MAY_EDIT_SCORE_WEIGHTAGE, false);
  });
});

describe('weightsTotalOk', () => {
  it('requires 0 to 100, one decimal, and an exact total of 100', () => {
    assert.equal(weightsTotalOk(80, 20), true);
    assert.equal(weightsTotalOk(75.5, 24.5), true);
    assert.equal(weightsTotalOk(79, 20), false);
    assert.equal(weightsTotalOk(80.5, 19.6), false);
    assert.equal(weightsTotalOk(-10, 110), false);
    assert.equal(weightsTotalOk(101, -1), false);
    assert.equal(weightsTotalOk(80.55, 19.45), false);
  });
});

describe('formatPct', () => {
  it('shows bonus to 1 decimal', () => {
    assert.equal(formatPct(10), '10.0%');
    assert.equal(formatPct(14.5), '14.5%');
    assert.equal(formatPct(0), '0.0%');
  });
});

describe('monthStartIso', () => {
  it('formats year + 0-based month index', () => {
    assert.equal(monthStartIso(2026, 9), '2026-10-01');
  });
});
