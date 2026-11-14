import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readRequestBody } from '../.test-build/request-body.js';

test('split UTF-8 messages retain Chinese text and emoji', async () => {
  const message = JSON.stringify({ text: '确认计划，加入瓶身图纸 🧊' });
  const bytes = Buffer.from(message);
  const request = new PassThrough();
  const result = readRequestBody(request);
  for (const byte of bytes) request.write(Buffer.from([byte]));
  request.end();
  assert.equal(await result, message);
});

test('oversized requests cannot apply a valid but incomplete JSON prefix', async () => {
  const request = new PassThrough();
  const rejected = assert.rejects(readRequestBody(request, 16), /Request too large/);
  request.write('{"approve":true}');
  request.end(' '.repeat(32));
  await rejected;
});

test('interrupted requests reject instead of returning partial input', async () => {
  const request = new PassThrough();
  const rejected = assert.rejects(readRequestBody(request), /Request interrupted/);
  request.write('{"text":');
  request.emit('aborted');
  request.end();
  await rejected;
});
