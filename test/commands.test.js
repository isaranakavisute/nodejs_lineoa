import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { parseCommand } = await import('../src/handlers.js');

test('parses commands with and without arguments', () => {
  assert.deepEqual(parseCommand('/lang Japanese'), { name: 'lang', arg: 'Japanese' });
  assert.deepEqual(parseCommand('  /LANG  '), { name: 'lang', arg: '' });
  assert.deepEqual(parseCommand('/help'), { name: 'help', arg: '' });
});

test('ordinary text is not a command', () => {
  assert.equal(parseCommand('hello /lang'), null);
  assert.equal(parseCommand('สวัสดีครับ'), null);
});
