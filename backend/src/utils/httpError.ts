/**
 * HTTP 错误类，用于业务层抛出带状态码的异常
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
