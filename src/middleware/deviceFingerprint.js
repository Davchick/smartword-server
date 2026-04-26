const crypto = require('crypto');

function generateDeviceFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const secChUa = req.headers['sec-ch-ua'] || '';
  const secChUaPlatform = req.headers['sec-ch-ua-platform'] || '';
  const fingerprintSource = `${userAgent}|${acceptLanguage}|${secChUa}|${secChUaPlatform}`;
  return crypto.createHash('sha256').update(fingerprintSource).digest('hex');
}

function deviceFingerprintMiddleware(req, _res, next) {
  req.deviceFingerprint = generateDeviceFingerprint(req);
  next();
}

module.exports = {
  generateDeviceFingerprint,
  deviceFingerprintMiddleware,
};
