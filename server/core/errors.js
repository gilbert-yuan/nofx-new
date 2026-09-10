/** 统一错误类型与路由异步包装，避免每个 handler 重复 try/catch */

export class ApiError extends Error {
  /** @param {string} message @param {number} [status=500] */
  constructor(message, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 把 async handler 包成 express 能接住的 (req,res,next) */
export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
