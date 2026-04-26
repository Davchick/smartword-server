function validateAndNormalizeErrorLogPayload(body) {
  const { errorType, message, stack, url, metadata } = body || {};

  if (!errorType || typeof errorType !== 'string') {
    return { ok: false, error: 'invalid_error_type' };
  }

  if (!message || typeof message !== 'string') {
    return { ok: false, error: 'invalid_message' };
  }

  if (metadata !== undefined && (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object')) {
    return { ok: false, error: 'invalid_metadata' };
  }

  const serializedMetadata = metadata ? JSON.stringify(metadata) : null;
  if (serializedMetadata && serializedMetadata.length > 10_000) {
    return { ok: false, error: 'metadata_too_large' };
  }

  return {
    ok: true,
    data: {
      errorType: errorType.slice(0, 100),
      message: message.slice(0, 2000),
      stack: typeof stack === 'string' ? stack.slice(0, 5000) : null,
      url: typeof url === 'string' ? url.slice(0, 500) : null,
      metadata: metadata || null,
    },
  };
}

module.exports = {
  validateAndNormalizeErrorLogPayload,
};
