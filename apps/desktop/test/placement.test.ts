import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restorePlacement } from '../src/placement.ts';

const laptop = { x: 0, y: 0, width: 1536, height: 816 };       // work area, taskbar excluded
const rightMonitor = { x: 1536, y: 0, width: 1920, height: 1040 };

test('first launch: a default-sized window, centred on the primary display', () => {
  assert.deepEqual(restorePlacement(null, [laptop]), { x: 168, y: 48, width: 1200, height: 720, maximized: false });
});

test('a saved window on a connected display comes back exactly where it was', () => {
  const saved = { x: 1700, y: 100, width: 1280, height: 800, maximized: true };
  assert.deepEqual(restorePlacement(saved, [laptop, rightMonitor]), saved);
});

test('a window saved on a monitor that is gone comes back centred on the primary display', () => {
  const saved = { x: 1700, y: 100, width: 1280, height: 800, maximized: false };
  assert.deepEqual(restorePlacement(saved, [laptop]), { x: 128, y: 8, width: 1280, height: 800, maximized: false });
});

test('a window bigger than the display shrinks to fit it', () => {
  const saved = { x: 0, y: 0, width: 2560, height: 1400, maximized: false };
  assert.deepEqual(restorePlacement(saved, [laptop]), { x: 0, y: 0, width: 1536, height: 816, maximized: false });
});

test('a window mostly off the edge is pulled back so its top bar can be grabbed', () => {
  const saved = { x: 1400, y: -300, width: 1000, height: 700, maximized: false };
  assert.deepEqual(restorePlacement(saved, [laptop]), { x: 536, y: 0, width: 1000, height: 700, maximized: false });
});

test('a garbled saved placement is ignored', () => {
  const garbled = { x: Number.NaN, y: 0, width: -5, height: 700, maximized: false };
  assert.deepEqual(restorePlacement(garbled, [laptop]), { x: 168, y: 48, width: 1200, height: 720, maximized: false });
});
