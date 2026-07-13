import assert from 'node:assert/strict';
import { RecorderUiEventBuffer } from '../src/recorder/ui-event-buffer';
import { RecorderUiEvent } from '../src/recorder/protocol';

function event(recordId: string, payload: string, structural: boolean): RecorderUiEvent {
  return { recordId, payload, structural };
}

const snapshots = new RecorderUiEventBuffer();
snapshots.push(event('a', 'a-1', false));
snapshots.push(event('a', 'a-2', false));
assert.equal(snapshots.shift()?.payload, 'a-2');
assert.equal(snapshots.empty, true);

const completed = new RecorderUiEventBuffer();
completed.push(event('a', 'a-stream', false));
completed.push(event('a', 'a-done', true));
assert.equal(completed.shift()?.payload, 'a-done');
assert.equal(completed.empty, true);

const structuralOrder = new RecorderUiEventBuffer();
structuralOrder.push(event('a', 'a-start', true));
structuralOrder.push(event('b', 'b-done', true));
structuralOrder.push(event('c', 'c-1', false));
structuralOrder.push(event('c', 'c-2', false));
assert.deepEqual(
  [structuralOrder.shift()?.payload, structuralOrder.shift()?.payload, structuralOrder.shift()?.payload],
  ['a-start', 'b-done', 'c-2'],
);
assert.equal(structuralOrder.empty, true);

console.log('ui event buffer tests passed');
