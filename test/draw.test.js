import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCycle, findDraw, canGive } from '../src/worker.js';

const families = [
  ['Dexter', 'Reyann', 'Holly'], ['Grizel', 'Isaiah', 'David'], ['Marielle', 'Xayvion'],
  ['Nikki', 'Vickie', 'Franklin'], ['Andra', 'Cynthia', 'Dianne'], ['Larry', 'Alison'], ['Mikhail', 'Hannah'],
];
const people = families.flatMap((f, h) => f.map((name) => ({ id: name, name, household: `h${h}` })));

test('everyone gives once, receives once, never to self or own household', () => {
  for (let run = 0; run < 500; run++) {
    const c = findCycle(people);
    assert.ok(c, 'found a draw');
    assert.equal(c.length, people.length);
    assert.equal(new Set(c.map((p) => p.id)).size, people.length);
    c.forEach((p, i) => assert.ok(canGive(p, c[(i + 1) % c.length])));
  }
});

test('reports impossible draws instead of cheating', () => {
  const two = [{ id: 1, household: 'a' }, { id: 2, household: 'a' }, { id: 3, household: 'b' }];
  assert.equal(findCycle(two), null);
});

test('small groups without households work', () => {
  const c = findCycle([{ id: 1, household: '' }, { id: 2, household: '' }, { id: 3, household: '' }]);
  assert.equal(c.length, 3);
});

test('someone in two households is blocked from both', () => {
  const ppl = [
    { id: 'Holly', household: 'Dexter, Reyann and Holly + Holly and Pamela' },
    { id: 'Dexter', household: 'Dexter, Reyann and Holly' },
    { id: 'Pamela', household: 'Holly and Pamela' },
    { id: 'Larry', household: '' }, { id: 'Andra', household: '' }, { id: 'Grizel', household: '' },
  ];
  const by = Object.fromEntries(ppl.map((p) => [p.id, p]));
  assert.equal(canGive(by.Holly, by.Pamela), false);
  assert.equal(canGive(by.Pamela, by.Holly), false);
  assert.equal(canGive(by.Holly, by.Dexter), false);
  assert.equal(canGive(by.Pamela, by.Dexter), true);
  for (let i = 0; i < 200; i++) {
    const c = findCycle(ppl);
    c.forEach((p, j) => assert.ok(canGive(p, c[(j + 1) % c.length])));
  }
});

test('small groups where one big loop is impossible still get a fair draw', () => {
  const ppl = [
    { id: 'Holly', household: 'H' }, { id: 'Pamela', household: 'H' }, { id: 'Dexter', household: 'H' },
    { id: 'Larry', household: 'L' }, { id: 'Andra', household: 'A' },
  ];
  // Holly/Pamela/Dexter can only give to Larry or Andra, so no fair draw exists at all:
  assert.equal(findDraw(ppl), null);
  const four = [{ id: 'Holly', household: 'x + y' }, { id: 'Pamela', household: 'y' }, { id: 'Dexter', household: 'x' }, { id: 'Larry', household: '' }];
  assert.equal(findCycle(four), null);
  for (let i = 0; i < 200; i++) {
    const pairs = findDraw(four);
    assert.ok(pairs);
    assert.equal(new Set(pairs.map(([g]) => g.id)).size, 4);
    assert.equal(new Set(pairs.map(([, r]) => r.id)).size, 4);
    pairs.forEach(([g, r]) => assert.ok(canGive(g, r)));
  }
});
