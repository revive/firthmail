/**
 * 让"慢来的答复"失效：读一封信的正文可能要走服务器，用户等不及就会点下一封。
 *
 * 每次请求先 `start()` 拿一个令牌，回来时用 `current(token)` 问一下——中途又
 * 有请求发出（点到了别的信），这一份就该丢掉，否则界面会显示上一封信的正文。
 */
export class RequestGate {
  private token = 0;

  /** 开始一次新请求，返回它的令牌。 */
  start(): number {
    this.token += 1;
    return this.token;
  }

  /** 这个令牌还是最新的一次请求吗。 */
  current(token: number): boolean {
    return token === this.token;
  }
}
