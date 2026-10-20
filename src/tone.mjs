/**
 * 麦门语气层。
 *
 * 2026-10-20 决策：推翻原来的「坏消息一律不喊口号」分档，全程高浓度。
 * 但"高浓度"落地成什么句式有讲究——坏消息喊「麦门永存！」是欠揍，因为那是在替品牌表态，
 * 而用户此刻损失了一张券。所以坏消息改走**殉葬式**：麦门腔还在，只是立场从"品牌"转到"陪你的人"。
 *   好消息：「省到就是赚到。麦门永存！」——一起高兴
 *   坏消息：「这张没了。麦门永存，下一张见。」——替它记着，不劝你开心
 * 唯一的 silent 档留给技术故障（401 / 接口异常 / 无数据）：那时候用户要的是解法，不是性格。
 *
 * 另两条老规矩不变：调侃只朝自己（嘴馋、忘用券），不朝品牌；不碰食量与健康。
 */

const CLOSERS = {
  welcome: '欢迎入教。麦门永存！',
  neutral: '麦门永存！',
  saved: '省到就是赚到。麦门永存！',
  rescue: '麦门弟子，不浪费一张券。',
  lost: '这张没了。麦门永存，下一张见。',
  burned: '分没了。麦门替你记着这一刀。',
  mourn: '这次不喊口号。麦门永存，是替它存的。',
  silent: null,
};

/**
 * 选收尾语。
 * @param {'welcome'|'neutral'|'saved'|'rescue'|'lost'|'burned'|'mourn'|'error'|'silent'} kind
 */
export function closer(kind) {
  return CLOSERS[kind] ?? CLOSERS.neutral;
}

/** 把收尾语接到渲染结果末尾；kind=silent/error 时原样返回 */
export function withCloser(text, kind) {
  const c = closer(kind);
  return c ? `${text}\n\n${c}` : text;
}

/**
 * 俏皮话库。key 是调用方显式点名的句式，CAT_ 是按品类自动挑的句式。
 * 品类句式一次给两到三条，由 quip() 按「券键 + 当天日期」稳定取一条——
 * 同一天同一张券永远同一句（可复现、可测试），隔天自动换，转发出去不会天天看到同一句。
 */
const BANTER = {
  sunday_lock: '今天周日，这两张在装死。',
  due_today: '今天不用，今晚 23:59 它就走了。',
  all_good: '券的状态比你的日程表还规矩。',
  empty: '券包空空，等于没白拿。',
  points_burn: '积分这东西，放着放着就熟了，熟了就没。',
  // 用户亲自批的两条句式：产品名双关 + 表态，只表态、不索取
  full_score: '在麦当劳你永远可以拿满分（指麦满分）。',
  golden_year: '祝你今年金拱门。',
  // 发群版专用
  hero_pick: '麦门弟子今晚的去处，就这一张。',
  all_dead: '今晚全灭。麦门替你记着这一刀。',
  locked_today: '今天它不陪你。',
  locked_window: '它没坏，只是还没到点。',
  gift_now: '今日作废。能救，转赠。',
  now_plain: '现在就能刷。',
  band_note: '图为麦当劳官方素材，图内文字与价格以官方图为准；麦门雷达只判到店自取，外送相关结论请回麦当劳 App。',
};

/** 品类句式表：正则按券名/商品名命中，顺序即优先级（先具体后宽泛） */
const CAT_QUIPS = [
  [/麦咖啡|美式|拿铁|卡布|咖啡/, [
    '冰美式这东西，苦得很有分寸。',
    '这一杯是给下午续命的。',
    '咖啡因到账，会能开了。',
  ]],
  [/麦旋风|圆筒|新地|圣代|冰淇淋/, [
    '甜品是正事之间的那个逗号。',
    '麦旋风需要一个理由，这就是理由。',
    '今天这份凉的是应得的。',
  ]],
  [/香芋派|菠萝派|^派|任选1份派|派\//, [
    '一个派，换十分钟不看手机。',
    '派这种东西，趁热吃是它唯一的正确吃法。',
  ]],
  [/薯饼/, [
    '薯饼是早餐里最被低估的一张牌。',
    '早上吃薯饼，不算熬夜。',
  ]],
  [/薯条/, [
    '薯条凉之前，一切都还来得及。',
    '薯条这东西，趁热就是正义。',
  ]],
  [/麦乐鸡|鸡翅|王牌|炸鸡|任选/, [
    '任选 2 个，说明你今天还有余地。',
    '炸鸡的浪漫在于它不给你选择困难。',
    '麦乐鸡蘸酱，是成年人的小确幸。',
  ]],
  [/麦辣|鸡腿堡|汉堡|板烧|巨无霸|双层|吉士|龙焰/, [
    '麦门的基本盘，就是这个堡。',
    '这个堡值得专门为它出一次门。',
    '汉堡不会骗人：热的时候最好吃。',
  ]],
  [/鱼|虾|凤梨/, [
    '限定这东西，错过就得等明年。',
    '新口味来了，旧的还等着翻牌。',
  ]],
];

const hash = (s) => [...String(s)].reduce((a, ch) => a + ch.codePointAt(0), 0);

/**
 * 按券挑一句俏皮话。状态优先于品类——坏消息先说清楚，再谈风花雪月。
 * @param {object} c buildModel 的 coupon
 * @param {Date} [now] 用于「隔天换一句」的稳定种子
 */
export function quip(c, now = new Date()) {
  if (!c) return '';
  if (c.reasons?.[0]) return c.reasons[0];
  if (c.state === 'locked') return c.wins?.length ? BANTER.locked_window : BANTER.locked_today;
  if (c.state === 'gift') return BANTER.gift_now;
  if (c.dueTodayTag) return BANTER.due_today;
  const text = `${c.displayTitle ?? ''} ${c.title ?? ''} ${c.ladderProduct?.name ?? ''}`;
  const hit = CAT_QUIPS.find(([re]) => re.test(text));
  if (hit) return hit[1][(hash(c.key ?? text) + now.getDate()) % hit[1].length];
  return BANTER.now_plain;
}

/** 显式取一条已登记的句式（渲染器点名要某句时用） */
export const banter = (key) => BANTER[key] ?? '';
