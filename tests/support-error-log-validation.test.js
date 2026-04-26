const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAndNormalizeErrorLogPayload } = require('../src/modules/support/errorLogValidation');

test('rejects invalid metadata type', () => {
  const result = validateAndNormalizeErrorLogPayload({
    errorType: 'runtime',
    message: 'something failed',
    metadata: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_metadata');
});

test('rejects oversized metadata payload', () => {
  const result = validateAndNormalizeErrorLogPayload({
    errorType: 'runtime',
    message: 'something failed',
    metadata: { payload: 'x'.repeat(10050) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'metadata_too_large');
});

test('normalizes valid payload', () => {
  const result = validateAndNormalizeErrorLogPayload({
    errorType: 'runtime_error',
    message: 'error message',
    stack: 'stacktrace',
    url: '/home',
    metadata: { page: 'home' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.errorType, 'runtime_error');
  assert.equal(result.data.message, 'error message');
});
