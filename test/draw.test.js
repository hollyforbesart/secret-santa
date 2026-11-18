import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCycle, canGive } from '../src/worker.js';

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
