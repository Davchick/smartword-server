/**
 * Standardized error handler middleware.
 * Prevents information leakage through error messages.
 */

/**
 * Custom error class for application errors
 */
class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error types that should return generic messages
 */
const ERROR_TYPE_MAP = {
  // Auth errors - generic message to prevent enumeration
  'AUTH_FAILED': 'Authentication failed',
  'INVALID_TOKEN': 'Invalid or expired token',
  'TOKEN_EXPIRED': 'Invalid or expired token',
  'USER_NOT_FOUND': 'Authentication failed',

  // Validation errors - generic message
  'VALIDATION_ERROR': 'Invalid request data',
  'INVALID_INPUT': 'Invalid request data',

  // Permission errors
  'FORBIDDEN': 'Access denied',
  'INSUFFICIENT_PERMISSIONS': 'Access denied',

  // Rate limiting
  'RATE_LIMIT_EXCEEDED': 'Too many requests. Please try again later.',

  // Not found - generic to prevent resource enumeration
  'NOT_FOUND': 'Resource not found',

  // Conflict
  'CONFLICT': 'Resource already exists',

  // Internal errors - never expose details
  'INTERNAL_ERROR': 'An unexpected error occurred',
  'DATABASE_ERROR': 'A database error occurred',
};

/**
 * Create authentication error (generic message)
 */
function createAuthError(message = 'Authentication failed') {
  return new AppError(message, 401, 'AUTH_FAILED');
}

/**
 * Create forbidden error
 */
function createForbiddenError(message = 'Access denied') {
  return new AppError(message, 403, 'FORBIDDEN');
}

/**
 * Create not found error (generic message)
 */
function createNotFoundError(message = 'Resource not found') {
  return new AppError(message, 404, 'NOT_FOUND');
}

/**
 * Create validation error
 */
function createValidationError(message = 'Invalid request data') {
  return new AppError(message, 400, 'VALIDATION_ERROR');
}

/**
 * Express error handler middleware
 */
function errorHandler(err, req, res, next) {
  // Log full error for debugging (server-side only)
  console.error('[ErrorHandler]', err);
  
  // If it's our AppError, use predefined mapping
  if (err instanceof AppError) {
    const message = ERROR_TYPE_MAP[err.code] || err.message;
    return res.status(err.statusCode).json({
      error: message,
      code: err.code,
    });
  }
  
  // Handle Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    return res.status(400).json({
      error: 'A database error occurred',
      code: 'DATABASE_ERROR',
    });
  }
  
  // Handle JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN',
    });
  }
  
  // Handle syntax errors (JSON parse, etc.)
  if (err instanceof SyntaxError) {
    return res.status(400).json({
      error: 'Invalid request format',
      code: 'INVALID_INPUT',
    });
  }
  
  // Default: internal server error (never expose details)
  const isDev = process.env.NODE_ENV === 'development';
  return res.status(500).json({
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
    ...(isDev ? { details: err.message } : {}), // Only show details in dev
  });
}

/**
 * 404 handler for unknown routes
 */
function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
  });
}

module.exports = {
  AppError,
  createAuthError,
  createForbiddenError,
  createNotFoundError,
  createValidationError,
  errorHandler,
  notFoundHandler,
};
