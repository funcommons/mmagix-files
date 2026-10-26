/**
 * 失败形态：reply ok=false 的 code（§七）或本地超时 4004 / 队列 4303 / 不可用 4005 / 终态 5000。
 */

export class MmxError extends Error {
  code: number;
  detail?: unknown;

  constructor(code: number, message: string, detail?: unknown) {
    super(message);
    this.name = "MmxError";
    this.code = code;
    this.detail = detail;
  }
}
