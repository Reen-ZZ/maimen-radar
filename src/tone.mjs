/**
 * 麦门语气层。
 *
 * 梗的规则：重复是梗的生命，但用错场合就是欠揍。所以收尾语按情境分档，
 * 坏消息一律不喊口号 —— 券刚作废的人看见「麦门永存！」只会想卸载。
 */

const CLOSERS = {
  welcome: '欢迎入教。麦门永存！',
  neutral: '麦门永存！',
  saved: '省到就是赚到。麦门永存！',
  rescue: '麦门弟子，不浪费一张券。',
  lost: '这张没了。麦门永存，下一张见。',
  silent: null,
};

/**
 * 选收尾语。
 * @param {'welcome'|'neutral'|'saved'|'rescue'|'lost'|'error'} kind
 */
export function closer(kind) {
  return CLOSERS[kind] ?? CLOSERS.neutral;
}

/**
 * 一句俏皮话，按情境挑，最多用一处。
 * 调侃方向只朝自己（嘴馋、忘用券），不朝品牌；不碰食量与健康。
 */
const BANTER = {
  sunday_lock: '今天周日，这两张在装死。',
  due_today: '今天不用，今晚 23:59 它就走了。',
  all_good: '券的状态比你的日程表还规矩。',
  empty: '券包空空，等于没白拿。',
  points_burn: '积分这东西，放着放着就熟了，熟了就没。',
};
export const banter = (key) => BANTER[key] ?? '';

/** 把收尾语接到渲染结果末尾；kind=silent/error 时原样返回 */
export function withCloser(text, kind) {
  const c = closer(kind);
  return c ? `${text}\n\n${c}` : text;
}
